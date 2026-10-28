import { describe, expect, it } from "vitest";
import { ENGINE_ENV, defaultConfig, parseConfig, parseEngineEnv } from "../src/index.js";

describe("config", () => {
  it("fills every default for an empty or missing file", () => {
    const config = defaultConfig();
    expect(parseConfig(undefined)).toEqual(config);
    expect(parseConfig(null)).toEqual(config);
    expect(config).toMatchObject({
      version: 1,
      serverPort: 20400,
      engineImage: "claude-code",
      setupCompleted: false,
      globalMounts: [],
      secretRefs: [],
      newBoxDefaults: { workspaceDirs: {}, worktreeDirs: {} },
      notifications: {
        decisionNeeded: true,
        runFinished: true,
        boxEnded: true,
        roundSummary: true,
      },
      ceilings: {
        claude: { kind: "utilization", window: "5h", max: 0.6 },
        codex: { kind: "utilization", window: "5h", max: 0.7 },
        copilot: { kind: "spend", period: "month", maxUsd: 70 },
      },
    });
    expect(config.proxyPort).toBeUndefined();
    expect(config.defaultTargetDir).toBeUndefined();
    expect(config.modelCache).toBeUndefined();
  });

  it("keeps the other defaults when one ceiling is set", () => {
    const config = parseConfig({
      ceilings: { codex: { kind: "utilization", window: "7d", max: 0.5 } },
    });
    expect(config.ceilings.codex).toEqual({ kind: "utilization", window: "7d", max: 0.5 });
    expect(config.ceilings.claude.kind).toBe("utilization");
  });

  it("rejects an invalid field or an unknown key instead of dropping it", () => {
    expect(() => parseConfig({ serverPort: 70000 })).toThrow();
    expect(() => parseConfig({ serverPrt: 20400 })).toThrow();
  });

  it("parses the engine environment", () => {
    const raw: Record<string, string> = {
      [ENGINE_ENV.token]: "0123456789abcdef0123",
      [ENGINE_ENV.projectRoot]: "/home/user/src/example-app",
      [ENGINE_ENV.container]: "claude-agent-proj-example-app-1a2b3c4d",
      [ENGINE_ENV.engineVersion]: "4.0.0",
      UNRELATED: "x",
    };
    expect(parseEngineEnv(raw).AGENTBOX_ENGINE_PORT).toBe(20411);
    expect(parseEngineEnv({ ...raw, [ENGINE_ENV.port]: "20500" }).AGENTBOX_ENGINE_PORT).toBe(20500);
    expect(() => parseEngineEnv({ ...raw, [ENGINE_ENV.token]: "short" })).toThrow();
    expect(() => parseEngineEnv({ ...raw, [ENGINE_ENV.port]: "http" })).toThrow();
  });
});
