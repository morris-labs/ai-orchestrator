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
  /** The host's store: `link` (like the maintainer's), `dir`, `dangling`, or `none`. */
  host?: "link" | "dir" | "dangling" | "none";
}

function setup(options: Options = {}) {
  const home = tempDir("agentbox-store-home-");
  const env: HostEnv = {
    home,
    dataDir: path.join(home, ".claude-box"),
    user: "tester",
    now: () => new Date("2026-10-31T09:00:00Z"),
  };
  const shared = path.join(home, ".claude-projects-shared");
  const kind = options.host ?? "link";
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  if (kind === "link") {
    write(path.join(shared, "-work-app", "u1.jsonl"), "{}\n");
    fs.symlinkSync("../.claude-projects-shared", path.join(home, ".claude", "projects"));
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
  return { home, env, shared, repos, settings, accounts };
}

/** A ready Claude folder whose `projects` link leads to a deleted scratch store. */
function scratchFolder(): string {
  const dir = path.join(tempDir("agentbox-ready-"), "claude");
  write(path.join(dir, ".credentials.json"), "x");
  fs.symlinkSync("/tmp/agentbox-gone-scratch/projects", path.join(dir, "projects"));
  return dir;
}

describe("resolveStore", () => {
  it("prefers the setting, then the host's link, then the host's folder", () => {
    const linked = setup({ host: "link" });
    expect(resolveStore(linked.env, undefined, "/custom/store")).toEqual({
      root: "/custom/store",
      source: "setting",
    });
    expect(resolveStore(linked.env, undefined)).toEqual({
      root: fs.realpathSync(linked.shared),
      source: "host",
    });
    const plain = setup({ host: "dir" });
    expect(resolveStore(plain.env, undefined)).toEqual({
      root: fs.realpathSync(path.join(plain.home, ".claude", "projects")),
      source: "host",
    });
  });

  it("falls back to the data directory only when the host has no store", () => {
    for (const host of ["none", "dangling"] as const) {
      const s = setup({ host });
      expect(resolveStore(s.env, undefined)).toEqual({
        root: path.join(s.env.dataDir as string, "transcripts", "claude"),
        source: "data",
      });
    }
  });

  it("uses the default account's link when the host has none, never over the host's store", () => {
    const none = setup({ host: "none" });
    const store = tempDir("agentbox-acct-store-");
    const dir = path.join(none.env.dataDir as string, "accounts", "claude", "work");
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(store, path.join(dir, "projects"));
    expect(resolveStore(none.env, "claude/work").source).toBe("account");
    const linked = setup({ host: "link" });
    const dir2 = path.join(linked.env.dataDir as string, "accounts", "claude", "work");
    fs.mkdirSync(dir2, { recursive: true });
    fs.symlinkSync(store, path.join(dir2, "projects"));
    expect(resolveStore(linked.env, "claude/work").source).toBe("host");
  });
});

describe("linkProjectsToStore", () => {
  it("creates, replaces a dangling or foreign link, and leaves a good one", () => {
    const s = setup();
    const store = tempDir("agentbox-the-store-");
    const dir = tempDir("agentbox-acct-");
    expect(projectsLinkState(dir, store)).toBe("missing");
    expect(linkProjectsToStore(dir, store)).toBe("created");
    expect(linkProjectsToStore(dir, store)).toBe("unchanged");
    fs.unlinkSync(path.join(dir, "projects"));
    fs.symlinkSync("/nowhere/at/all", path.join(dir, "projects"));
    expect(projectsLinkState(dir, store)).toBe("dangling");
    expect(linkProjectsToStore(dir, store)).toBe("replaced");
    const other = tempDir("agentbox-other-");
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
    const store = tempDir("agentbox-the-store-");
    const dir = tempDir("agentbox-acct-");
    write(path.join(dir, "projects", "-a", "u.jsonl"), "{}\n");
    expect(linkProjectsToStore(dir, store)).toBe("kept-directory");
    expect(fs.lstatSync(path.join(dir, "projects")).isDirectory()).toBe(true);
    const empty = tempDir("agentbox-acct-");
    fs.mkdirSync(path.join(empty, "projects"));
    expect(linkProjectsToStore(empty, store)).toBe("replaced");
  });
});

describe("the blocker: a dangling projects link on import", () => {
  it("links an imported account to the host's store, not to an empty one", async () => {
    const s = setup({ host: "link" });
    const r = await s.accounts.importFolder({
      vendor: "claude",
      name: "personal",
      from: scratchFolder(),
    });
    const link = path.join(r.dir, "projects");
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(s.shared));
    expect(fs.existsSync(path.join(link, "-work-app", "u1.jsonl"))).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/Replaced the projects link/);
    expect(fs.existsSync(path.join(s.env.dataDir as string, "transcripts"))).toBe(false);
    expect(r.warnings).toEqual(expect.not.arrayContaining([expect.stringContaining("empty")]));
  });

  it("uses the data directory's store only when the host has none", async () => {
    const s = setup({ host: "none" });
    const r = await s.accounts.importFolder({
      vendor: "claude",
      name: "personal",
      from: scratchFolder(),
    });
    expect(fs.realpathSync(path.join(r.dir, "projects"))).toBe(
      fs.realpathSync(path.join(s.env.dataDir as string, "transcripts", "claude")),
    );
  });

  it("links a created account and a seeded account to the host's store", async () => {
    const s = setup({ host: "link" });
    write(path.join(s.home, ".claude", "settings.json"), "{}");
    const created = s.accounts.create({ vendor: "claude", name: "work" });
    expect(fs.realpathSync(path.join(created.dir, "projects"))).toBe(fs.realpathSync(s.shared));
    await s.accounts.seed({ vendors: ["claude"], name: "personal" });
    const seeded = s.accounts.dirOf("claude", "personal");
    expect(fs.realpathSync(path.join(seeded, "projects"))).toBe(fs.realpathSync(s.shared));
  });

  it("replaces a dangling link that a seed copied from the host", async () => {
    const s = setup({ host: "dangling" });
    write(path.join(s.home, ".claude", "settings.json"), "{}");
    await s.accounts.seed({ vendors: ["claude"], name: "personal" });
    const link = path.join(s.accounts.dirOf("claude", "personal"), "projects");
    expect(fs.realpathSync(link)).toBe(
      fs.realpathSync(path.join(s.env.dataDir as string, "transcripts", "claude")),
    );
  });
});

describe("check warning and relink", () => {
  it("warns about a dangling link and relink repairs it", async () => {
    const s = setup({ host: "link" });
    const created = s.accounts.create({ vendor: "claude", name: "work" });
    const link = path.join(created.dir, "projects");
    fs.unlinkSync(link);
    fs.symlinkSync("/tmp/agentbox-gone-scratch/projects", link);
    const view = s.accounts.view(s.accounts.get("claude/work"));
    expect(view.warnings?.join(" ")).toMatch(/doesn't exist/);
    expect(view.warnings?.join(" ")).toMatch(/accounts relink/);
    const r = s.accounts.relink();
    expect(r.source).toBe("host");
    expect(r.accounts).toEqual([{ id: "claude/work", before: "dangling", outcome: "replaced" }]);
    expect(s.accounts.view(s.accounts.get("claude/work")).warnings).toBeUndefined();
    expect(s.accounts.relink().accounts[0]).toMatchObject({ before: "ok", outcome: "unchanged" });
  });

  it("warns about a link that leads to a different store", () => {
    const s = setup({ host: "link" });
    const created = s.accounts.create({ vendor: "claude", name: "work" });
    const link = path.join(created.dir, "projects");
    fs.unlinkSync(link);
    fs.symlinkSync(tempDir("agentbox-elsewhere-"), link);
    expect(s.accounts.view(s.accounts.get("claude/work")).warnings?.join(" ")).toMatch(
      /doesn't lead to the transcript store/,
    );
  });
});

describe("switching to accounts mode", () => {
  it("refuses an empty store while the host has transcripts", () => {
    const s = setup({ host: "link" });
    s.accounts.create({ vendor: "claude", name: "work" });
    const empty = tempDir("agentbox-empty-store-");
    expect(() => s.settings.patch({ transcriptStore: empty })).not.toThrow();
    expect(() => s.settings.patch({ accountsMode: "accounts" })).toThrow(/is empty/);
    expect(s.settings.get().accountsMode).toBe("host");
    s.settings.patch({ transcriptStore: null });
    // The account still links to the host's store, so the switch passes.
    expect(s.settings.patch({ accountsMode: "accounts" }).accountsMode).toBe("accounts");
  });

  it("refuses while an account's projects link dangles, and passes after relink", () => {
    const s = setup({ host: "link" });
    const created = s.accounts.create({ vendor: "claude", name: "work" });
    const link = path.join(created.dir, "projects");
    fs.unlinkSync(link);
    fs.symlinkSync("/tmp/agentbox-gone-scratch/projects", link);
    expect(() => s.settings.patch({ accountsMode: "accounts" })).toThrow(/accounts relink/);
    s.accounts.relink();
    expect(s.settings.patch({ accountsMode: "accounts" }).accountsMode).toBe("accounts");
  });

  it("allows the switch on a host with no store", () => {
    const s = setup({ host: "none" });
    s.accounts.create({ vendor: "claude", name: "work" });
    expect(s.settings.patch({ accountsMode: "accounts" }).accountsMode).toBe("accounts");
  });
});
