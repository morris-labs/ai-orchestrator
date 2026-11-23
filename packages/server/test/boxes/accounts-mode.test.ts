// Boxes on accounts (phase 2 of the accounts feature): the env prefix
// on the session command, the account mounts, the mode label, the shared
// transcript store, and moving a box between accounts.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { START_SESSION_PATH } from "../../src/docker/scripts.js";
import { linkTargetsOutside } from "../../src/docker/launch.js";
import { writeContainerLayout, accountDirsFile } from "../../src/docker/state.js";
import { skippedLinkMessage } from "../../src/projects/service.js";
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
  it("names the box in AIO_BOX_ID, for the aio-build command", async () => {
    const h = makeHarness({ accounts: false });
    const store = h.dir(".ai-orchestrator", "transcripts", "claude");
    addAccount(h, "claude/personal", store);
    accountsMode(h, { claude: "claude/personal" });
    const box = await h.core.boxes.create({ targetDir: h.dir("a"), layout: "root" });
    expect(lastCommand(h)).toMatch(new RegExp(`^env \\S+ AIO_BOX_ID='${box.id}' claude `));
  });

  it("prefixes CLAUDE_CONFIG_DIR with the box's account, and the default otherwise", async () => {
    const h = makeHarness({ accounts: false });
    const store = h.dir(".ai-orchestrator", "transcripts", "claude");
    const personal = addAccount(h, "claude/personal", store);
    const work = addAccount(h, "claude/work", store);
    accountsMode(h, { claude: "claude/personal" });
    const a = await h.core.boxes.create({ targetDir: h.dir("a"), layout: "root" });
    expect(
      lastCommand(h).startsWith(`env CLAUDE_CONFIG_DIR='${personal}' AIO_BOX_ID='${a.id}' claude `),
    ).toBe(true);
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
    const h = makeHarness({ accounts: false });
    const personal = addAccount(
      h,
      "claude/personal",
      h.dir(".ai-orchestrator", "transcripts", "claude"),
    );
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

  it("uses each platform's own account folder variable", async () => {
    const h = makeHarness({ accounts: false });
    const codex = addAccount(h, "codex/main");
    const copilot = addAccount(h, "copilot/main");
    accountsMode(h, { codex: "codex/main", copilot: "copilot/main" });
    const c = await h.core.boxes.create({
      targetDir: h.dir("codex-work"),
      layout: "root",
      platform: "codex",
    });
    expect(lastCommand(h).startsWith(`env CODEX_HOME='${codex}' AIO_BOX_ID='${c.id}' codex `)).toBe(
      true,
    );
    const p = await h.core.boxes.create({
      targetDir: h.dir("copilot-work"),
      layout: "root",
      platform: "copilot",
    });
    expect(
      lastCommand(h).startsWith(`env COPILOT_HOME='${copilot}' AIO_BOX_ID='${p.id}' copilot `),
    ).toBe(true);
  });

  it("refuses to start when the vendor has no account", async () => {
    const h = makeHarness({ accounts: false });
    accountsMode(h, {});
    await expect(
      h.core.boxes.create({ targetDir: h.dir("a"), layout: "root" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses an account that has no record", async () => {
    const h = makeHarness({ accounts: false });
    accountsMode(h, {});
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
    const h = makeHarness({ accounts: false });
    const store = h.dir(".ai-orchestrator", "transcripts", "claude");
    const personal = addAccount(h, "claude/personal", store);
    accountsMode(h, { claude: "claude/personal" });
    const box = await h.core.boxes.create({ targetDir: h.dir("a"), layout: "root" });
    const spec = h.docker.containers.get(box.container)!.spec;
    const accountsDir = path.join(h.env.home, ".ai-orchestrator", "accounts");
    expect(spec.binds).toContain(`${accountsDir}:${accountsDir}`);
    expect(spec.binds).toContain(
      `${path.join(h.env.home, ".ai-orchestrator", "sessions", box.container)}:${personal}/sessions`,
    );
    expect(spec.binds).toContain(`${store}:${store}`);
    expect(spec.binds.some((b) => b.endsWith(":/home/tester/.claude"))).toBe(false);
    expect(spec.binds.some((b) => b.endsWith(":/home/tester/.claude.json"))).toBe(false);
    expect(spec.labels["aio.accounts-mode"]).toBe("accounts");
    // The home links go to the default account.
    const links = h.docker
      .callsOf("exec")
      .map((c) => (c.args[1] as { cmd: string[] }).cmd)
      .find((cmd) => cmd[0] === "/bin/sh" && cmd.includes("_") && cmd.includes(personal));
    expect(links).toContain("/home/tester/.claude");
  });

  it("makes a container from host mode stale for the mode switch", async () => {
    const h = makeHarness({ accounts: false });
    addAccount(h, "claude/personal", h.dir(".ai-orchestrator", "transcripts", "claude"));
    accountsMode(h, { claude: "claude/personal" });
    const box = await h.core.boxes.create({ targetDir: h.dir("a"), layout: "root" });
    h.docker.containers.get(box.container)!.spec.labels["aio.accounts-mode"] = "host";
    const project = h.core.projects.get(box.projectId);
    expect(await h.core.projects.staleDifferences(project)).toContain(
      "accounts mode host -> accounts",
    );
  });

  it("flags a box whose account was added after the container started", async () => {
    const h = makeHarness({ accounts: false });
    const store = h.dir(".ai-orchestrator", "transcripts", "claude");
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
    const h = makeHarness({ accounts: false });
    const store = h.dir(".ai-orchestrator", "transcripts", "claude");
    const dir = addAccount(h, "claude/personal", store);
    fs.mkdirSync(path.join(dir, "skills"));
    fs.symlinkSync("skills", path.join(dir, "inside"));
    fs.symlinkSync("/nowhere/at/all", path.join(dir, "dangling"));
    expect(linkTargetsOutside(dir)).toEqual([store]);
  });
});

describe("shared transcript store", () => {
  it("resolves transcripts in the store, and resumes after a move between accounts", async () => {
    const h = makeHarness({ accounts: false });
    const store = h.dir(".ai-orchestrator", "transcripts", "claude");
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

  it("finds transcripts in the host folder for a legacy host setting", () => {
    const h = makeHarness({ accounts: false });
    const file = h.transcript(h.dir("a"), "11111111-1111-4111-8111-111111111111");
    expect(file.startsWith(path.join(h.env.home, ".claude", "projects"))).toBe(true);
  });
});

describe("model catalog", () => {
  it("reads models and defaults from the chosen account's folder", async () => {
    const h = makeHarness({ accounts: false });
    const work = addAccount(h, "claude/work", h.dir(".ai-orchestrator", "transcripts", "claude"));
    addAccount(h, "claude/personal", h.dir(".ai-orchestrator", "transcripts", "claude"));
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
    const h = makeHarness({ accounts: false });
    addAccount(h, "codex/one");
    addAccount(h, "codex/two");
    addAccount(h, "claude/personal", h.dir(".ai-orchestrator", "transcripts", "claude"));
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
    const h = makeHarness({ accounts: false });
    const store = h.dir(".ai-orchestrator", "transcripts", "claude");
    addAccount(h, "claude/personal", store);
    addAccount(h, "claude/work", store);
    accountsMode(h, { claude: "claude/personal" });
    const box = await h.core.boxes.create({ targetDir: h.dir("a"), layout: "root" });
    const r = await h.core.boxes.update(box.id, { accounts: { claude: "claude/work" } });
    expect(r.restartRequired).toBe(true);
  });
});

describe("engine account folders", () => {
  function readDirs(h: Harness, container: string): unknown {
    return JSON.parse(fs.readFileSync(accountDirsFile(h.env, container), "utf8"));
  }

  it("writes each vendor's default folder when the container starts", async () => {
    const h = makeHarness({ accounts: false });
    const personal = addAccount(
      h,
      "claude/personal",
      h.dir(".ai-orchestrator", "transcripts", "claude"),
    );
    const codex = addAccount(h, "codex/main");
    accountsMode(h, { claude: "claude/personal", codex: "codex/main" });
    const box = await h.core.boxes.create({ targetDir: h.dir("a"), layout: "root" });
    expect(readDirs(h, box.container)).toEqual({ claude: personal, codex });
  });

  it("rewrites the file for a running container when the defaults change", async () => {
    const h = makeHarness({ accounts: false });
    const store = h.dir(".ai-orchestrator", "transcripts", "claude");
    const personal = addAccount(h, "claude/personal", store);
    const work = addAccount(h, "claude/work", store);
    accountsMode(h, { claude: "claude/personal" });
    const box = await h.core.boxes.create({ targetDir: h.dir("a"), layout: "root" });
    expect(readDirs(h, box.container)).toEqual({ claude: personal });
    h.core.settings.patch({ accountDefaults: { claude: "claude/work" } });
    expect(readDirs(h, box.container)).toEqual({ claude: work });
    h.core.settings.patch({ accountsMode: "host" });
    expect(readDirs(h, box.container)).toEqual({});
  });

  it("keeps legacy container layouts from acquiring unmounted account paths", async () => {
    const h = makeHarness({ accounts: false });
    addAccount(h, "claude/personal", h.dir(".ai-orchestrator", "transcripts", "claude"));
    accountsMode(h, { claude: "claude/personal" });
    const box = await h.core.boxes.create({ targetDir: h.dir("a"), layout: "root" });
    writeContainerLayout(h.env, box.container, {
      accounts: false,
      claudeDirs: [],
      accountLinkTargets: [],
    });
    addAccount(h, "claude/work", h.dir(".ai-orchestrator", "transcripts", "claude"));
    h.core.settings.patch({ accountDefaults: { claude: "claude/work" } });
    expect(readDirs(h, box.container)).toEqual({});
  });

  it("keeps the previous Claude account when the default has no mount, and logs it", async () => {
    const lines: string[] = [];
    const h = makeHarness({ accounts: false, log: (m) => lines.push(m) });
    const store = h.dir(".ai-orchestrator", "transcripts", "claude");
    const personal = addAccount(h, "claude/personal", store);
    accountsMode(h, { claude: "claude/personal" });
    const box = await h.core.boxes.create({ targetDir: h.dir("a"), layout: "root" });
    addAccount(h, "claude/later", store);
    h.core.settings.patch({ accountDefaults: { claude: "claude/later" } });
    expect(readDirs(h, box.container)).toEqual({ claude: personal });
    expect(lines.join("\n")).toMatch(/no mount in this container/);
  });

  it("repairs the file when a running container is ensured again", async () => {
    const h = makeHarness({ accounts: false });
    const personal = addAccount(
      h,
      "claude/personal",
      h.dir(".ai-orchestrator", "transcripts", "claude"),
    );
    accountsMode(h, { claude: "claude/personal" });
    const box = await h.core.boxes.create({ targetDir: h.dir("a"), layout: "root" });
    fs.rmSync(accountDirsFile(h.env, box.container));
    await h.core.projects.ensureContainer(box.projectId);
    expect(readDirs(h, box.container)).toEqual({ claude: personal });
  });

  it("keeps legacy host settings readable without exposing host account paths", () => {
    const h = makeHarness({ accounts: false });
    expect(h.core.projects.accountDirs()).toEqual({});
    expect(h.core.settings.get().accountsMode).toBe("host");
  });
});

describe("home links left alone", () => {
  it("logs each link the script reports it skipped", async () => {
    const lines: string[] = [];
    const h = makeHarness({ accounts: false, log: (m) => lines.push(m) });
    addAccount(h, "claude/personal", h.dir(".ai-orchestrator", "transcripts", "claude"));
    accountsMode(h, { claude: "claude/personal" });
    h.docker.execHandler = (_c, options) =>
      options.cmd[0] === "/bin/sh" && options.cmd[3] === "_"
        ? { exitCode: 0, stdout: "skipped /home/tester/.claude\n", stderr: "" }
        : undefined;
    const box = await h.core.boxes.create({ targetDir: h.dir("a"), layout: "root" });
    expect(lines.some((l) => l.startsWith(`${box.container}: /home/tester/.claude `))).toBe(true);
  });

  it("names outside account links as the cause when they live under the folder", () => {
    const message = skippedLinkMessage("aio-agent-proj-sample", "/home/tester/.claude", [
      "/home/tester/.claude/CLAUDE.md",
      "/home/tester/.claude/skills",
      "/srv/elsewhere",
    ]);
    expect(message).toContain("Docker created it to hold the mounts");
    expect(message).toContain("/home/tester/.claude/CLAUDE.md, /home/tester/.claude/skills");
    expect(message).not.toContain("/srv/elsewhere");
    expect(skippedLinkMessage("c", "/home/tester/.codex", [])).toContain("isn't a link");
  });
});
