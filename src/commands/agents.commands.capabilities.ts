import fs from "node:fs";
import path from "node:path";
import { resolvePrimaryStringValue } from "@openclaw/normalization-core/string-coerce";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import {
  buildFleetCapabilityContract,
  type CapabilityCheck,
  type CapabilityStatus,
  type FleetCapabilityContract,
  type FleetServiceInput,
  type ProfileCapabilityInput,
} from "../agents/fleet-capability-contract.js";
import { renderFleetCapabilityMarkdown } from "../agents/fleet-capability-contract.markdown.js";
import { resolveProviderIdForAuth } from "../agents/provider-auth-aliases.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronStorePath } from "../cron/store.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { resolveProviderAuthEnvVarCandidates } from "../secrets/provider-env-vars.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { resolveConfigDir } from "../utils.js";
import { requireValidConfig } from "./agents.command-shared.js";
import { listAgentEntries } from "./agents.config.js";

export type AgentsCapabilitiesOptions = {
  json?: boolean;
  markdown?: boolean;
  agent?: string;
};

const STATUS_ICON: Record<CapabilityStatus, string> = {
  green: "[OK]",
  yellow: "[WARN]",
  red: "[FAIL]",
};

/** Derive a provider id from a model string prefix (e.g. "anthropic/claude" -> "anthropic"). */
function deriveProvider(model: string | undefined): string | undefined {
  if (!model) {
    return undefined;
  }
  const trimmed = model.trim();
  if (!trimmed) {
    return undefined;
  }
  const slash = trimmed.indexOf("/");
  const colon = trimmed.indexOf(":");
  const sep = slash === -1 ? colon : colon === -1 ? slash : Math.min(slash, colon);
  if (sep <= 0) {
    return undefined;
  }
  return trimmed.slice(0, sep).trim().toLowerCase() || undefined;
}

/** True when the named env var is set to a non-empty value. Never reads the value out. */
function envVarPresent(name: string, env: NodeJS.ProcessEnv): boolean {
  const value = env[name];
  return typeof value === "string" && value.trim().length > 0;
}

function makeProviderCredentialProbe(env: NodeJS.ProcessEnv): (provider?: string) => boolean {
  const candidates = resolveProviderAuthEnvVarCandidates();
  return (provider?: string): boolean => {
    if (!provider) {
      return false;
    }
    const canonical = resolveProviderIdForAuth(provider);
    const names = candidates[canonical] ?? candidates[provider] ?? [];
    return names.some((name) => envVarPresent(name, env));
  };
}

/** Best-effort PATH scan for an executable. Read-only; never executes it. */
function isOnPath(bin: string, env: NodeJS.ProcessEnv): boolean {
  const pathVar = env.PATH ?? env.Path ?? "";
  if (!pathVar) {
    return false;
  }
  const isWin = process.platform === "win32";
  const exts = isWin
    ? [
        "",
        ...(env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .map((e) => e.trim())
          .filter(Boolean),
      ]
    : [""];
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    for (const ext of exts) {
      const candidate = path.join(dir, `${bin}${ext}`);
      try {
        if (fs.existsSync(candidate)) {
          return true;
        }
      } catch {
        // best-effort: ignore unreadable PATH entries
      }
    }
  }
  return false;
}

function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function gatherServiceInput(env: NodeJS.ProcessEnv): FleetServiceInput {
  let stateDbPresent = false;
  try {
    stateDbPresent = fileExists(resolveOpenClawStateSqlitePath(env));
  } catch {
    stateDbPresent = false;
  }

  let cronStorePresent = false;
  try {
    cronStorePresent =
      fileExists(resolveCronStorePath()) || fileExists(path.join(resolveConfigDir(env), "cron"));
  } catch {
    cronStorePresent = false;
  }

  return {
    gatewayConfigured: false, // filled in by caller (needs cfg)
    stateDbPresent,
    cronStorePresent,
    githubCliPresent: isOnPath("gh", env),
    githubAuthPresent: envVarPresent("GH_TOKEN", env) || envVarPresent("GITHUB_TOKEN", env),
    linearAuthPresent: envVarPresent("LINEAR_API_KEY", env),
    deliveryBridgePresent: isOnPath("rclone", env),
  };
}

function gatherProfileInputs(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  filterAgentId?: string,
): ProfileCapabilityInput[] {
  const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(cfg));
  const credsPresent = makeProviderCredentialProbe(env);
  const defaultModel = resolvePrimaryStringValue(cfg.agents?.defaults?.model);
  const entries = listAgentEntries(cfg);
  const wanted = filterAgentId ? normalizeAgentId(filterAgentId) : undefined;

  const source = entries.length > 0 ? entries : [{ id: defaultAgentId }];

  return source
    .map((entry): ProfileCapabilityInput => {
      const agentId = normalizeAgentId(entry.id);
      const model = resolvePrimaryStringValue(entry.model) ?? defaultModel;
      const provider = deriveProvider(model);
      const tools = entry.tools;
      const allow = tools?.allow ?? [];
      const alsoAllow = tools?.alsoAllow ?? [];
      const deny = tools?.deny ?? [];
      const toolsConfigured = Boolean(tools?.profile) || allow.length > 0 || alsoAllow.length > 0;
      const delegationConfigured = Boolean(entry.subagents);
      const delegationModel = resolvePrimaryStringValue(entry.subagents?.model);
      const delegationProvider = deriveProvider(delegationModel);
      return {
        agentId,
        name: entry.name?.trim() || undefined,
        isDefault: agentId === defaultAgentId,
        configPresent: entries.length > 0,
        model,
        provider,
        providerCredentialsPresent: credsPresent(provider),
        delegationConfigured,
        delegationModel,
        delegationProvider,
        delegationCredentialsPresent: credsPresent(delegationProvider),
        toolsConfigured,
        toolKeys: [...allow, ...alsoAllow, ...deny],
      };
    })
    .filter((profile) => (wanted ? profile.agentId === wanted : true));
}

function renderCheckLine(check: CapabilityCheck): string {
  const detail = check.detail ? ` — ${check.detail}` : "";
  return `    ${STATUS_ICON[check.status]} ${check.label} (${check.reason})${detail}`;
}

function renderText(contract: FleetCapabilityContract): string {
  const lines: string[] = [];
  lines.push("Fleet Capability Contract v1");
  lines.push(
    `Rollup: ${STATUS_ICON[contract.rollup.status]} ${contract.rollup.status} ` +
      `(green ${contract.rollup.green}, yellow ${contract.rollup.yellow}, red ${contract.rollup.red})`,
  );
  lines.push(`Generated: ${contract.now}`);
  lines.push("");
  lines.push("Fleet services:");
  for (const check of contract.services) {
    lines.push(renderCheckLine(check));
  }
  lines.push("");
  lines.push("Profiles:");
  if (contract.profiles.length === 0) {
    lines.push("  (no agent profiles configured)");
  }
  for (const profile of contract.profiles) {
    const heading =
      profile.name && profile.name !== profile.agentId
        ? `${profile.agentId} (${profile.name})`
        : profile.agentId;
    const defaultTag = profile.isDefault ? " (default)" : "";
    lines.push(`  ${STATUS_ICON[profile.status]} ${heading}${defaultTag}`);
    for (const check of profile.checks) {
      lines.push(renderCheckLine(check));
    }
  }
  return lines.join("\n");
}

export async function agentsCapabilitiesCommand(
  opts: AgentsCapabilitiesOptions,
  runtime: RuntimeEnv = defaultRuntime,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (opts.json && opts.markdown) {
    runtime.error("Cannot combine --json and --markdown; choose one output format.");
    return;
  }

  const cfg = await requireValidConfig(runtime);
  if (!cfg) {
    return;
  }

  const services = gatherServiceInput(env);
  services.gatewayConfigured = Boolean(cfg.gateway);

  const profiles = gatherProfileInputs(cfg, env, opts.agent);

  const contract = buildFleetCapabilityContract({
    now: new Date().toISOString(),
    profiles,
    services,
  });

  if (opts.json) {
    writeRuntimeJson(runtime, contract);
    return;
  }
  if (opts.markdown) {
    runtime.log(renderFleetCapabilityMarkdown(contract));
    return;
  }
  runtime.log(renderText(contract));
}
