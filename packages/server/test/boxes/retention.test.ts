// Transcript retention and snapshots, and removing a project: the data-loss
// guards of docs/accounts.md, "Transcript retention".
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureRetention,
  hostRetentionDays,
  protectedRetentionDays,
  retentionWarnings,
} from "../../src/accounts/retention.js";
import { listSnapshots, snapshotTranscripts } from "../../src/accounts/backup.js";
import { START_SESSION_PATH } from "../../src/docker/scripts.js";
import { accountDirFor } from "../../src/records/env.js";
import { tempDir } from "../tmp.js";
import { makeHarness, type Harness } from "./harness.js";

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

function addAccount(h: Harness, name: string): string {
  const dir = accountDirFor(h.env, "claude", name);
  fs.mkdirSync(dir, { recursive: true });
  const store = h.dir(".claude-box", "transcripts", "claude");
  fs.mkdirSync(store, { recursive: true });
  fs.symlinkSync(store, path.join(dir, "projects"));
  const now = new Date().toISOString();
  h.core.db.accounts.put({
    id: `claude/${name}`,
    vendor: "claude",
    name,
    label: name,
    overflow: false,
    signIn: { state: "signed_in" },
    createdAt: now,
    updatedAt: now,
  });
  h.core.settings.patch({
    accountsMode: "accounts",
    accountDefaults: { claude: `claude/${name}` },
  });
  return dir;
}

function sessionStarts(h: Harness): number {
  return h.docker
    .callsOf("exec")
    .filter((c) => (c.args[1] as { cmd: string[] }).cmd[0] === START_SESSION_PATH).length;
}

describe("ensureRetention", () => {
  it("writes the key when it is missing and keeps the other keys", () => {
    const dir = tempDir("agentbox-ret-");
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ model: "opus" }));
    expect(ensureRetention(dir, 3650)).toBe(true);
    expect(readJson(path.join(dir, "settings.json"))).toEqual({
      model: "opus",
      cleanupPeriodDays: 3650,
    });
  });

  it("creates a missing settings.json", () => {
    const dir = tempDir("agentbox-ret-");
    expect(ensureRetention(dir, 100)).toBe(true);
    expect(readJson(path.join(dir, "settings.json"))).toEqual({ cleanupPeriodDays: 100 });
  });

  it("raises a lower value and never lowers a larger one", () => {
    const dir = tempDir("agentbox-ret-");
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, JSON.stringify({ cleanupPeriodDays: 30 }));
    expect(ensureRetention(dir, 3650)).toBe(true);
    expect(readJson(file).cleanupPeriodDays).toBe(3650);
    fs.writeFileSync(file, JSON.stringify({ cleanupPeriodDays: 36500 }));
    expect(ensureRetention(dir, 3650)).toBe(false);
    expect(readJson(file).cleanupPeriodDays).toBe(36500);
  });

  it("replaces a value that Claude Code wouldn't accept", () => {
    const dir = tempDir("agentbox-ret-");
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, JSON.stringify({ cleanupPeriodDays: "30" }));
    ensureRetention(dir, 3650);
    expect(readJson(file).cleanupPeriodDays).toBe(3650);
  });

  it("throws for a settings.json that isn't a JSON object", () => {
    const dir = tempDir("agentbox-ret-");
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, "{ not json");
    expect(() => ensureRetention(dir, 3650)).toThrow(/isn't a JSON object/);
    expect(fs.readFileSync(file, "utf8")).toBe("{ not json");
  });

  it.skipIf(process.getuid?.() === 0)("throws when the file can't be written", () => {
    const dir = tempDir("agentbox-ret-");
    fs.chmodSync(dir, 0o500);
    try {
      expect(() => ensureRetention(dir, 3650)).toThrow(/Can't write cleanupPeriodDays/);
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });
});

describe("protected retention value", () => {
  it("takes the host's value, else the setting, else 3650", () => {
    const home = tempDir("agentbox-ret-home-");
    expect(protectedRetentionDays(home, undefined)).toBe(3650);
    expect(protectedRetentionDays(home, 500)).toBe(500);
    fs.mkdirSync(path.join(home, ".claude"));
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), '{"cleanupPeriodDays": 9999}');
    expect(hostRetentionDays(home)).toBe(9999);
    expect(protectedRetentionDays(home, 500)).toBe(9999);
  });

  it("ignores a host value that isn't a positive whole number", () => {
    const home = tempDir("agentbox-ret-home-");
    fs.mkdirSync(path.join(home, ".claude"));
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), '{"cleanupPeriodDays": 0}');
    expect(protectedRetentionDays(home, undefined)).toBe(3650);
  });
});

describe("retentionWarnings", () => {
  it("warns about a missing or lower value and a desktop ceiling", () => {
    const dir = tempDir("agentbox-ret-");
    const file = path.join(dir, "settings.json");
    expect(retentionWarnings(dir, 3650)[0]).toMatch(/doesn't set cleanupPeriodDays/);
    fs.writeFileSync(file, JSON.stringify({ cleanupPeriodDays: 30 }));
    expect(retentionWarnings(dir, 3650)[0]).toMatch(/below 3650/);
    fs.writeFileSync(
      file,
      JSON.stringify({ cleanupPeriodDays: 3650, desktopSessionCleanupPeriodDays: 60 }),
    );
    const w = retentionWarnings(dir, 3650);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/desktopSessionCleanupPeriodDays/);
    fs.writeFileSync(file, JSON.stringify({ cleanupPeriodDays: 3650 }));
    expect(retentionWarnings(dir, 3650)).toEqual([]);
  });

  it("shows up in the account view", () => {
    const h = makeHarness();
    const dir = addAccount(h, "personal");
    const view = h.core.accounts.list().find((a) => a.account.id === "claude/personal");
    expect(view?.warnings?.join("\n")).toMatch(/cleanupPeriodDays/);
    ensureRetention(dir, 3650);
    const after = h.core.accounts.list().find((a) => a.account.id === "claude/personal");
    expect(after?.warnings ?? []).toEqual([]);
  });
});

describe("starting a Claude session on an account", () => {
  it("writes cleanupPeriodDays before the session command runs", async () => {
    const h = makeHarness();
    const dir = addAccount(h, "personal");
    expect(fs.existsSync(path.join(dir, "settings.json"))).toBe(false);
    // The fake Docker runs the hook when the session command arrives.
    let seen: unknown;
    const exec = h.docker.exec.bind(h.docker);
    h.docker.exec = (async (...a: Parameters<typeof exec>) => {
      if (a[1].cmd[0] === START_SESSION_PATH) {
        seen = readJson(path.join(dir, "settings.json")).cleanupPeriodDays;
      }
      return exec(...a);
    }) as typeof h.docker.exec;
    await h.core.boxes.create({ targetDir: h.dir("a"), layout: "root" });
    expect(readJson(path.join(dir, "settings.json")).cleanupPeriodDays).toBe(3650);
    expect(seen).toBe(3650);
    expect(sessionStarts(h)).toBe(1);
  });

  it("uses the host's value, and the setting when the host sets none", async () => {
    const h = makeHarness();
    const dir = addAccount(h, "personal");
    h.core.settings.patch({ transcriptRetentionDays: 400 });
    const a = await h.core.boxes.create({ targetDir: h.dir("a"), layout: "root" });
    expect(readJson(path.join(dir, "settings.json")).cleanupPeriodDays).toBe(400);
    await h.core.boxes.stop(a.id);
    fs.mkdirSync(path.join(h.home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(h.home, ".claude", "settings.json"), '{"cleanupPeriodDays": 5000}');
    await h.core.boxes.start(a.id);
    expect(readJson(path.join(dir, "settings.json")).cleanupPeriodDays).toBe(5000);
  });

  it("raises a low value on every start", async () => {
    const h = makeHarness();
    const dir = addAccount(h, "personal");
    const box = await h.core.boxes.create({ targetDir: h.dir("a"), layout: "root" });
    await h.core.boxes.stop(box.id);
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ cleanupPeriodDays: 30 }));
    await h.core.boxes.start(box.id);
    expect(readJson(path.join(dir, "settings.json")).cleanupPeriodDays).toBe(3650);
  });

  it("refuses to start when settings.json isn't valid, and starts no session", async () => {
    const h = makeHarness();
    const dir = addAccount(h, "personal");
    fs.writeFileSync(path.join(dir, "settings.json"), "{ broken");
    await expect(
      h.core.boxes.create({ targetDir: h.dir("a"), layout: "root" }),
    ).rejects.toMatchObject({ code: "invalid_state", message: /isn't a JSON object/ });
    expect(sessionStarts(h)).toBe(0);
  });

  it.skipIf(process.getuid?.() === 0)(
    "refuses to start when settings.json can't be written",
    async () => {
      const h = makeHarness();
      const dir = addAccount(h, "personal");
      fs.chmodSync(dir, 0o500);
      try {
        await expect(
          h.core.boxes.create({ targetDir: h.dir("a"), layout: "root" }),
        ).rejects.toMatchObject({ code: "invalid_state", message: /Can't write cleanupPeriodDays/ });
        expect(sessionStarts(h)).toBe(0);
      } finally {
        fs.chmodSync(dir, 0o700);
      }
    },
  );
});

describe("transcript snapshots", () => {
  function store(): { root: string; backup: string } {
    const root = tempDir("agentbox-snap-");
    const backup = path.join(tempDir("agentbox-snap-b-"), "backup", "transcripts");
    fs.mkdirSync(path.join(root, "-work-app"), { recursive: true });
    fs.writeFileSync(path.join(root, "-work-app", "a.jsonl"), "one\n");
    return { root, backup };
  }

  it("links the files and survives a delete in the store", async () => {
    const { root, backup } = store();
    const r = await snapshotTranscripts({
      storeRoot: root,
      backupRoot: backup,
      keep: 7,
      now: new Date("2026-11-01T04:10:18Z"),
    });
    expect(r.files).toBe(1);
    expect(path.basename(r.dir ?? "")).toBe("2026-11-01T04-10-18Z");
    const copy = path.join(r.dir ?? "", "-work-app", "a.jsonl");
    expect(fs.statSync(copy).ino).toBe(fs.statSync(path.join(root, "-work-app", "a.jsonl")).ino);
    fs.rmSync(path.join(root, "-work-app"), { recursive: true });
    expect(fs.readFileSync(copy, "utf8")).toBe("one\n");
  });

  it("keeps the newest N and deletes no store file when it prunes", async () => {
    const { root, backup } = store();
    for (let i = 0; i < 4; i += 1) {
      await snapshotTranscripts({
        storeRoot: root,
        backupRoot: backup,
        keep: 2,
        now: new Date(Date.UTC(2026, 10, 1, 0, 0, i)),
      });
    }
    expect(listSnapshots(backup)).toEqual(["2026-11-01T00-00-02Z", "2026-11-01T00-00-03Z"]);
    expect(fs.readFileSync(path.join(root, "-work-app", "a.jsonl"), "utf8")).toBe("one\n");
  });

  it("does nothing when keep is 0 or the store is missing", async () => {
    const { root, backup } = store();
    const off = await snapshotTranscripts({
      storeRoot: root,
      backupRoot: backup,
      keep: 0,
      now: new Date(),
    });
    expect(off.dir).toBeUndefined();
    const missing = await snapshotTranscripts({
      storeRoot: path.join(root, "nope"),
      backupRoot: backup,
      keep: 7,
      now: new Date(),
    });
    expect(missing.dir).toBeUndefined();
    expect(listSnapshots(backup)).toEqual([]);
  });

  it("is taken once, at the first Claude start after the server started", async () => {
    const h = makeHarness();
    addAccount(h, "personal");
    const store = path.join(h.home, ".claude-box", "transcripts", "claude");
    fs.mkdirSync(path.join(store, "-x"), { recursive: true });
    fs.writeFileSync(path.join(store, "-x", "t.jsonl"), "x\n");
    const a = await h.core.boxes.create({ targetDir: h.dir("a"), layout: "root" });
    await h.core.boxes.stop(a.id);
    await h.core.boxes.start(a.id);
    const backup = path.join(h.home, ".claude-box", "backup", "transcripts");
    expect(listSnapshots(backup)).toHaveLength(1);
  });

  it("is skipped when transcriptBackupKeep is 0", async () => {
    const h = makeHarness();
    addAccount(h, "personal");
    h.core.settings.patch({ transcriptBackupKeep: 0 });
    await h.core.boxes.create({ targetDir: h.dir("a"), layout: "root" });
    expect(listSnapshots(path.join(h.home, ".claude-box", "backup", "transcripts"))).toEqual([]);
  });
});

describe("removing a project", () => {
  it("deletes an empty project and leaves its folder alone", async () => {
    const h = makeHarness();
    const dir = h.dir("proj");
    const project = h.core.projects.create({ root: dir });
    const r = await h.core.boxes.removeProject(project.id);
    expect(r).toEqual({ removed: true, boxes: [] });
    expect(() => h.core.projects.get(project.id)).toThrow();
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("refuses a project with boxes, unless forced", async () => {
    const h = makeHarness();
    const dir = h.dir("proj");
    const box = await h.core.boxes.create({ targetDir: dir, layout: "root" });
    await expect(h.core.boxes.removeProject(box.projectId)).rejects.toMatchObject({
      code: "conflict",
    });
    // Running boxes are refused even with force, and nothing is removed.
    await expect(
      h.core.boxes.removeProject(box.projectId, { force: true }),
    ).rejects.toMatchObject({ code: "box_running" });
    expect(h.core.db.boxes.get(box.id)).toBeDefined();
    await h.core.boxes.stop(box.id);
    const r = await h.core.boxes.removeProject(box.projectId, { force: true });
    expect(r.boxes).toEqual([box.id]);
    expect(h.core.db.boxes.get(box.id)).toBeUndefined();
    expect(h.core.db.projects.get(box.projectId)).toBeUndefined();
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("keeps the transcripts", async () => {
    const h = makeHarness();
    const dir = h.dir("proj");
    const box = await h.core.boxes.create({ targetDir: dir, layout: "root" });
    await h.core.boxes.stop(box.id);
    const transcript = path.join(h.home, ".claude", "projects", "-p", "t.jsonl");
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, "x\n");
    await h.core.boxes.removeProject(box.projectId, { force: true });
    expect(fs.existsSync(transcript)).toBe(true);
  });
});
