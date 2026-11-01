// Account import, the temporary-directory refusal, and the seed deny-list.
// Every path is synthetic and passed explicitly.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AccountService } from "../../src/accounts/service.js";
import { seedFolder, type SeedSources } from "../../src/accounts/seed.js";
import { openDatabase, repositories } from "../../src/db/index.js";
import { MemoryDocker } from "../../src/docker/memory.js";
import type { HostEnv } from "../../src/records/env.js";
import { CoreEvents } from "../../src/records/events.js";
import { SettingsService } from "../../src/records/settings.js";
import { tempDir } from "../tmp.js";

const SECRET = "SECRET-TOKEN-VALUE-never-copied";

function write(file: string, content: string, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
}

function setup(options: { dataDir?: string; tempDirs?: readonly string[] } = {}) {
  const home = tempDir("aio-imp-home-");
  const env: HostEnv = {
    home,
    dataDir: options.dataDir ?? path.join(home, "data"),
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
  const accounts = new AccountService({
    env,
    repo: repos.accounts,
    db: repos.sqlite,
    settings,
    docker: new MemoryDocker(),
    runningBoxes: () => [],
    tempDirs: options.tempDirs ?? [],
  });
  return { env, accounts };
}

function readyFolder(vendor: "claude" | "codex" | "copilot"): string {
  const dir = path.join(tempDir("aio-ready-"), vendor);
  const file =
    vendor === "claude" ? ".credentials.json" : vendor === "codex" ? "auth.json" : "config.json";
  write(path.join(dir, file), SECRET);
  return dir;
}

describe("accounts import", () => {
  it("moves a signed-in folder into place without reading the sign-in", async () => {
    const { accounts, env } = setup();
    const from = readyFolder("claude");
    const r = await accounts.importFolder({ vendor: "claude", name: "work", from });
    expect(r.mode).toBe("moved");
    expect(r.isDefault).toBe(true);
    expect(fs.existsSync(from)).toBe(false);
    expect(fs.readFileSync(path.join(r.dir, ".credentials.json"), "utf8")).toBe(SECRET);
    expect(r.dir).toBe(path.join(env.dataDir as string, "accounts", "claude", "work"));
    expect(fs.lstatSync(path.join(r.dir, "projects")).isSymbolicLink()).toBe(true);
    expect(fs.statSync(r.dir).mode & 0o777).toBe(0o700);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("copies with copy, keeps the original, and warns about the rotating token", async () => {
    const { accounts } = setup();
    const from = readyFolder("claude");
    const r = await accounts.importFolder({ vendor: "claude", name: "work", from, copy: true });
    expect(r.mode).toBe("copied");
    expect(fs.existsSync(path.join(from, ".credentials.json"))).toBe(true);
    expect(fs.existsSync(path.join(r.dir, ".credentials.json"))).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/rotates/);
  });

  it("adds the file store setting to a Codex folder and refuses an existing account", async () => {
    const { accounts } = setup();
    const r = await accounts.importFolder({
      vendor: "codex",
      name: "main",
      from: readyFolder("codex"),
    });
    expect(fs.readFileSync(path.join(r.dir, "config.toml"), "utf8")).toContain(
      'cli_auth_credentials_store = "file"',
    );
    await expect(
      accounts.importFolder({ vendor: "codex", name: "main", from: readyFolder("codex") }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses a missing or relative source", async () => {
    const { accounts } = setup();
    await expect(
      accounts.importFolder({ vendor: "copilot", name: "x", from: "/nowhere/at/all" }),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      accounts.importFolder({ vendor: "copilot", name: "x", from: "relative/dir" }),
    ).rejects.toMatchObject({ code: "validation" });
  });
});

describe("temporary directories", () => {
  it("refuses an accounts folder under a temporary directory for create, import, and seed", async () => {
    const { accounts } = setup({ dataDir: "/tmp/aio-x/data", tempDirs: ["/tmp"] });
    expect(() => accounts.create({ vendor: "codex", name: "work" })).toThrow(/temporary directory/);
    await expect(
      accounts.importFolder({ vendor: "codex", name: "work", from: "/home" }),
    ).rejects.toMatchObject({ code: "validation" });
    expect(() => accounts.validateSeed({})).toThrow(/temporary directory/);
  });
});

describe("seed deny-list", () => {
  function sources(): SeedSources {
    const root = tempDir("aio-deny-");
    const claudeDir = path.join(root, ".claude");
    write(path.join(claudeDir, ".credentials.json"), SECRET);
    write(path.join(claudeDir, "agent.env"), SECRET);
    write(path.join(claudeDir, "plugins", "x", "prod.env"), SECRET);
    write(path.join(claudeDir, "plugins", "x", ".env"), SECRET);
    write(path.join(claudeDir, "settings.json"), "{}");
    write(path.join(claudeDir, ".claude.json"), '{"installMethod":"native","theme":"dark"}');
    fs.mkdirSync(path.join(claudeDir, "projects"));
    const claudeJson = path.join(root, ".claude.json");
    fs.symlinkSync(path.join(claudeDir, ".claude.json"), claudeJson);
    const copilotDir = path.join(root, ".copilot");
    write(path.join(copilotDir, "config.json"), SECRET);
    write(path.join(copilotDir, "session-store.db"), "db");
    return { claudeDir, claudeJson, codexDir: path.join(root, ".codex"), copilotDir };
  }

  function holdsSecret(dir: string): boolean {
    const walk = (d: string): boolean =>
      fs.readdirSync(d).some((n) => {
        const p = path.join(d, n);
        const st = fs.lstatSync(p);
        if (st.isDirectory()) return walk(p);
        return st.isFile() && fs.readFileSync(p, "utf8").includes(SECRET);
      });
    return walk(dir);
  }

  it("leaves out agent.env and .env files at any depth", async () => {
    const dest = path.join(tempDir("aio-seed-"), "claude", "personal");
    const r = await seedFolder("claude", sources(), dest);
    expect(holdsSecret(dest)).toBe(false);
    expect(r.leftOut).toEqual(
      expect.arrayContaining([
        ".credentials.json",
        "agent.env",
        "plugins/x/.env",
        "plugins/x/prod.env",
      ]),
    );
  });

  it("leaves out Copilot's config.json, which holds the token", async () => {
    const dest = path.join(tempDir("aio-seed-"), "copilot", "personal");
    await seedFolder("copilot", sources(), dest);
    expect(fs.existsSync(path.join(dest, "config.json"))).toBe(false);
    expect(fs.existsSync(path.join(dest, "session-store.db"))).toBe(true);
  });

  it("copies a linked ~/.claude.json as a file and sets installMethod to global", async () => {
    const dest = path.join(tempDir("aio-seed-"), "claude", "personal");
    await seedFolder("claude", sources(), dest);
    const file = path.join(dest, ".claude.json");
    expect(fs.lstatSync(file).isFile()).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      installMethod: "global",
      theme: "dark",
    });
  });
});
