// Accounts and seeding, against synthetic host folders in a temporary
// directory. Every path is passed explicitly; nothing reads the real home.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AccountService } from "../../src/accounts/service.js";
import {
  COPILOT_SIGN_IN_FILES,
  addCodexFileStore,
  copyTree,
  linkTargetForCopy,
  seedFolder,
  type SeedSources,
} from "../../src/accounts/seed.js";
import { parseSignInStatus } from "../../src/accounts/service.js";
import { openDatabase, repositories } from "../../src/db/index.js";
import { MemoryDocker } from "../../src/docker/memory.js";
import type { HostEnv } from "../../src/records/env.js";
import { CoreEvents } from "../../src/records/events.js";
import { SettingsService } from "../../src/records/settings.js";
import { UsageStore } from "../../src/usage/usage-store.js";
import { tempDir } from "../tmp.js";

const SECRET = "SECRET-TOKEN-VALUE-never-copied";

function write(file: string, content: string, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
}

/** Synthetic host folders: `~/.claude` (with a shared projects link), `~/.claude.json`, `~/.codex`, `~/.copilot`. */
function hostFolders(options: { projectsDir?: boolean } = {}): SeedSources & { root: string } {
  const root = tempDir("aio-acct-host-");
  const claudeDir = path.join(root, ".claude");
  write(path.join(claudeDir, ".credentials.json"), SECRET);
  write(path.join(claudeDir, ".claude.json"), '{"stale":true}');
  write(path.join(claudeDir, "settings.json"), '{"model":"opus"}');
  write(path.join(claudeDir, "CLAUDE.md"), "# Global\n");
  write(path.join(claudeDir, "skills", "one", "SKILL.md"), "skill\n", 0o644);
  fs.symlinkSync("skills/one", path.join(claudeDir, "current-skill"));
  const store = path.join(root, "legacy-projects");
  write(path.join(store, "-work-app", "u1.jsonl"), "{}\n");
  if (options.projectsDir) {
    write(path.join(claudeDir, "projects", "-work-app", "u2.jsonl"), "{}\n");
  } else {
    fs.symlinkSync("../legacy-projects", path.join(claudeDir, "projects"));
  }
  const claudeJson = path.join(root, ".claude.json");
  write(claudeJson, '{"fresh":true}');
  const codexDir = path.join(root, ".codex");
  write(path.join(codexDir, "auth.json"), SECRET);
  write(path.join(codexDir, "config.toml"), 'model = "o3"\n\n[profiles.x]\nmodel = "y"\n');
  write(path.join(codexDir, "sessions", "2026", "r.jsonl"), "{}\n");
  const copilotDir = path.join(root, ".copilot");
  write(path.join(copilotDir, "config.json"), "{}");
  write(path.join(copilotDir, "session-store.db"), "db");
  for (const name of COPILOT_SIGN_IN_FILES) {
    write(path.join(copilotDir, name), SECRET);
  }
  return { root, claudeDir, claudeJson, codexDir, copilotDir };
}

/** Every file under `dir`, links not followed, as relative paths. */
function listTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      out.push(r);
      if (fs.lstatSync(p).isDirectory()) walk(p, r);
    }
  };
  walk(dir, "");
  return out;
}

/** Whether any file under `dir` holds the secret marker. */
function holdsSecret(dir: string): boolean {
  return listTree(dir).some((rel) => {
    const p = path.join(dir, rel);
    return fs.lstatSync(p).isFile() && fs.readFileSync(p, "utf8").includes(SECRET);
  });
}

function setup(options: { running?: string[]; projectsDir?: boolean } = {}) {
  // The synthetic host is the env's home, so the host's transcript store is
  // the one that the synthetic `~/.claude/projects` leads to.
  const sources = hostFolders({ projectsDir: options.projectsDir });
  const home = sources.root;
  const env: HostEnv = {
    home,
    dataDir: path.join(home, "data"),
    user: "tester",
    now: () => new Date("2026-10-31T09:00:00Z"),
  };
  const repos = repositories(openDatabase(":memory:"));
  const settings = new SettingsService(
    env,
    repos.settings,
    new CoreEvents(),
    (id) => repos.accounts.get(id) !== undefined,
  );
  const docker = new MemoryDocker();
  const accounts = new AccountService({
    env,
    repo: repos.accounts,
    db: repos.sqlite,
    settings,
    docker,
    runningBoxes: () => options.running ?? [],
    sources,
    tempDirs: [],
  });
  return { env, repos, settings, docker, sources, accounts };
}

describe("copyTree", () => {
  it("copies files with their modes, keeps links as links, and leaves out named paths", async () => {
    const src = tempDir("aio-copy-src-");
    write(path.join(src, "a.txt"), "a", 0o640);
    write(path.join(src, "keep", "b.txt"), "bb", 0o600);
    write(path.join(src, "secret.json"), SECRET);
    fs.symlinkSync("/nowhere/at/all", path.join(src, "dangling"));
    const dest = path.join(tempDir("aio-copy-dst-"), "out");
    const stats = await copyTree(src, dest, { leaveOut: new Set(["secret.json"]) });
    expect(stats).toMatchObject({ files: 2, bytes: 3, symlinks: 1, leftOut: ["secret.json"] });
    expect(listTree(dest)).toEqual(["a.txt", "dangling", "keep", "keep/b.txt"]);
    expect(fs.statSync(path.join(dest, "a.txt")).mode & 0o777).toBe(0o640);
    expect(fs.readlinkSync(path.join(dest, "dangling"))).toBe("/nowhere/at/all");
  });

  it("writes nothing on a dry run", async () => {
    const src = tempDir("aio-copy-src-");
    write(path.join(src, "a.txt"), "a");
    const dest = path.join(tempDir("aio-copy-dst-"), "out");
    const stats = await copyTree(src, dest, { dryRun: true });
    expect(stats.files).toBe(1);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("makes a relative link that leaves the tree absolute, and keeps one inside relative", () => {
    expect(linkTargetForCopy("/h/.claude", "/h/.claude/projects", "../store")).toBe("/h/store");
    expect(linkTargetForCopy("/h/.claude", "/h/.claude/cur", "skills/one")).toBe("skills/one");
    expect(linkTargetForCopy("/h/.claude", "/h/.claude/x", "/abs")).toBe("/abs");
  });
});

describe("addCodexFileStore", () => {
  it("puts the setting before the first table, once", async () => {
    const file = path.join(tempDir("aio-codex-"), "config.toml");
    write(file, '[profiles.x]\nmodel = "y"\n');
    expect(await addCodexFileStore(file)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe(
      'cli_auth_credentials_store = "file"\n[profiles.x]\nmodel = "y"\n',
    );
    expect(await addCodexFileStore(file)).toBe(false);
  });

  it("replaces a symbolic link with a regular file and leaves its target alone", async () => {
    const dir = tempDir("aio-codex-");
    const dotfile = path.join(dir, "dotfiles", "config.toml");
    write(dotfile, 'model = "SYNTHETIC"\n', 0o644);
    const file = path.join(dir, "config.toml");
    fs.symlinkSync(dotfile, file);
    expect(await addCodexFileStore(file)).toBe(true);
    expect(fs.readFileSync(dotfile, "utf8")).toBe('model = "SYNTHETIC"\n');
    const st = fs.lstatSync(file);
    expect(st.isFile()).toBe(true);
    expect(st.mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, "utf8")).toBe(
      'cli_auth_credentials_store = "file"\nmodel = "SYNTHETIC"\n',
    );
  });

  it("keeps a store setting the user chose", async () => {
    const file = path.join(tempDir("aio-codex-"), "config.toml");
    write(file, 'cli_auth_credentials_store = "keyring"\n');
    expect(await addCodexFileStore(file)).toBe(false);
  });
});

describe("seedFolder", () => {
  it("leaves projects out instead of copying transcripts or linking to the host's folder", async () => {
    const sources = hostFolders({ projectsDir: true });
    const dest = path.join(tempDir("aio-seed-"), "claude", "personal");
    const r = await seedFolder("claude", sources, dest);
    expect(fs.existsSync(path.join(dest, "projects"))).toBe(false);
    expect(fs.lstatSync(path.join(dest, "projects"), { throwIfNoEntry: false })).toBeUndefined();
    expect(r.leftOut).toEqual([".credentials.json"]);
  });

  it("removes its temporary folder when the copy fails", async () => {
    const sources = hostFolders();
    const parent = tempDir("aio-seed-");
    const dest = path.join(parent, "codex", "personal");
    await expect(
      seedFolder("codex", { ...sources, codexDir: path.join(sources.root, "missing") }, dest),
    ).rejects.toThrow();
    expect(fs.readdirSync(path.dirname(dest))).toEqual([]);
  });
});

describe("AccountService.seed", () => {
  it("copies every vendor's folder without its sign-in files", async () => {
    const { accounts, env } = setup();
    const report = await accounts.seed({});
    expect(report.accounts.map((a) => [a.id, a.status])).toEqual([
      ["claude/personal", "seeded"],
      ["codex/personal", "seeded"],
      ["copilot/personal", "seeded"],
    ]);
    const claude = accounts.dirOf("claude", "personal");
    const codex = accounts.dirOf("codex", "personal");
    const copilot = accounts.dirOf("copilot", "personal");
    expect(claude).toBe(path.join(env.dataDir!, "accounts", "claude", "personal"));
    for (const dir of [claude, codex, copilot]) {
      expect(holdsSecret(dir)).toBe(false);
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    }
    expect(fs.existsSync(path.join(claude, ".credentials.json"))).toBe(false);
    expect(fs.existsSync(path.join(codex, "auth.json"))).toBe(false);
    for (const name of COPILOT_SIGN_IN_FILES) {
      expect(fs.existsSync(path.join(copilot, name))).toBe(false);
    }
    expect(report.accounts[0]!.leftOut).toEqual([".credentials.json"]);
    expect(report.accounts[1]!.leftOut).toEqual(["auth.json"]);
    expect([...report.accounts[2]!.leftOut].sort()).toEqual([...COPILOT_SIGN_IN_FILES].sort());
    // Settings, skills, and sessions came across.
    expect(fs.readFileSync(path.join(claude, "skills", "one", "SKILL.md"), "utf8")).toBe("skill\n");
    expect(fs.existsSync(path.join(codex, "sessions", "2026", "r.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(copilot, "session-store.db"))).toBe(true);
  });

  it("replaces the stale .claude.json with the host's ~/.claude.json", async () => {
    const { accounts } = setup();
    await accounts.seed({ vendors: ["claude"] });
    const dir = accounts.dirOf("claude", "personal");
    expect(JSON.parse(fs.readFileSync(path.join(dir, ".claude.json"), "utf8"))).toEqual({
      fresh: true,
      installMethod: "global",
    });
  });

  it("leaves the /login API key out of the copied .claude.json", async () => {
    const { accounts, sources } = setup();
    write(sources.claudeJson, '{"fresh":true,"primaryApiKey":"SYNTHETIC_KEY"}');
    await accounts.seed({ vendors: ["claude"] });
    const copy = path.join(accounts.dirOf("claude", "personal"), ".claude.json");
    const text = fs.readFileSync(copy, "utf8");
    expect(text).not.toContain("SYNTHETIC_KEY");
    expect(JSON.parse(text)).toEqual({ fresh: true, installMethod: "global" });
    expect(fs.statSync(copy).mode & 0o777).toBe(0o600);
    // The host's own file keeps its key.
    expect(fs.readFileSync(sources.claudeJson, "utf8")).toContain("SYNTHETIC_KEY");
  });

  it("leaves .claude.json backups out of the copy", async () => {
    const { accounts, sources } = setup();
    write(sources.claudeJson, '{"fresh":true}');
    const backup = path.join(sources.claudeDir, "backups", ".claude.json.backup.1");
    write(backup, '{"primaryApiKey":"SYNTHETIC_KEY"}');
    await accounts.seed({ vendors: ["claude"] });
    const dir = accounts.dirOf("claude", "personal");
    expect(fs.existsSync(path.join(dir, "backups", ".claude.json.backup.1"))).toBe(false);
    expect(fs.existsSync(backup)).toBe(true);
  });

  it("drops a .claude.json that isn't JSON rather than copying it unchecked", async () => {
    const { accounts, sources } = setup();
    write(sources.claudeJson, '{"primaryApiKey":"SYNTHETIC_KEY"');
    await accounts.seed({ vendors: ["claude"] });
    const copy = path.join(accounts.dirOf("claude", "personal"), ".claude.json");
    // The unchecked file is gone; the first-start step writes a fresh one.
    expect(fs.readFileSync(copy, "utf8")).not.toContain("SYNTHETIC_KEY");
    expect(JSON.parse(fs.readFileSync(copy, "utf8"))).toEqual({ installMethod: "global" });
  });

  it("links projects to the shared store", async () => {
    const { accounts, env } = setup();
    await accounts.seed({ vendors: ["claude"] });
    const link = path.join(accounts.dirOf("claude", "personal"), "projects");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(link)).toBe(path.join(env.dataDir!, "transcripts", "claude"));
    // An inner relative link still points inside the copy.
    const inner = path.join(accounts.dirOf("claude", "personal"), "current-skill");
    expect(fs.readlinkSync(inner)).toBe("skills/one");
  });

  it("keeps the Codex sign-in in a file", async () => {
    const { accounts } = setup();
    await accounts.seed({ vendors: ["codex"] });
    const toml = fs.readFileSync(
      path.join(accounts.dirOf("codex", "personal"), "config.toml"),
      "utf8",
    );
    expect(toml.startsWith('cli_auth_credentials_store = "file"\nmodel = "o3"\n')).toBe(true);
  });

  it("never writes through a symlinked Codex config.toml into the host's file", async () => {
    const { accounts, sources } = setup();
    const hostToml = path.join(sources.codexDir, "config.toml");
    const dotfile = path.join(sources.root, "dotfiles", "config.toml");
    write(dotfile, 'model = "SYNTHETIC"\n', 0o644);
    fs.rmSync(hostToml);
    fs.symlinkSync(dotfile, hostToml);
    await accounts.seed({ vendors: ["codex"] });
    expect(fs.readFileSync(dotfile, "utf8")).toBe('model = "SYNTHETIC"\n');
    const copy = path.join(accounts.dirOf("codex", "personal"), "config.toml");
    expect(fs.lstatSync(copy).isFile()).toBe(true);
    expect(fs.readFileSync(copy, "utf8")).toBe(
      'cli_auth_credentials_store = "file"\nmodel = "SYNTHETIC"\n',
    );
  });

  it("records each account as not signed in and makes it the default", async () => {
    const { accounts, settings, sources } = setup();
    await accounts.seed({});
    const views = accounts.list();
    expect(views.map((v) => v.account.id)).toEqual([
      "claude/personal",
      "codex/personal",
      "copilot/personal",
    ]);
    for (const v of views) {
      expect(v.account.signIn).toEqual({ state: "not_signed_in" });
      expect(v.isDefault).toBe(true);
      expect(v.dirExists).toBe(true);
    }
    expect(views[0]!.account.seededFrom).toBe(sources.claudeDir);
    expect(settings.get().accountDefaults).toEqual({
      claude: "claude/personal",
      codex: "codex/personal",
      copilot: "copilot/personal",
    });
  });

  it("relabels the legacy usage samples with the account id", async () => {
    const { accounts, repos } = setup();
    const usage = new UsageStore(repos.sqlite);
    const sample = (vendor: "claude" | "codex", account: string) => ({
      vendor,
      account,
      window: "5h" as const,
      utilization: 0.2,
      spendUsd: null,
      ceiling: { kind: "utilization" as const, window: "5h" as const, max: 0.6 },
      resetAt: null,
      sampleSource: "rate_limit_event" as const,
      time: "2026-10-30T09:00:00Z",
    });
    usage.record(sample("claude", "person@example.com"));
    usage.record(sample("claude", "claude/other"));
    usage.record(sample("codex", "codex-default"));
    const report = await accounts.seed({ vendors: ["claude"] });
    expect(report.accounts[0]!.usageRelabeled).toBe(1);
    expect(usage.accounts("claude")).toEqual(["claude/other", "claude/personal"]);
    expect(usage.samples({ vendor: "claude" }).map((s) => s.account)).toEqual([
      "claude/personal",
      "claude/other",
    ]);
    expect(usage.accounts("codex")).toEqual(["codex-default"]);
  });

  it("refuses while a box runs, and copies nothing", async () => {
    const { accounts } = setup({ running: ["aio-agent-app"] });
    await expect(accounts.seed({})).rejects.toMatchObject({ code: "box_running" });
    expect(fs.existsSync(accounts.dirOf("claude", "personal"))).toBe(false);
  });

  it("refuses when an account folder exists, and leaves it untouched", async () => {
    const { accounts } = setup();
    const dir = accounts.dirOf("codex", "personal");
    write(path.join(dir, "mine.txt"), "mine");
    await expect(accounts.seed({})).rejects.toMatchObject({ code: "conflict" });
    expect(listTree(dir)).toEqual(["mine.txt"]);
    expect(fs.existsSync(accounts.dirOf("claude", "personal"))).toBe(false);
  });

  it("refuses a second seed of the same account", async () => {
    const { accounts } = setup();
    await accounts.seed({ vendors: ["copilot"] });
    await expect(accounts.seed({ vendors: ["copilot"] })).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("reports a dry run and writes nothing", async () => {
    const { accounts, settings, env } = setup();
    const report = await accounts.seed({ dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.accounts.map((a) => a.status)).toEqual([
      "would_seed",
      "would_seed",
      "would_seed",
    ]);
    expect(report.accounts[0]!.madeDefault).toBe(true);
    expect(fs.existsSync(path.join(env.dataDir!, "accounts"))).toBe(false);
    expect(accounts.list()).toEqual([]);
    expect(settings.get().accountDefaults).toEqual({});
  });

  it("skips a vendor whose host folder doesn't exist", async () => {
    const { accounts, sources } = setup();
    fs.rmSync(sources.copilotDir, { recursive: true });
    const report = await accounts.seed({});
    expect(report.accounts[2]).toMatchObject({ status: "skipped", id: "copilot/personal" });
    expect(accounts.list().map((v) => v.account.id)).toEqual(["claude/personal", "codex/personal"]);
  });

  it("never logs a file's content", async () => {
    const { accounts } = setup();
    const lines: string[] = [];
    await accounts.seed({}, (l) => lines.push(l));
    expect(lines.join("")).not.toContain(SECRET);
    expect(lines.join("")).toContain("Left out the sign-in files: .credentials.json");
  });
});

describe("AccountService records", () => {
  it("creates an empty folder, the first of a vendor as its default", () => {
    const { accounts, settings } = setup();
    const v = accounts.create({ vendor: "claude", name: "work", label: "Work (Pro)" });
    expect(v).toMatchObject({ isDefault: true, dirExists: true });
    expect(fs.readdirSync(v.dir)).toEqual(
      expect.arrayContaining([".claude.json", "projects", "settings.json"]),
    );
    expect(fs.statSync(v.dir).mode & 0o777).toBe(0o700);
    const second = accounts.create({ vendor: "claude", name: "home" });
    expect(second.isDefault).toBe(false);
    expect(second.account.label).toBe("home");
    expect(settings.get().accountDefaults.claude).toBe("claude/work");
  });

  it("gives a new Codex account a file sign-in store", () => {
    const { accounts } = setup();
    const v = accounts.create({ vendor: "codex", name: "work" });
    expect(fs.readFileSync(path.join(v.dir, "config.toml"), "utf8")).toBe(
      'cli_auth_credentials_store = "file"\n',
    );
  });

  it("refuses an existing folder", () => {
    const { accounts } = setup();
    fs.mkdirSync(accounts.dirOf("claude", "work"), { recursive: true });
    expect(() => accounts.create({ vendor: "claude", name: "work" })).toThrow(/exists/);
  });

  it("updates the label and clears the ceiling", () => {
    const { accounts } = setup();
    accounts.create({
      vendor: "codex",
      name: "work",
      ceiling: { kind: "utilization", window: "5h", max: 0.5 },
    });
    const v = accounts.update("codex/work", { label: "Work", ceiling: null, overflow: true });
    expect(v.account).toMatchObject({ label: "Work", overflow: true });
    expect(v.account.ceiling).toBeUndefined();
  });

  it("removes the record, keeps the folder, and refuses the default", () => {
    const { accounts } = setup();
    const first = accounts.create({ vendor: "claude", name: "work" });
    const second = accounts.create({ vendor: "claude", name: "home" });
    expect(() => accounts.remove("claude/work")).toThrow(/default/);
    expect(accounts.remove("claude/home")).toEqual({ keptDir: second.dir });
    expect(fs.existsSync(second.dir)).toBe(true);
    expect(() => accounts.get("claude/home")).toThrow(/No account/);
    expect(first.isDefault).toBe(true);
  });

  it("lets the settings name only existing accounts as defaults", () => {
    const { accounts, settings } = setup();
    accounts.create({ vendor: "claude", name: "work" });
    accounts.create({ vendor: "claude", name: "home" });
    expect(() => settings.patch({ accountDefaults: { claude: "claude/none" } })).toThrow(
      /No account/,
    );
    settings.patch({ accountDefaults: { claude: "claude/home" }, accountsMode: "host" });
    expect(settings.get().accountDefaults.claude).toBe("claude/home");
    settings.patch({ accountDefaults: { claude: null } });
    expect(settings.get().accountDefaults.claude).toBeUndefined();
  });
});

describe("AccountService.check", () => {
  it("runs the status command with the account folder and stores the answer", async () => {
    const { accounts, docker } = setup();
    docker.images.set("aio-agent", {
      id: "sha256:img",
      created: "2026-10-31T00:00:00Z",
      labels: {},
    });
    docker.runOnceAnswers.set("claude auth status", {
      exitCode: 0,
      stdout: '{"loggedIn":true,"email":"person@example.com"}',
      stderr: "",
    });
    const v = accounts.create({ vendor: "claude", name: "work" });
    const checked = await accounts.check("claude/work");
    expect(checked.account.signIn).toEqual({
      state: "signed_in",
      identity: "person@example.com",
      checkedAt: "2026-10-31T09:00:00.000Z",
    });
    const call = docker.callsOf("runOnce")[0]!.args[0] as {
      binds: string[];
      env: string[];
      user: string;
    };
    expect(call.binds).toEqual([`${v.dir}:${v.dir}`]);
    expect(call.env).toContain(`CLAUDE_CONFIG_DIR=${v.dir}`);
    expect(call.user).toBe("tester");
  });

  it("reports a missing image", async () => {
    const { accounts } = setup();
    accounts.create({ vendor: "codex", name: "work" });
    await expect(accounts.check("codex/work")).rejects.toMatchObject({ code: "image_missing" });
  });

  it("leaves Copilot unknown without running anything", async () => {
    const { accounts, docker } = setup();
    accounts.create({ vendor: "copilot", name: "work" });
    const v = await accounts.check("copilot/work");
    expect(v.account.signIn.state).toBe("unknown");
    expect(docker.callsOf("runOnce")).toEqual([]);
  });

  it("parses each CLI's status output", () => {
    const r = (stdout: string, exitCode = 0) => ({ exitCode, stdout, stderr: "" });
    expect(parseSignInStatus("claude", r('{"loggedIn":false}', 1))).toEqual({
      state: "not_signed_in",
    });
    expect(parseSignInStatus("claude", r("garbage"))).toEqual({ state: "unknown" });
    expect(parseSignInStatus("codex", r("Not logged in", 1))).toEqual({ state: "not_signed_in" });
    expect(parseSignInStatus("codex", r("Logged in using ChatGPT"))).toEqual({
      state: "signed_in",
    });
  });
});
