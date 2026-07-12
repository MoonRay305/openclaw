import { execFileSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pluginDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(pluginDir, "../..");

describe("voice-field-router installed runtime package", () => {
  it("declares and ships a compiled JavaScript runtime entry", async () => {
    const packageJson = JSON.parse(
      await fs.readFile(path.join(pluginDir, "package.json"), "utf8"),
    ) as { openclaw?: { runtimeExtensions?: string[] } };

    expect(packageJson.openclaw?.runtimeExtensions).toEqual(["./dist/index.mjs"]);
    const runtimePath = path.join(pluginDir, "dist/index.mjs");
    await expect(fs.stat(runtimePath)).resolves.toMatchObject({ isFile: expect.any(Function) });
    const runtime = await fs.readFile(runtimePath, "utf8");
    expect(runtime).toContain("voice-field-router");
    expect(runtime).not.toContain("inbound_claim");
  });
  it("requires exact scope whenever routing is enabled", async () => {
    const manifest = JSON.parse(
      await fs.readFile(path.join(pluginDir, "openclaw.plugin.json"), "utf8"),
    ) as { configSchema?: { allOf?: unknown[]; properties?: Record<string, unknown> } };
    expect(manifest.configSchema?.properties?.botUsername).toEqual({
      type: "string",
      const: "@DoubleRookVoiceFieldBot",
    });
    /* oxlint-disable unicorn/no-thenable -- JSON Schema's `then` keyword is the behavior under test. */
    expect(manifest.configSchema?.allOf).toContainEqual({
      if: { required: ["enabled"], properties: { enabled: { const: true } } },
      then: { required: ["accountId", "senderId", "botUsername", "voiceFieldUserId"] },
    });
    /* oxlint-enable unicorn/no-thenable */
  });

  it("loads the copied compiled runtime through OpenClaw's external plugin loader", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "voice-field-router-loader-"));
    const stateDir = path.join(home, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(home, "AppData", "Local"),
      HOMEDRIVE: path.parse(home).root,
      HOMEPATH: home.slice(path.parse(home).root.length),
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      NO_COLOR: "1",
      NODE_ENV: "production",
    };
    delete env.VITEST;
    delete env.VITEST_POOL_ID;
    delete env.VITEST_WORKER_ID;
    const cli = path.join(repoRoot, "node_modules", "openclaw", "openclaw.mjs");
    try {
      execFileSync(process.execPath, [cli, "plugins", "install", pluginDir], {
        cwd: repoRoot,
        env,
        timeout: 120_000,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const config = JSON.parse(await fs.readFile(configPath, "utf8")) as {
        plugins: {
          entries: Record<string, { enabled?: boolean; config?: Record<string, unknown> }>;
        };
      };
      config.plugins.entries["voice-field-router"] = {
        enabled: true,
        config: {
          enabled: true,
          channel: "telegram",
          accountId: "default",
          senderId: "6003416166",
          botUsername: "@DoubleRookVoiceFieldBot",
          voiceFieldUserId: "landon",
          timeoutMs: 15_000,
        },
      };
      await fs.writeFile(
        configPath,
        `${JSON.stringify(config, null, 2)}
`,
      );
      const inspectPath = path.join(home, "inspect.json");
      const inspectFd = openSync(inspectPath, "w");
      try {
        execFileSync(
          process.execPath,
          [cli, "plugins", "inspect", "voice-field-router", "--runtime", "--json"],
          {
            cwd: repoRoot,
            env,
            timeout: 120_000,
            stdio: ["ignore", inspectFd, "pipe"],
          },
        );
      } finally {
        closeSync(inspectFd);
      }
      const stdout = await fs.readFile(inspectPath, "utf8");
      const inspection = JSON.parse(stdout) as {
        plugin?: { source?: string; status?: string; hookCount?: number };
        diagnostics?: unknown[];
      };
      expect(inspection.plugin?.status).toBe("loaded");
      expect((inspection.plugin?.source ?? "").replaceAll("\\", "/")).toContain("dist/index.mjs");
      expect(inspection.plugin?.source).not.toContain("index.ts");
      expect(inspection.plugin?.hookCount).toBe(1);
      expect(inspection.diagnostics).toEqual([]);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
