import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig, type Box, type Project } from "@agentbox/contracts";
import { MIGRATIONS, migrate, openDatabase, repositories } from "../../src/db/index.js";

const T = "2026-10-28T09:00:00.000Z";

function project(id = "app-12345678", root = "/work/app"): Project {
  return {
    id,
    root,
    name: "app",
    tcpMaps: [],
    mounts: [],
    secretRefs: [],
    policyPath: ".claude-box/policy.yaml",
    createdAt: T,
    updatedAt: T,
  };
}

function box(id: string, overrides: Partial<Box> = {}): Box {
  return {
    id,
    projectId: "app-12345678",
    hostKey: id.replace("claude-agent-", ""),
    targetDir: "/work/app",
    sessionUuid: null,
    conversationName: "",
    transcriptSyncedName: "",
    platform: "claude",
    skipPermissions: true,
    container: "claude-agent-proj-app-12345678",
    session: id,
    wasRunning: false,
    sshRemoteRefs: [],
    createdAt: T,
    updatedAt: T,
    ...overrides,
  };
}

describe("openDatabase", () => {
  it("creates the file with mode 0600 and applies every migration once", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-db-"));
    const file = path.join(dir, "sub", "agentbox.db");
    const db = openDatabase(file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    expect(migrate(db)).toBe(MIGRATIONS.length);
    db.close();
    const again = openDatabase(file);
    expect(again.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    again.close();
  });
});

describe("repositories", () => {
  it("round-trips projects and finds them by root", () => {
    const r = repositories(openDatabase(":memory:"));
    r.projects.put(project());
    expect(r.projects.get("app-12345678")).toEqual(project());
    expect(r.projects.byRoot("/work/app")?.id).toBe("app-12345678");
    expect(r.projects.list()).toHaveLength(1);
    expect(r.projects.delete("app-12345678")).toBe(true);
    expect(r.projects.get("app-12345678")).toBeUndefined();
  });

  it("refuses an invalid record", () => {
    const r = repositories(openDatabase(":memory:"));
    expect(() => r.projects.put({ ...project(), id: "bad id" })).toThrow();
  });

  it("indexes boxes by project, session, and directory and enforces host keys", () => {
    const r = repositories(openDatabase(":memory:"));
    r.projects.put(project());
    const uuid = "6f1c3a52-6d8b-4f43-9a51-2d5b7cbd3f10";
    r.boxes.put(box("claude-agent-a", { sessionUuid: uuid }));
    r.boxes.put(box("claude-agent-b", { targetDir: "/work/other" }));
    expect(r.boxes.byProject("app-12345678").map((b) => b.id)).toEqual([
      "claude-agent-a",
      "claude-agent-b",
    ]);
    expect(r.boxes.bySession(uuid).map((b) => b.id)).toEqual(["claude-agent-a"]);
    expect(r.boxes.byTargetDir("/work/other").map((b) => b.id)).toEqual(["claude-agent-b"]);
    expect(() => r.boxes.put(box("claude-agent-c", { hostKey: "a" }))).toThrow(/UNIQUE/);
    r.boxes.put(box("claude-agent-a", { conversationName: "renamed" }));
    expect(r.boxes.get("claude-agent-a")?.conversationName).toBe("renamed");
    expect(r.boxes.delete("claude-agent-a")).toBe(true);
  });

  it("refuses a box whose project does not exist", () => {
    const r = repositories(openDatabase(":memory:"));
    expect(() => r.boxes.put(box("claude-agent-a"))).toThrow(/FOREIGN KEY/);
  });

  it("returns default settings until some are saved", () => {
    const r = repositories(openDatabase(":memory:"));
    expect(r.settings.exists()).toBe(false);
    expect(r.settings.get()).toEqual(defaultConfig());
    r.settings.put({ ...defaultConfig(), setupCompleted: true }, new Date(T));
    expect(r.settings.exists()).toBe(true);
    expect(r.settings.get().setupCompleted).toBe(true);
    expect(() =>
      r.settings.put({ ...defaultConfig(), unknown: 1 } as never, new Date(T)),
    ).toThrow();
  });

  it("keeps engine endpoints unique per port", () => {
    const r = repositories(openDatabase(":memory:"));
    r.projects.put(project());
    r.projects.put(project("other-87654321", "/work/other"));
    const e = {
      projectId: "app-12345678",
      container: "claude-agent-proj-app-12345678",
      hostPort: 41000,
      token: "t".repeat(64),
    };
    r.engines.put(e, new Date(T));
    expect(r.engines.get("app-12345678")).toEqual(e);
    expect(r.engines.byContainer(e.container)).toEqual(e);
    expect(() =>
      r.engines.put(
        { ...e, projectId: "other-87654321", container: "claude-agent-proj-other-87654321" },
        new Date(T),
      ),
    ).toThrow(/UNIQUE/);
    r.projects.delete("other-87654321");
    expect(r.engines.list()).toHaveLength(1);
  });

  it("stores ssh remotes, jobs, imports, and usage samples", () => {
    const r = repositories(openDatabase(":memory:"));
    r.sshRemotes.put({ name: "lab", host: "dev@203.0.113.5", forwards: [] });
    expect(r.sshRemotes.list().map((x) => x.name)).toEqual(["lab"]);
    r.jobs.put({
      id: "job-1",
      kind: "image_build",
      boxId: null,
      command: "docker build",
      status: "running",
      exitCode: null,
      error: null,
      result: null,
      startedAt: T,
      finishedAt: null,
    });
    r.jobs.put({ ...r.jobs.get("job-1")!, status: "finished", exitCode: 0, finishedAt: T });
    expect(r.jobs.get("job-1")?.status).toBe("finished");
    r.imports.add("claude-box-3", { ok: true }, new Date(T));
    expect(r.imports.latest("claude-box-3")?.report).toEqual({ ok: true });
    const sample = {
      vendor: "claude" as const,
      account: "dev@example.com",
      window: "5h" as const,
      utilization: 0.2,
      spendUsd: null,
      ceiling: { kind: "utilization" as const, window: "5h" as const, max: 0.6 },
      resetAt: null,
      sampleSource: "rate_limit_event" as const,
      time: T,
    };
    r.usage.add(sample);
    expect(r.usage.list({ vendor: "claude" })).toEqual([sample]);
    expect(r.usage.list({ vendor: "codex" })).toEqual([]);
    expect(r.usage.list({ since: "2026-10-29T00:00:00Z" })).toEqual([]);
  });

  it("runs work in one transaction", () => {
    const r = repositories(openDatabase(":memory:"));
    expect(() =>
      r.transaction(() => {
        r.projects.put(project());
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(r.projects.list()).toEqual([]);
  });
});
