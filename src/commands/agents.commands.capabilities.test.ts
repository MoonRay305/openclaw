import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { agentsCapabilitiesCommand } from "./agents.commands.capabilities.js";

const mocks = vi.hoisted(() => ({
  requireValidConfigMock: vi.fn(),
  resolveProviderAuthEnvVarCandidatesMock: vi.fn(),
}));

vi.mock("./agents.command-shared.js", () => ({
  requireValidConfig: mocks.requireValidConfigMock,
}));

vi.mock("../secrets/provider-env-vars.js", () => ({
  resolveProviderAuthEnvVarCandidates: mocks.resolveProviderAuthEnvVarCandidatesMock,
}));

function createRuntime() {
  const logs: string[] = [];
  const errors: string[] = [];
  const runtime: RuntimeEnv = {
    log: (...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    },
    error: (...args: unknown[]) => {
      errors.push(args.map((a) => String(a)).join(" "));
    },
    exit: () => {},
  };
  return { runtime, logs, errors };
}

const SECRET = "sk-ant-super-secret-value-9999";

function configWith(list: OpenClawConfig["agents"]): OpenClawConfig {
  return { agents: list } as unknown as OpenClawConfig;
}

describe("agentsCapabilitiesCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveProviderAuthEnvVarCandidatesMock.mockReturnValue({
      anthropic: ["ANTHROPIC_API_KEY"],
    });
  });

  it("emits a JSON contract without leaking secret values", async () => {
    mocks.requireValidConfigMock.mockResolvedValue(
      configWith({
        list: [{ id: "peewee", model: "anthropic/claude-opus-4-7", tools: { allow: ["Read"] } }],
      }),
    );
    const { runtime, logs } = createRuntime();
    const env = { ANTHROPIC_API_KEY: SECRET } as unknown as NodeJS.ProcessEnv;

    await agentsCapabilitiesCommand({ json: true }, runtime, env);

    expect(logs).toHaveLength(1);
    const contract = JSON.parse(logs[0]);
    expect(contract.version).toBe(1);
    const profile = contract.profiles.find((p: { agentId: string }) => p.agentId === "peewee");
    expect(profile).toBeDefined();
    const creds = profile.checks.find((c: { id: string }) => c.id === "profile.credentials");
    expect(creds.status).toBe("green");
    // The secret value must never appear anywhere in the output.
    expect(logs[0]).not.toContain(SECRET);
  });

  it("flags missing provider credentials as red", async () => {
    mocks.requireValidConfigMock.mockResolvedValue(
      configWith({
        list: [{ id: "peewee", model: "anthropic/claude-opus-4-7", tools: { allow: ["Read"] } }],
      }),
    );
    const { runtime, logs } = createRuntime();
    const env = {} as NodeJS.ProcessEnv;

    await agentsCapabilitiesCommand({ json: true }, runtime, env);
    const contract = JSON.parse(logs[0]);
    const profile = contract.profiles[0];
    const creds = profile.checks.find((c: { id: string }) => c.id === "profile.credentials");
    expect(creds.status).toBe("red");
    expect(creds.reason).toBe("provider_credentials_missing");
  });

  it("filters to a single agent via --agent", async () => {
    mocks.requireValidConfigMock.mockResolvedValue(
      configWith({
        list: [
          { id: "peewee", model: "anthropic/claude-opus-4-7" },
          { id: "rico", model: "anthropic/claude-haiku-4-5" },
        ],
      }),
    );
    const { runtime, logs } = createRuntime();

    await agentsCapabilitiesCommand(
      { json: true, agent: "rico" },
      runtime,
      {} as NodeJS.ProcessEnv,
    );
    const contract = JSON.parse(logs[0]);
    expect(contract.profiles).toHaveLength(1);
    expect(contract.profiles[0].agentId).toBe("rico");
  });

  it("renders markdown when --markdown is set", async () => {
    mocks.requireValidConfigMock.mockResolvedValue(
      configWith({ list: [{ id: "peewee", model: "anthropic/claude-opus-4-7" }] }),
    );
    const { runtime, logs } = createRuntime();

    await agentsCapabilitiesCommand({ markdown: true }, runtime, {} as NodeJS.ProcessEnv);
    expect(logs[0]).toContain("# Fleet Capability Contract v1");
  });

  it("renders human text by default", async () => {
    mocks.requireValidConfigMock.mockResolvedValue(
      configWith({ list: [{ id: "peewee", model: "anthropic/claude-opus-4-7" }] }),
    );
    const { runtime, logs } = createRuntime();

    await agentsCapabilitiesCommand({}, runtime, {} as NodeJS.ProcessEnv);
    expect(logs[0]).toContain("Fleet Capability Contract v1");
    expect(logs[0]).toContain("Profiles:");
  });

  it("rejects combining --json and --markdown", async () => {
    const { runtime, errors } = createRuntime();
    await agentsCapabilitiesCommand(
      { json: true, markdown: true },
      runtime,
      {} as NodeJS.ProcessEnv,
    );
    expect(errors[0]).toContain("Cannot combine --json and --markdown");
    expect(mocks.requireValidConfigMock).not.toHaveBeenCalled();
  });

  it("returns quietly when config is invalid", async () => {
    mocks.requireValidConfigMock.mockResolvedValue(null);
    const { runtime, logs } = createRuntime();
    await agentsCapabilitiesCommand({ json: true }, runtime, {} as NodeJS.ProcessEnv);
    expect(logs).toHaveLength(0);
  });
});
