// The shared transcript store: how it resolves, how import, seed, and create
// link accounts to it, the check warning, relink, and the mode-switch guard.
// Every path is synthetic, in a temporary home.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AccountService } from "../../src/accounts/service.js";
import { linkProjectsToStore, projectsLinkState, resolveStore } from "../../src/accounts/store.js";
import { openDatabase, repositories } from "../../src/db/index.js";
import { MemoryDocker } from "../../src/docker/memory.js";
import type { HostEnv } from "../../src/records/env.js";
import { CoreEvents } from "../../src/records/events.js";
import { SettingsService } from "../../src/records/settings.js";
import { tempDir } from "../tmp.js";

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o600 });
}

interface Options {
  /**
   * The host's `~/.claude/projects`: `chain` (a link to an intermediate link
   * to the store, like the temporary layout), `direct` (a link to the store),
   * `dir` (a real folder outside the store), `dangling`, or `none`.
   */
  host?: "chain" | "direct" | "dir" | "dangling" | "none";
}

function setup(options: Options = {}) {
  const home = tempDir("aio-store-home-");
  const env: HostEnv = {
    home,
    dataDir: path.join(home, ".ai-orchestrator"),
    user: "tester",
    now: () => new Date("2026-10-31T09:00:00Z"),
  };
  const store = path.join(home, ".ai-orchestrator", "transcripts", "claude");
  const middle = path.join(home, "intermediate-link");
  const kind = options.host ?? "chain";
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  if (kind === "chain") {
    write(path.join(store, "-work-app", "u1.jsonl"), "{}\n");
    fs.symlinkSync(store, middle);
    fs.symlinkSync("../intermediate-link", path.join(home, ".claude", "projects"));
  } else if (kind === "direct") {
    write(path.join(store, "-work-app", "u1.jsonl"), "{}\n");
    fs.symlinkSync(store, path.join(home, ".claude", "projects"));
  } else if (kind === "dir") {
    write(path.join(home, ".claude", "projects", "-work-app", "u1.jsonl"), "{}\n");
  } else if (kind === "dangling") {
    fs.symlinkSync("/nowhere/at/all", path.join(home, ".claude", "projects"));
  }
  const repos = repositories(openDatabase(":memory:"));
  const settings = new SettingsService(
    env,
    repos.settings,
    new CoreEvents(),
    (id) => repos.accounts.get(id) !== undefined,
    (next) => accounts.assertCanUseAccounts(next),
  );
  const accounts = new AccountService({
    env,
    repo: repos.accounts,
    db: repos.sqlite,
    settings,
    docker: new MemoryDocker(),
    runningBoxes: () => [],
    sources: {
      claudeDir: path.join(home, ".claude"),
      claudeJson: path.join(home, ".claude.json"),
      codexDir: path.join(home, ".codex"),
      copilotDir: path.join(home, ".copilot"),
    },
    tempDirs: [],
  });
  return { home, env, store, middle, repos, settings, accounts };
}

/** A ready Claude folder whose `projects` link leads to a deleted scratch store. */
function scratchFolder(): string {
  const dir = path.join(tempDir("aio-ready-"), "claude");
  write(path.join(dir, ".credentials.json"), "x");
  fs.symlinkSync("/tmp/aio-gone-scratch/projects", path.join(dir, "projects"));
  return dir;
}

describe("resolveStore", () => {
  it("uses the setting, else DATA_DIR/transcripts/claude", () => {
    const s = setup({ host: "chain" });
    expect(resolveStore(s.env, "/custom/store")).toEqual({
      root: "/custom/store",
      source: "setting",
    });
    expect(resolveStore(s.env)).toEqual({ root: s.store, source: "data" });
  });

  it("ignores the host's ~/.claude/projects, whatever it is", () => {
    for (const host of ["chain", "direct", "dir", "dangling", "none"] as const) {
      const s = setup({ host });
      expect(resolveStore(s.env)).toEqual({
        root: path.join(s.env.dataDir as string, "transcripts", "claude"),
        source: "data",
      });
    }
  });
});

describe("linkProjectsToStore", () => {
  it("creates, replaces a dangling or foreign link, and leaves a good one", () => {
    const s = setup();
    const store = tempDir("aio-the-store-");
    const dir = tempDir("aio-acct-");
    expect(projectsLinkState(dir, store)).toBe("missing");
    expect(linkProjectsToStore(dir, store)).toBe("created");
    expect(linkProjectsToStore(dir, store)).toBe("unchanged");
    fs.unlinkSync(path.join(dir, "projects"));
    fs.symlinkSync("/nowhere/at/all", path.join(dir, "projects"));
    expect(projectsLinkState(dir, store)).toBe("dangling");
    expect(linkProjectsToStore(dir, store)).toBe("replaced");
    const other = tempDir("aio-other-");
    fs.unlinkSync(path.join(dir, "projects"));
    fs.symlinkSync(other, path.join(dir, "projects"));
    expect(projectsLinkState(dir, store)).toBe("foreign");
    write(path.join(other, "keep.txt"), "x");
    expect(linkProjectsToStore(dir, store)).toBe("replaced");
    // Only the link changed; the old target keeps its files.
    expect(fs.existsSync(path.join(other, "keep.txt"))).toBe(true);
    expect(fs.realpathSync(path.join(dir, "projects"))).toBe(fs.realpathSync(store));
    void s;
  });

  it("keeps a real projects folder that holds transcripts, and replaces an empty one", () => {
    const store = tempDir("aio-the-store-");
    const dir = tempDir("aio-acct-");
    write(path.join(dir, "projects", "-a", "u.jsonl"), "{}\n");
    expect(linkProjectsToStore(dir, store)).toBe("kept-directory");
    expect(fs.lstatSync(path.join(dir, "projects")).isDirectory()).toBe(true);
    const empty = tempDir("aio-acct-");
    fs.mkdirSync(path.join(empty, "projects"));
    expect(linkProjectsToStore(empty, store)).toBe("replaced");
  });
});

describe("the blocker: a dangling projects link on import", () => {
  it("links an imported account to the store, resolving the host's chain", async () => {
    const s = setup({ host: "chain" });
    const r = await s.accounts.importFolder({
      vendor: "claude",
      name: "personal",
      from: scratchFolder(),
    });
    const link = path.join(r.dir, "projects");
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(s.store));
    expect(fs.existsSync(path.join(link, "-work-app", "u1.jsonl"))).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/Replaced the projects link/);
  });

  it("creates the store when it doesn't exist", async () => {
    const s = setup({ host: "none" });
    const r = await s.accounts.importFolder({
      vendor: "claude",
      name: "personal",
      from: scratchFolder(),
    });
    expect(fs.realpathSync(path.join(r.dir, "projects"))).toBe(fs.realpathSync(s.store));
  });

  it("links a created account and a seeded account to the store", async () => {
    const s = setup({ host: "chain" });
    write(path.join(s.home, ".claude", "settings.json"), "{}");
    const created = s.accounts.create({ vendor: "claude", name: "work" });
    expect(fs.realpathSync(path.join(created.dir, "projects"))).toBe(fs.realpathSync(s.store));
    await s.accounts.seed({ vendors: ["claude"], name: "personal" });
    const seeded = s.accounts.dirOf("claude", "personal");
    expect(fs.realpathSync(path.join(seeded, "projects"))).toBe(fs.realpathSync(s.store));
    // The seed never links to the host's folder or copies its transcripts.
    expect(fs.readlinkSync(path.join(seeded, "projects"))).toBe(s.store);
  });

  it("links a seeded account to the store when the host's projects is a real folder", async () => {
    const s = setup({ host: "dir" });
    write(path.join(s.home, ".claude", "settings.json"), "{}");
    await s.accounts.seed({ vendors: ["claude"], name: "personal" });
    const link = path.join(s.accounts.dirOf("claude", "personal"), "projects");
    expect(fs.readlinkSync(link)).toBe(s.store);
  });

  it("replaces a dangling link that a seed would have copied from the host", async () => {
    const s = setup({ host: "dangling" });
    write(path.join(s.home, ".claude", "settings.json"), "{}");
    await s.accounts.seed({ vendors: ["claude"], name: "personal" });
    const link = path.join(s.accounts.dirOf("claude", "personal"), "projects");
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(s.store));
  });
});

describe("check warning and relink", () => {
  it("warns about a dangling link and relink repairs it", async () => {
    const s = setup({ host: "chain" });
    const created = s.accounts.create({ vendor: "claude", name: "work" });
    const link = path.join(created.dir, "projects");
    fs.unlinkSync(link);
    fs.symlinkSync("/tmp/aio-gone-scratch/projects", link);
    const view = s.accounts.view(s.accounts.get("claude/work"));
    expect(view.warnings?.join(" ")).toMatch(/doesn't exist/);
    expect(view.warnings?.join(" ")).toMatch(/accounts relink/);
    const r = s.accounts.relink();
    expect(r.source).toBe("data");
    expect(r.accounts[0]).toMatchObject({
      id: "claude/work",
      before: "dangling",
      outcome: "replaced",
    });
    expect(s.accounts.view(s.accounts.get("claude/work")).warnings).toBeUndefined();
    expect(s.accounts.relink().accounts[0]).toMatchObject({ before: "ok", outcome: "unchanged" });
  });

  it("counts a link that reaches the store through other links as correct", () => {
    const s = setup({ host: "chain" });
    const created = s.accounts.create({ vendor: "claude", name: "work" });
    const link = path.join(created.dir, "projects");
    fs.unlinkSync(link);
    fs.symlinkSync(s.middle, link);
    expect(projectsLinkState(created.dir, s.store)).toBe("ok");
    expect(s.accounts.view(s.accounts.get("claude/work")).warnings).toBeUndefined();
    expect(s.accounts.relink().accounts[0]).toMatchObject({ before: "ok", outcome: "unchanged" });
  });

  it("warns about a link that leads to a different store", () => {
    const s = setup({ host: "chain" });
    const created = s.accounts.create({ vendor: "claude", name: "work" });
    const link = path.join(created.dir, "projects");
    fs.unlinkSync(link);
    fs.symlinkSync(tempDir("aio-elsewhere-"), link);
    expect(s.accounts.view(s.accounts.get("claude/work")).warnings?.join(" ")).toMatch(
      /doesn't lead to the transcript store/,
    );
  });
});

describe("switching to accounts mode", () => {
  it("requires adoption of host transcripts before switching", () => {
    const s = setup({ host: "dir" });
    s.accounts.create({ vendor: "claude", name: "work" });
    expect(() => s.settings.patch({ accountsMode: "accounts" })).toThrow(/transcripts adopt/);
    s.accounts.adoptTranscripts({});
    expect(s.settings.patch({ accountsMode: "accounts" }).accountsMode).toBe("accounts");
  });

  it("requires relink when the transcriptStore override changes", () => {
    const s = setup({ host: "chain" });
    s.accounts.create({ vendor: "claude", name: "work" });
    s.settings.patch({ transcriptStore: tempDir("aio-override-") });
    expect(() => s.settings.patch({ accountsMode: "accounts" })).toThrow(/accounts relink/);
  });

  it("passes when the host's chain ends at the store", () => {
    for (const host of ["chain", "direct"] as const) {
      const s = setup({ host });
      s.accounts.create({ vendor: "claude", name: "work" });
      expect(s.settings.patch({ accountsMode: "accounts" }).accountsMode).toBe("accounts");
    }
  });

  it("refuses while an account's projects link dangles, and passes after relink", () => {
    const s = setup({ host: "chain" });
    const created = s.accounts.create({ vendor: "claude", name: "work" });
    const link = path.join(created.dir, "projects");
    fs.unlinkSync(link);
    fs.symlinkSync("/tmp/aio-gone-scratch/projects", link);
    expect(() => s.settings.patch({ accountsMode: "accounts" })).toThrow(/accounts relink/);
    s.accounts.relink();
    expect(s.settings.patch({ accountsMode: "accounts" }).accountsMode).toBe("accounts");
  });

  it("allows the switch on a host with no projects folder", () => {
    const s = setup({ host: "none" });
    s.accounts.create({ vendor: "claude", name: "work" });
    expect(s.settings.patch({ accountsMode: "accounts" }).accountsMode).toBe("accounts");
  });
});
