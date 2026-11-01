// Boxes on accounts (phase 2 of docs/v4/design-accounts.md): the env prefix
// on the session command, the account mounts, the mode label, the shared
// transcript store, and moving a box between accounts.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { START_SESSION_PATH } from "../../src/docker/scripts.js";
import { linkTargetsOutside } from "../../src/docker/launch.js";
import { accountDirFor } from "../../src/records/env.js";
import { makeHarness, type Harness } from "./harness.js";

function lastCommand(h: Harness): string {
  const starts = h.docker
    .callsOf("exec")
    .map((c) => (c.args[1] as { cmd: string[] }).cmd)
    .filter((cmd) => cmd[0] === START_SESSION_PATH);
  return starts.at(-1)?.[3] ?? "";
}

/** Adds an account record and its folder, bypassing the temporary-directory check. */
function addAccount(h: Harness, id: string, store?: string): string {
  const [vendor, name] = id.split("/") as ["claude" | "codex" | "copilot", string];
  const dir = accountDirFor(h.env, vendor, name);
  fs.mkdirSync(dir, { recursive: true });
  if (vendor === "claude" && store) fs.symlinkSync(store, path.join(dir, "projects"));
  const now = new Date().toISOString();
  h.core.db.accounts.put({
    id,
    vendor,
    name,
    label: name,
    overflow: false,
    signIn: { state: "signed_in" },
    createdAt: now,
    updatedAt: now,
  });
  return dir;
}

function accountsMode(h: Harness, defaults: Record<string, string>): void {
  h.core.settings.patch({ accountsMode: "accounts", accountDefaults: defaults });
}

describe("session command", () => {
  it("prefixes CLAUDE_CONFIG_DIR with the box's account, and the default otherwise", async () => {
    const h = makeHarness();
    const store = h.dir("store");
    const personal = addAccount(h, "claude/personal", store);
    const work = addAccount(h, "claude/work", store);
    accountsMode(h, { claude: "claude/personal" });
    const a = await h.core.boxes.create({ targetDir: h.dir("a"), layout: "root" });
    expect(lastCommand(h).startsWith(`env CLAUDE_CONFIG_DIR='${personal}' claude `)).toBe(true);
    const b = await h.core.boxes.create({
      targetDir: h.dir("b"),
      layout: "root",
      accounts: { claude: "claude/work" },
    });
    expect(b.accounts).toEqual({ claude: "claude/work" });
    expect(lastCommand(h)).toContain(`CLAUDE_CONFIG_DIR='${work}'`);
    expect(a.accounts).toBeUndefined();
  });

  it("pre-accepts the trust prompt for the box's folders in its account before it starts", async () => {
    const h = makeHarness();
    const personal = addAccount(h, "claude/personal", h.dir("store"));
    accountsMode(h, { claude: "claude/personal" });
    const dir = h.dir("a");
    await h.core.boxes.create({ targetDir: dir, layout: "root" });
    const config = JSON.parse(fs.readFileSync(path.join(personal, ".claude.json"), "utf8")) as {
      installMethod: string;
      projects: Record<string, { hasTrustDialogAccepted: boolean }>;
    };
    expect(config.installMethod).toBe("global");
    expect(config.projects[dir]).toEqual({ hasTrustDialogAccepted: true });
    const settings = JSON.parse(fs.readFileSync(path.join(personal, "settings.json"), "utf8"));
    expect(settings.skipDangerousModePermissionPrompt).toBe(true);
  });

  it("uses each platform's variable and starts no prefix in host mode", async () => {
    const h = makeHarness();
    const codex = addAccount(h, "codex/main");
    addAccount(h, "claude/personal", h.dir("store"));
    const host = await h.core.boxes.create({
      targetDir: h.dir("host"),
      layout: "root",
      platform: "codex",
    });
    expect(lastCommand(h).startsWith("codex ")).toBe(true);
    await h.core.boxes.stop(host.id);
    accountsMode(h, { claude: "claude/personal", codex: "codex/main" });
    await h.core.boxes.start(host.id);
    expect(lastCommand(h).startsWith(`env CODEX_HOME='${codex}' codex `)).toBe(true);
  });

  it("refuses to start when the vendor has no account", async () => {
    const h = makeHarness();
    accountsMode(h, {});
    await expect(
      h.core.boxes.create({ targetDir: h.dir("a"), layout: "root" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses an account that has no record", async () => {
    const h = makeHarness();
    await expect(
      h.core.boxes.create({
        targetDir: h.dir("a"),
        layout: "root",
        accounts: { claude: "claude/ghost" },
      }),
    ).rejects.toMatchObject({ code: "validation" });
  });
});

describe("container layout", () => {
  it("mounts the accounts folder and each sessions folder, and not the host folders", async () => {
    const h = makeHarness();
    const store = h.dir("store");
    const personal = addAccount(h, "claude/personal", store);
    accountsMode(h, { claude: "claude/personal" });
    const box = await h.core.boxes.create({ targetDir: h.dir("a"), layout: "root" });
    const spec = h.docker.containers.get(box.container)!.spec;
    const accountsDir = path.join(h.env.home, ".claude-box", "accounts");
    expect(spec.binds).toContain(`${accountsDir}:${accountsDir}`);
    expect(spec.binds).toContain(
      `${path.join(h.env.home, ".claude-box", "sessions", box.container)}:${personal}/sessions`,
    );
    expect(spec.binds).toContain(`${store}:${store}`);
    expect(spec.binds.some((b) => b.endsWith(":/home/tester/.claude"))).toBe(false);
    expect(spec.binds.some((b) => b.endsWith(":/home/tester/.claude.json"))).toBe(false);
    expect(spec.labels["agentbox.accounts-mode"]).toBe("accounts");
    // The home links go to the default account.
    const links = h.docker
      .callsOf("exec")
      .map((c) => (c.args[1] as { cmd: string[] }).cmd)
      .find((cmd) => cmd[0] === "/bin/sh" && cmd.includes("_") && cmd.includes(personal));
    expect(links).toContain("/home/tester/.claude");
  });

  it("makes a container from host mode stale for the mode switch", async () => {
    const h = makeHarness();
    addAccount(h, "claude/personal", h.dir("store"));
    const box = await h.core.boxes.create({ targetDir: h.dir("a"), layout: "root" });
    accountsMode(h, { claude: "claude/personal" });
    const project = h.core.projects.get(box.projectId);
    expect(await h.core.projects.staleDifferences(project)).toContain(
      "accounts mode host -> accounts",
    );
  });

  it("flags a box whose account was added after the container started", async () => {
    const h = makeHarness();
    const store = h.dir("store");
    addAccount(h, "claude/personal", store);
    accountsMode(h, { claude: "claude/personal" });
    await h.core.boxes.create({ targetDir: h.dir("a"), layout: "root" });
    addAccount(h, "claude/work", store);
    await expect(
      h.core.boxes.create({
        targetDir: h.dir("a"),
        layout: "root",
        accounts: { claude: "claude/work" },
      }),
    ).rejects.toMatchObject({ code: "stale_mounts" });
  });

  it("finds links out of an account folder and skips dangling and inside links", () => {
    const h = makeHarness();
    const store = h.dir("store");
    const dir = addAccount(h, "claude/personal", store);
    fs.mkdirSync(path.join(dir, "skills"));
    fs.symlinkSync("skills", path.join(dir, "inside"));
    fs.symlinkSync("/nowhere/at/all", path.join(dir, "dangling"));
    expect(linkTargetsOutside(dir)).toEqual([store]);
  });
});

describe("shared transcript store", () => {
  it("resolves transcripts in the store, and resumes after a move between accounts", async () => {
    const h = makeHarness();
    const store = h.dir("store");
    addAccount(h, "claude/personal", store);
    addAccount(h, "claude/work", store);
    accountsMode(h, { claude: "claude/personal" });
    const dir = h.dir("a");
    const box = await h.core.boxes.create({ targetDir: dir, layout: "root" });
    const uuid = box.sessionUuid as string;
    const file = h.transcript(dir, uuid);
    expect(file.startsWith(`${store}/`)).toBe(true);
    await h.core.boxes.stop(box.id);
    const { box: moved, restartRequired } = await h.core.boxes.update(box.id, {
      accounts: { claude: "claude/work" },
    });
    expect(moved.accounts).toEqual({ claude: "claude/work" });
    expect(restartRequired).toBe(false);
    await h.core.boxes.start(box.id);
    expect(lastCommand(h)).toContain("--resume");
    expect(lastCommand(h)).toContain(uuid);
    expect(lastCommand(h)).toContain("claude/work".replace("claude/", "/claude/"));
  });

  it("uses the host's projects folder in host mode", () => {
    const h = makeHarness();
    const file = h.transcript(h.dir("a"), "11111111-1111-4111-8111-111111111111");
    expect(file.startsWith(path.join(h.env.home, ".claude", "projects"))).toBe(true);
  });
});

describe("model catalog", () => {
  it("reads models and defaults from the chosen account's folder", async () => {
    const h = makeHarness();
    const work = addAccount(h, "claude/work", h.dir("store"));
    addAccount(h, "claude/personal", h.dir("store"));
    fs.writeFileSync(
      path.join(work, ".claude.json"),
      JSON.stringify({ additionalModelOptionsCache: [{ value: "claude-work-only-9-9" }] }),
    );
    fs.writeFileSync(path.join(work, "settings.json"), JSON.stringify({ model: "claude-work-9" }));
    accountsMode(h, { claude: "claude/personal" });
    const forWork = await h.core.models.list(undefined, "claude/work");
    expect(forWork.models).toContain("claude-work-only-9-9");
    expect(forWork.defaults.model).toBe("claude-work-9");
    const forDefault = await h.core.models.list();
    expect(forDefault.models).not.toContain("claude-work-only-9-9");
  });
});

describe("moving a box between accounts", () => {
  it("starts a fresh Codex session in the new account and clears an entry with null", async () => {
    const h = makeHarness();
    addAccount(h, "codex/one");
    addAccount(h, "codex/two");
    addAccount(h, "claude/personal", h.dir("store"));
    accountsMode(h, { claude: "claude/personal", codex: "codex/one" });
    const box = await h.core.boxes.create({
      targetDir: h.dir("a"),
      layout: "root",
      platform: "codex",
    });
    await h.core.boxes.stop(box.id);
    const { box: moved } = await h.core.boxes.update(box.id, { accounts: { codex: "codex/two" } });
    expect(moved.firstStart).toEqual({ openingPrompt: "" });
    await h.core.boxes.start(box.id);
    expect(lastCommand(h)).toContain("CODEX_HOME=");
    expect(lastCommand(h)).not.toContain("resume");
    const cleared = await h.core.boxes.update(box.id, { accounts: { codex: null } });
    expect(cleared.box.accounts).toBeUndefined();
  });

  it("asks for a restart when a running box changes account", async () => {
    const h = makeHarness();
    const store = h.dir("store");
    addAccount(h, "claude/personal", store);
    addAccount(h, "claude/work", store);
    accountsMode(h, { claude: "claude/personal" });
    const box = await h.core.boxes.create({ targetDir: h.dir("a"), layout: "root" });
    const r = await h.core.boxes.update(box.id, { accounts: { claude: "claude/work" } });
    expect(r.restartRequired).toBe(true);
  });
});
