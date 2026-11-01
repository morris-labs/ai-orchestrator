// `transcripts.adopt`: moves the host's transcripts into the store. Every path
// is in a temporary home.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { adoptTranscripts } from "../../src/accounts/adopt.js";
import { AccountService } from "../../src/accounts/service.js";
import { openDatabase, repositories } from "../../src/db/index.js";
import { MemoryDocker } from "../../src/docker/memory.js";
import type { HostEnv } from "../../src/records/env.js";
import { CoreEvents } from "../../src/records/events.js";
import { SettingsService } from "../../src/records/settings.js";
import { tempDir } from "../tmp.js";

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function layout() {
  const home = fs.realpathSync(tempDir("aio-adopt-"));
  const store = path.join(home, ".ai-orchestrator", "transcripts", "claude");
  const projects = path.join(home, ".claude", "projects");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  return { home, store, projects, middle: path.join(home, "intermediate-link") };
}

describe("adoptTranscripts", () => {
  it("moves a real projects folder into the store and links to it", () => {
    const l = layout();
    write(path.join(l.projects, "-work-app", "u1.jsonl"), "one");
    write(path.join(l.projects, "-work-app", "sub", "u2.jsonl"), "two");
    const r = adoptTranscripts({ home: l.home, store: l.store, dryRun: false });
    expect(r).toMatchObject({ status: "adopted", moved: 2, duplicates: 0, clashes: [] });
    expect(fs.readFileSync(path.join(l.store, "-work-app", "u1.jsonl"), "utf8")).toBe("one");
    expect(fs.readFileSync(path.join(l.store, "-work-app", "sub", "u2.jsonl"), "utf8")).toBe("two");
    expect(fs.readlinkSync(l.projects)).toBe(l.store);
  });

  it("moves the target of a link and repoints projects at the store", () => {
    const l = layout();
    const old = path.join(l.home, "old-store");
    write(path.join(old, "-a", "u.jsonl"), "x");
    fs.symlinkSync(old, l.projects);
    const r = adoptTranscripts({ home: l.home, store: l.store, dryRun: false });
    expect(r.status).toBe("adopted");
    expect(r.source).toBe(old);
    expect(fs.readlinkSync(l.projects)).toBe(l.store);
    expect(fs.existsSync(path.join(l.store, "-a", "u.jsonl"))).toBe(true);
    // The emptied old folder stays for the owner to remove.
    expect(fs.readdirSync(old)).toEqual([]);
    expect(r.actions.join("\n")).toMatch(/Remove it by hand/);
  });

  it("repoints the temporary chain at the store and removes the redundant link", () => {
    const l = layout();
    write(path.join(l.store, "-a", "u.jsonl"), "x");
    fs.symlinkSync(l.store, l.middle);
    fs.symlinkSync(l.middle, l.projects);
    const r = adoptTranscripts({ home: l.home, store: l.store, dryRun: false });
    expect(r).toMatchObject({ status: "adopted", moved: 0 });
    expect(fs.readlinkSync(l.projects)).toBe(l.store);
    expect(fs.existsSync(l.middle)).toBe(false);
    expect(fs.lstatSync(path.join(l.store, "-a", "u.jsonl")).isFile()).toBe(true);
  });

  it("keeps an intermediate link that doesn't point at the store", () => {
    const l = layout();
    const other = path.join(l.home, "other");
    write(path.join(other, "-a", "u.jsonl"), "x");
    fs.mkdirSync(l.store, { recursive: true });
    fs.symlinkSync(other, l.middle);
    fs.symlinkSync(l.middle, l.projects);
    adoptTranscripts({ home: l.home, store: l.store, dryRun: false });
    expect(fs.lstatSync(l.middle).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(l.projects)).toBe(l.store);
  });

  it("changes nothing when the final direct link is already in place", () => {
    const l = layout();
    write(path.join(l.store, "-a", "u.jsonl"), "x");
    fs.symlinkSync(l.store, l.projects);
    const r = adoptTranscripts({ home: l.home, store: l.store, dryRun: false });
    expect(r).toMatchObject({ status: "unchanged", moved: 0 });
  });

  it("merges without overwriting and treats identical files as duplicates", () => {
    const l = layout();
    write(path.join(l.projects, "-a", "same.jsonl"), "same");
    write(path.join(l.projects, "-a", "new.jsonl"), "new");
    write(path.join(l.store, "-a", "same.jsonl"), "same");
    write(path.join(l.store, "-a", "keep.jsonl"), "keep");
    const r = adoptTranscripts({ home: l.home, store: l.store, dryRun: false });
    expect(r).toMatchObject({ status: "adopted", moved: 1, duplicates: 1 });
    expect(fs.readdirSync(path.join(l.store, "-a")).sort()).toEqual([
      "keep.jsonl",
      "new.jsonl",
      "same.jsonl",
    ]);
    expect(fs.readlinkSync(l.projects)).toBe(l.store);
  });

  it("reports clashes and changes nothing", () => {
    const l = layout();
    write(path.join(l.projects, "-a", "u.jsonl"), "host version");
    write(path.join(l.projects, "-a", "other.jsonl"), "other");
    write(path.join(l.store, "-a", "u.jsonl"), "store version");
    const r = adoptTranscripts({ home: l.home, store: l.store, dryRun: false });
    expect(r.status).toBe("blocked");
    expect(r.clashes).toEqual([path.join("-a", "u.jsonl")]);
    expect(fs.readFileSync(path.join(l.store, "-a", "u.jsonl"), "utf8")).toBe("store version");
    expect(fs.existsSync(path.join(l.store, "-a", "other.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(l.projects, "-a", "other.jsonl"))).toBe(true);
    expect(fs.lstatSync(l.projects).isDirectory()).toBe(true);
  });

  it("dry run reports the plan and changes nothing", () => {
    const l = layout();
    write(path.join(l.projects, "-a", "u.jsonl"), "x");
    const r = adoptTranscripts({ home: l.home, store: l.store, dryRun: true });
    expect(r).toMatchObject({ status: "adopted", dryRun: true, moved: 1 });
    expect(r.actions.every((a) => a.startsWith("Would "))).toBe(true);
    expect(fs.existsSync(l.store)).toBe(false);
    expect(fs.lstatSync(l.projects).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(l.projects, "-a", "u.jsonl"))).toBe(true);
  });

  it("links a missing or dangling projects entry to the store", () => {
    const l = layout();
    expect(adoptTranscripts({ home: l.home, store: l.store, dryRun: false }).status).toBe(
      "adopted",
    );
    expect(fs.readlinkSync(l.projects)).toBe(l.store);
    fs.unlinkSync(l.projects);
    fs.symlinkSync("/nowhere/at/all", l.projects);
    adoptTranscripts({ home: l.home, store: l.store, dryRun: false });
    expect(fs.readlinkSync(l.projects)).toBe(l.store);
  });

  it("refuses a source nested in the store", () => {
    const l = layout();
    const nested = path.join(l.store, "inner");
    write(path.join(nested, "-a", "u.jsonl"), "x");
    fs.symlinkSync(nested, l.projects);
    const r = adoptTranscripts({ home: l.home, store: l.store, dryRun: false });
    expect(r.status).toBe("blocked");
    expect(fs.readlinkSync(l.projects)).toBe(nested);
  });
});

describe("AccountService.adoptTranscripts", () => {
  function service(running: string[]) {
    const l = layout();
    const env: HostEnv = {
      home: l.home,
      dataDir: path.join(l.home, ".ai-orchestrator"),
      user: "tester",
      now: () => new Date("2026-11-01T09:00:00Z"),
    };
    const repos = repositories(openDatabase(":memory:"));
    const settings = new SettingsService(
      env,
      repos.settings,
      new CoreEvents(),
      () => false,
      () => undefined,
    );
    const accounts = new AccountService({
      env,
      repo: repos.accounts,
      db: repos.sqlite,
      settings,
      docker: new MemoryDocker(),
      runningBoxes: () => running,
      tempDirs: [],
    });
    return { l, accounts };
  }

  it("refuses while a box runs, but allows a dry run", () => {
    const { l, accounts } = service(["box-1"]);
    write(path.join(l.projects, "-a", "u.jsonl"), "x");
    expect(() => accounts.adoptTranscripts({})).toThrow(/Stop every box/);
    expect(fs.lstatSync(l.projects).isDirectory()).toBe(true);
    expect(accounts.adoptTranscripts({ dryRun: true }).moved).toBe(1);
  });

  it("adopts into DATA_DIR/transcripts/claude when no box runs", () => {
    const { l, accounts } = service([]);
    write(path.join(l.projects, "-a", "u.jsonl"), "x");
    const r = accounts.adoptTranscripts({});
    expect(r.store).toBe(l.store);
    expect(fs.readlinkSync(l.projects)).toBe(l.store);
  });
});
