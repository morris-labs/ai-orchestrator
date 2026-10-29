import path from "node:path";
import { describe, expect, it } from "vitest";
import { dataDirOf, dataPath, homePaths, type HostEnv } from "../../src/records/env.js";

const env = (dataDir?: string): HostEnv => ({
  home: "/home/u",
  user: "u",
  now: () => new Date(0),
  dataDir,
});

describe("data directory", () => {
  it("defaults to ~/.claude-box", () => {
    expect(dataDirOf(env())).toBe("/home/u/.claude-box");
    const p = homePaths(env());
    expect(p.database).toBe("/home/u/.claude-box/agentbox.db");
    expect(p.serverToken).toBe("/home/u/.claude-box/server.token");
    expect(p.stateDir).toBe("/home/u/.claude-box/state");
    expect(p.sessionsDir).toBe("/home/u/.claude-box/sessions");
  });

  it("moves every data path, and only those, under dataDir", () => {
    const p = homePaths(env("/srv/data"));
    expect(p.dataDir).toBe("/srv/data");
    expect(p.database).toBe("/srv/data/agentbox.db");
    expect(p.config).toBe("/srv/data/config.json");
    expect(p.serverToken).toBe("/srv/data/server.token");
    expect(p.stateDir).toBe("/srv/data/state");
    expect(p.sessionsDir).toBe("/srv/data/sessions");
    expect(p.backupDir).toBe("/srv/data/backup");
    expect(p.importReport).toBe("/srv/data/import-report.json");
    expect(p.claudeProjects).toBe("/home/u/.claude/projects");
    expect(p.claudeJson).toBe("/home/u/.claude.json");
  });

  it("resolves a relative dataDir against the working directory", () => {
    expect(dataDirOf(env("rel"))).toBe(path.resolve("rel"));
  });

  it("refuses a path outside ~/.claude-box", () => {
    expect(() => dataPath(env(), ".claude/projects")).toThrow(/isn't under/);
  });
});
