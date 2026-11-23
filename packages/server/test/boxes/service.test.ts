import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BoxSchema,
  BoxViewSchema,
  DEFAULT_PROMPT_TEMPLATES,
  SECRETS_PROMPT_HINT,
  expandTemplate,
  withSecretsHint,
  type Box,
} from "@aio/contracts";
import { START_SESSION_PATH } from "../../src/docker/scripts.js";
import { ApiError } from "../../src/records/errors.js";
import { commitAll, initRepo, originAndProject, write } from "../worktrees/helpers.js";
import { assertContractEvent, makeHarness, type Harness } from "./harness.js";

const UUID_RE = /^[0-9a-f-]{36}$/;

/** The session start calls made so far: [session, workDir, command]. */
function starts(h: Harness): string[][] {
  return h.docker
    .callsOf("exec")
    .map((c) => (c.args[1] as { cmd: string[] }).cmd)
    .filter((cmd) => cmd[0] === START_SESSION_PATH)
    .map((cmd) => cmd.slice(1));
}

function lastCommand(h: Harness): string {
  return starts(h).at(-1)?.[2] ?? "";
}

describe("create", () => {
  it("starts a new conversation in the project root with the Starter prompt", async () => {
    const h = makeHarness();
    const dir = h.dir("work", "app");
    const box = await h.core.boxes.create({
      targetDir: dir,
      layout: "root",
      conversationName: "Quick look",
      model: "claude-opus-5-5",
      effort: "high",
    });
    expect(BoxSchema.parse(box)).toEqual(box);
    expect(box).toMatchObject({
      id: "aio-agent-app",
      hostKey: "app",
      targetDir: dir,
      conversationName: "Quick look",
      transcriptSyncedName: "Quick look",
      container: `aio-agent-proj-${box.projectId}`,
      session: "aio-agent-app",
      wasRunning: true,
      launchedModel: "claude-opus-5-5",
      launchedEffort: "high",
    });
    expect(box.sessionUuid).toMatch(UUID_RE);
    const [session, workDir, command] = starts(h)[0]!;
    expect([session, workDir]).toEqual(["aio-agent-app", dir]);
    const prompt = expandTemplate(DEFAULT_PROMPT_TEMPLATES.starter, ["Quick look", dir]);
    expect(command).toBe(
      `env CLAUDE_CONFIG_DIR='${path.join(h.home, ".ai-orchestrator", "accounts", "claude", "fixture")}' AIO_BOX_ID='${box.id}' claude '--remote-control=Quick look' '--permission-mode' 'auto' '--allow-dangerously-skip-permissions' ` +
        `'--model' 'claude-opus-5-5' '--effort' 'high' '--name=Quick look' '--session-id' '${box.sessionUuid}' '--' '${prompt.replace(/'/g, `'\\''`)}'`,
    );
    expect(h.core.boxes.status(box)).toBe("running");
    const view = h.core.boxes.view(box);
    expect(BoxViewSchema.parse(view)).toMatchObject({
      status: "running",
      tmuxSession: "aio-agent-app",
      sideSessions: [],
      targetDirExists: true,
    });
    fs.rmSync(dir, { recursive: true });
    expect(h.core.boxes.view(box).targetDirExists).toBe(false);
    fs.mkdirSync(dir);
    const types = h.events.map((e) => e.type);
    expect(types).toContain("box.changed");
    for (const e of h.events) assertContractEvent(e);
  });

  it("skips the Starter when it is empty and names the box after the folder", async () => {
    const h = makeHarness();
    h.core.settings.setPromptTemplates({ ...DEFAULT_PROMPT_TEMPLATES, starter: "" });
    const box = await h.core.boxes.create({ targetDir: h.dir("app.example.com"), layout: "root" });
    expect(box.id).toBe("aio-agent-app.example.com");
    expect(box.session).toBe("aio-agent-app.example.com");
    expect(h.core.boxes.view(box).tmuxSession).toBe("aio-agent-app_example_com");
    expect(box.conversationName).toBe("aio-agent-app.example.com");
    expect(lastCommand(h)).not.toContain("Your working directory");
    const second = await h.core.boxes.create({ targetDir: box.targetDir, layout: "root" });
    expect(second.id).toBe("aio-agent-app.example.com-2");
    expect(second.hostKey).toBe("app-example-com-2");
  });

  it("passes an opening prompt that starts with - after --, last", async () => {
    const h = makeHarness();
    h.core.settings.setPromptTemplates({ ...DEFAULT_PROMPT_TEMPLATES, starter: "%1" });
    const box = await h.core.boxes.create({
      targetDir: h.dir("app"),
      layout: "root",
      conversationName: "-x",
    });
    expect(
      lastCommand(h).endsWith(`'--name=-x' '--session-id' '${box.sessionUuid}' '--' '-x'`),
    ).toBe(true);
    // A box saved without a start passes its prompt the same way on its first start.
    const later = await h.core.boxes.create({
      targetDir: h.dir("app"),
      layout: "root",
      conversationName: "-y",
      start: false,
    });
    const started = await h.core.boxes.start(later.id);
    expect(
      lastCommand(h).endsWith(`'--name=-y' '--session-id' '${started.sessionUuid}' '--' '-y'`),
    ).toBe(true);
  });

  it("adds the secrets hint only when the project has secret references", async () => {
    const h = makeHarness();
    const dir = h.dir("work", "app");
    const plain = await h.core.boxes.create({ targetDir: dir, layout: "root", start: false });
    expect(plain.firstStart?.openingPrompt).not.toContain("aio-secret");

    h.core.settings.setSecretRefs([{ name: "GH_TOKEN", ref: "op://V/github/token" }]);
    const global = await h.core.boxes.create({
      targetDir: dir,
      layout: "workspace",
      conversationName: "Fix login",
      start: false,
    });
    const prompt = global.firstStart?.openingPrompt ?? "";
    expect(prompt).toContain("Your workspace for this conversation is");
    expect(prompt.endsWith(`\n\n${SECRETS_PROMPT_HINT}`)).toBe(true);

    h.core.settings.setSecretRefs([]);
    await h.core.projects.update(global.projectId, {
      secretRefs: [{ name: "DATABASE_URL", ref: "op://V/db/url" }],
    });
    const project = await h.core.boxes.create({ targetDir: dir, layout: "root", start: false });
    expect(project.firstStart?.openingPrompt).toBe(
      withSecretsHint(expandTemplate(DEFAULT_PROMPT_TEMPLATES.starter, ["", dir])),
    );
  });

  it("keeps host keys unique across projects", async () => {
    const h = makeHarness();
    h.core.settings.setPromptTemplates({ ...DEFAULT_PROMPT_TEMPLATES, starter: "" });
    const a = await h.core.boxes.create({ targetDir: h.dir("x", "api.v2"), layout: "root" });
    const b = await h.core.boxes.create({ targetDir: h.dir("y", "api-v2"), layout: "root" });
    expect(a.projectId).not.toBe(b.projectId);
    expect(a.hostKey).toBe("api-v2");
    expect(b.hostKey).toBe("api-v2-2");
  });

  it("provisions a workspace subfolder and names everything after the slug", async () => {
    const h = makeHarness();
    const dir = h.dir("app");
    const box = await h.core.boxes.create({
      targetDir: dir,
      layout: "workspace",
      conversationName: "Emails not sending!",
    });
    expect(box).toMatchObject({
      id: "aio-agent-emails_not_sending",
      workspace: "Emails_not_sending",
      conversationName: "Emails_not_sending",
    });
    expect(fs.statSync(path.join(dir, "Emails_not_sending")).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(dir, ".aio/conversations/Emails_not_sending")).isDirectory()).toBe(
      true,
    );
    const prompt = expandTemplate(DEFAULT_PROMPT_TEMPLATES.workspace, [
      "Emails_not_sending",
      "Emails not sending!",
      path.join(dir, "Emails_not_sending"),
      path.join(dir, ".aio/conversations/Emails_not_sending"),
      path.join(dir, ".aio/INFRA.md"),
    ]);
    expect(lastCommand(h)).toContain(`'${prompt.replace(/'/g, `'\\''`)}'`);
    expect(lastCommand(h)).toContain("--remote-control=Emails_not_sending");
    expect(starts(h)[0]![1]).toBe(dir);
  });

  it("provisions a worktree and removes it when the session fails to start", async () => {
    const h = makeHarness();
    const repo = initRepo(h.dir("repo"));
    const box = await h.core.boxes.create({
      targetDir: repo,
      layout: "auto",
      conversationName: "Add login",
    });
    const wt = path.join(repo, ".worktrees", "Add_login");
    expect(box).toMatchObject({
      worktree: wt,
      branch: "claude/Add_login",
      conversationName: "Add_login",
    });
    expect(starts(h)[0]![1]).toBe(wt);
    expect(lastCommand(h)).toContain("a git worktree of");
    expect(fs.readFileSync(path.join(repo, ".git/info/exclude"), "utf8")).toContain(".worktrees/");

    h.docker.failingCommands.push("Broken");
    await expect(
      h.core.boxes.create({ targetDir: repo, layout: "worktree", conversationName: "Broken" }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(fs.existsSync(path.join(repo, ".worktrees", "Broken"))).toBe(false);
    expect(h.core.db.boxes.list().map((b) => b.id)).toEqual([box.id]);
  });

  it("gives two concurrent creates of one name separate boxes and keeps the worktree", async () => {
    const h = makeHarness();
    const repo = initRepo(h.dir("repo"));
    const req = { targetDir: repo, layout: "worktree" as const, conversationName: "Fix login" };
    const results = await Promise.allSettled([h.core.boxes.create(req), h.core.boxes.create(req)]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    const [a, b] = results.map((r) => (r as PromiseFulfilledResult<Box>).value) as [Box, Box];
    expect(new Set([a.id, b.id]).size).toBe(2);
    expect(
      h.core.db.boxes
        .list()
        .map((x) => x.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
    expect(a.worktree).toBe(b.worktree);
    expect(fs.existsSync(a.worktree!)).toBe(true);
  });

  it("removes the record of a create whose start fails", async () => {
    const h = makeHarness();
    h.docker.failingCommands = ["claude"];
    await expect(
      h.core.boxes.create({ targetDir: h.dir("app"), layout: "root" }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(h.core.db.boxes.list()).toEqual([]);
  });

  it("refuses a worktree without a repository and falls back for auto", async () => {
    const h = makeHarness();
    const dir = h.dir("plain");
    await expect(
      h.core.boxes.create({ targetDir: dir, layout: "worktree", conversationName: "x" }),
    ).rejects.toMatchObject({ code: "conflict" });
    const box = await h.core.boxes.create({
      targetDir: dir,
      layout: "auto",
      conversationName: "x",
      rememberLayout: true,
    });
    expect(box.worktree).toBeUndefined();
    expect(h.core.settings.get().newBoxDefaults.workspaceDirs[dir]).toBe(false);
  });

  it("uses a workspace for auto in a tree with new-issue.sh unless told no", async () => {
    const h = makeHarness();
    const dir = h.dir("issues");
    fs.writeFileSync(path.join(dir, "new-issue.sh"), "#!/bin/sh\n", { mode: 0o755 });
    expect(h.core.boxes.resolveLayout(dir, h.core.projects.ensureForRoot(dir))).toBe("workspace");
    h.core.settings.rememberLayout(dir, { workspace: false });
    expect(h.core.boxes.resolveLayout(dir, h.core.projects.ensureForRoot(dir))).toBe("root");
  });

  it("validates a create request before the job starts", async () => {
    const h = makeHarness();
    const dir = h.dir("app");
    const uuid = "6f1c3a52-6d8b-4f43-9a51-2d5b7cbd3f10";
    await expect(
      h.core.boxes.validateCreate({ targetDir: path.join(dir, "missing"), layout: "root" }),
    ).rejects.toMatchObject({ code: "validation" });
    await h.core.boxes.create({
      targetDir: dir,
      layout: "root",
      conversation: { mode: "adopt", sessionUuid: uuid },
    });
    await expect(
      h.core.boxes.validateCreate({
        targetDir: dir,
        layout: "root",
        conversation: { mode: "adopt", sessionUuid: uuid },
      }),
    ).rejects.toMatchObject({ code: "adoption_refused" });
    await expect(
      h.core.boxes.validateCreate({ targetDir: dir, layout: "root" }),
    ).resolves.toBeUndefined();
    h.docker.images.clear();
    await expect(
      h.core.boxes.validateCreate({ targetDir: dir, layout: "root" }),
    ).rejects.toMatchObject({
      code: "image_missing",
    });
    await expect(
      h.core.boxes.validateCreate({ targetDir: dir, layout: "root", start: false }),
    ).resolves.toBeUndefined();
  });

  it("adopts a conversation, refusing held ones unless forced", async () => {
    const h = makeHarness();
    const dir = h.dir("app");
    const uuid = "6f1c3a52-6d8b-4f43-9a51-2d5b7cbd3f10";
    const a = await h.core.boxes.create({
      targetDir: dir,
      layout: "root",
      conversation: { mode: "adopt", sessionUuid: uuid },
    });
    expect(a.sessionUuid).toBe(uuid);
    expect(lastCommand(h)).toContain(`'--resume' '${uuid}'`);
    expect(lastCommand(h)).not.toContain("Your working directory");
    await expect(
      h.core.boxes.create({
        targetDir: dir,
        layout: "root",
        conversation: { mode: "adopt", sessionUuid: uuid },
      }),
    ).rejects.toMatchObject({
      code: "adoption_refused",
    });
    await h.core.boxes.stop(a.id);
    const err = await h.core.boxes
      .create({
        targetDir: dir,
        layout: "root",
        conversation: { mode: "adopt", sessionUuid: uuid },
      })
      .catch((e: ApiError) => e);
    expect(err).toMatchObject({ code: "session_tracked", details: { holders: [a.id] } });
    const b = await h.core.boxes.create({
      targetDir: dir,
      layout: "root",
      force: true,
      conversation: { mode: "adopt", sessionUuid: uuid },
    });
    expect(b.sessionUuid).toBe(uuid);
  });

  it.each([false, true])(
    "lets only one of two concurrent creates adopt a conversation (force %s)",
    async (force) => {
      const h = makeHarness();
      const dir = h.dir("app");
      const uuid = "6f1c3a52-6d8b-4f43-9a51-2d5b7cbd3f10";
      const req = {
        targetDir: dir,
        layout: "root" as const,
        force,
        conversation: { mode: "adopt" as const, sessionUuid: uuid },
      };
      const results = await Promise.allSettled([
        h.core.boxes.create(req),
        h.core.boxes.create(req),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
      const rejected = results.find((r) => r.status === "rejected");
      expect(rejected?.reason).toMatchObject({ code: "adoption_refused" });
      expect(h.core.db.boxes.bySession(uuid)).toHaveLength(1);
    },
  );

  it("refuses a forced adoption while the holder is starting", async () => {
    const h = makeHarness();
    const dir = h.dir("app");
    const uuid = "6f1c3a52-6d8b-4f43-9a51-2d5b7cbd3f10";
    const a = await h.core.boxes.create({
      targetDir: dir,
      layout: "root",
      start: false,
      conversation: { mode: "adopt", sessionUuid: uuid },
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const atStart = new Promise<void>((resolve) => (reached = resolve));
    let blocked = false;
    h.docker.beforeExec = async (_c, options) => {
      // Holds only the first session start: the holder's.
      if (options.cmd[0] === START_SESSION_PATH && !blocked) {
        blocked = true;
        reached();
        await held;
      }
    };
    const starting = h.core.boxes.start(a.id);
    await atStart;
    await expect(
      h.core.boxes.create({
        targetDir: dir,
        layout: "root",
        force: true,
        conversation: { mode: "adopt", sessionUuid: uuid },
      }),
    ).rejects.toMatchObject({ code: "adoption_refused", details: { holders: [a.id] } });
    release();
    await starting;
  });

  it("forks into a worktree by copying the source transcript first", async () => {
    const h = makeHarness();
    const repo = initRepo(h.dir("repo"));
    const src = await h.core.boxes.create({ targetDir: repo, layout: "root" });
    h.transcript(repo, src.sessionUuid!);
    const fork = await h.core.boxes.create({
      targetDir: repo,
      layout: "worktree",
      conversationName: "Try B",
      conversation: { mode: "fork", fromBoxId: src.id },
    });
    expect(fork.sessionUuid).not.toBe(src.sessionUuid);
    expect(lastCommand(h)).toContain(
      `'--resume' '${src.sessionUuid}' '--fork-session' '--session-id' '${fork.sessionUuid}'`,
    );
    expect(fs.existsSync(h.core.catalog.transcriptPath(fork.worktree!, src.sessionUuid!))).toBe(
      true,
    );
  });

  it("keeps the fork source and the opening prompt for a box created without a start", async () => {
    const h = makeHarness();
    const repo = initRepo(h.dir("repo"));
    const src = await h.core.boxes.create({ targetDir: repo, layout: "root" });
    h.transcript(repo, src.sessionUuid!);
    const fork = await h.core.boxes.create({
      targetDir: repo,
      layout: "worktree",
      conversationName: "Try C",
      conversation: { mode: "fork", fromBoxId: src.id },
      start: false,
    });
    expect(fork.sessionUuid).toBeNull();
    expect(fork.firstStart?.forkFrom).toEqual({ uuid: src.sessionUuid, workDir: repo });
    expect(fork.firstStart?.openingPrompt).toContain(fork.worktree!);

    const started = await h.core.boxes.start(fork.id);
    const command = lastCommand(h);
    expect(command).toContain(
      `'--resume' '${src.sessionUuid}' '--fork-session' '--session-id' '${started.sessionUuid}'`,
    );
    expect(command).toContain(fork.worktree!);
    expect(fs.existsSync(h.core.catalog.transcriptPath(fork.worktree!, src.sessionUuid!))).toBe(
      true,
    );
    expect(started.firstStart).toBeUndefined();
  });

  it("refuses a fork whose transcript is missing", async () => {
    const h = makeHarness();
    const repo = initRepo(h.dir("repo"));
    const src = await h.core.boxes.create({ targetDir: repo, layout: "root" });
    await expect(
      h.core.boxes.create({
        targetDir: repo,
        layout: "worktree",
        conversationName: "B",
        conversation: { mode: "fork", fromBoxId: src.id },
      }),
    ).rejects.toThrow(/no transcript/);
  });

  it("starts Codex and Copilot with their own flags", async () => {
    const h = makeHarness();
    const dir = h.dir("app");
    const codex = await h.core.boxes.create({
      targetDir: dir,
      layout: "workspace",
      conversationName: "Port it",
      platform: "codex",
      skipPermissions: false,
    });
    expect(lastCommand(h)).toMatch(/^env CODEX_HOME='.*codex '.*Your workspace/s);
    expect(codex.platform).toBe("codex");
    await h.core.boxes.create({ targetDir: dir, layout: "root", platform: "copilot" });
    expect(lastCommand(h)).toMatch(
      /^env COPILOT_HOME='.*copilot '--remote' '--allow-all-tools' '-i' '/,
    );
  });

  it("saves without starting when asked", async () => {
    const h = makeHarness();
    const box = await h.core.boxes.create({
      targetDir: h.dir("app"),
      layout: "root",
      start: false,
    });
    expect(box).toMatchObject({ wasRunning: false, sessionUuid: null });
    expect(starts(h)).toEqual([]);
  });

  it("validates the target directory", async () => {
    const h = makeHarness();
    await expect(
      h.core.boxes.create({ targetDir: path.join(h.home, "nope"), layout: "root" }),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      h.core.boxes.create({ targetDir: h.dir("x"), layout: "workspace", conversationName: "!!" }),
    ).rejects.toThrow(/usable characters/);
  });
});

describe("start, stop, restart", () => {
  async function stopped(
    h: Harness,
    extra: Partial<Parameters<Harness["core"]["boxes"]["create"]>[0]> = {},
  ): Promise<Box> {
    const box = await h.core.boxes.create({ targetDir: h.dir("app"), layout: "root", ...extra });
    return h.core.boxes.stop(box.id);
  }

  it("resumes an existing transcript and syncs the title", async () => {
    const h = makeHarness();
    const box = await stopped(h);
    h.transcript(box.targetDir, box.sessionUuid!, [
      { type: "user", message: { role: "user", content: "Do it" } },
      { type: "custom-title", customTitle: "Renamed in Claude" },
    ]);
    await expect(h.core.boxes.start(box.id)).resolves.toMatchObject({
      conversationName: "Renamed in Claude",
      transcriptSyncedName: "Renamed in Claude",
      wasRunning: true,
    });
    expect(lastCommand(h)).toContain(`'--name=Renamed in Claude' '--resume' '${box.sessionUuid}'`);
    await expect(h.core.boxes.start(box.id)).rejects.toMatchObject({ code: "box_running" });
  });

  it("keeps a hand-edited name and mints a session when the transcript is missing", async () => {
    const h = makeHarness();
    const box = await stopped(h);
    await h.core.boxes.update(box.id, { conversationName: "Mine" });
    h.transcript(box.targetDir, box.sessionUuid!, [
      { type: "user", message: { role: "user", content: "x" } },
      { type: "ai-title", aiTitle: "AI" },
    ]);
    expect((await h.core.boxes.start(box.id)).conversationName).toBe("Mine");
    await h.core.boxes.stop(box.id);
    fs.rmSync(h.core.catalog.transcriptPath(box.targetDir, box.sessionUuid!));
    const fresh = await h.core.boxes.start(box.id);
    expect(fresh.sessionUuid).not.toBe(box.sessionUuid);
    expect(lastCommand(h)).toContain(`'--session-id' '${fresh.sessionUuid}'`);
  });

  it("tells a converted box once where it moved", async () => {
    const h = makeHarness();
    const box = await stopped(h);
    const moved = {
      ...h.core.db.boxes.get(box.id)!,
      worktree: path.join(box.targetDir, ".worktrees/x"),
      branch: "claude/x",
      movedFrom: path.join(box.targetDir, "x"),
    };
    fs.mkdirSync(moved.worktree, { recursive: true });
    h.core.db.boxes.put(moved);
    h.transcript(moved.worktree, box.sessionUuid!);
    const started = await h.core.boxes.start(box.id);
    expect(lastCommand(h)).toContain("This conversation was moved into a git worktree.");
    expect(started.movedFrom).toBeUndefined();
  });

  it("resumes Codex with resume --last", async () => {
    const h = makeHarness();
    const box = await stopped(h, { platform: "codex" });
    await h.core.boxes.start(box.id);
    expect(lastCommand(h)).toBe(
      `env CODEX_HOME='${path.join(h.home, ".ai-orchestrator", "accounts", "codex", "fixture")}' AIO_BOX_ID='${box.id}' codex 'resume' '--last' '--dangerously-bypass-approvals-and-sandbox'`,
    );
  });

  it("starts right after a stop while the keeper still lists the session", async () => {
    const h = makeHarness();
    const box = await h.core.boxes.create({ targetDir: h.dir("app"), layout: "root" });
    h.docker.keeperLags = true;
    await h.core.boxes.stop(box.id);
    expect(h.core.boxes.isRunning(box)).toBe(true);
    setTimeout(() => h.docker.tick(), 100);
    await expect(h.core.boxes.start(box.id)).resolves.toMatchObject({ wasRunning: true });
    expect(h.core.boxes.status(h.core.boxes.get(box.id))).toBe("running");
  });

  it("refuses a start when a stopped session never leaves the keeper's list", async () => {
    const h = makeHarness();
    const box = await h.core.boxes.create({ targetDir: h.dir("app"), layout: "root" });
    h.docker.keeperLags = true;
    await h.core.boxes.stop(box.id);
    await expect(h.core.boxes.start(box.id)).rejects.toMatchObject({ code: "box_running" });
  });

  it("stops by killing the session and syncs name, model, and effort", async () => {
    const h = makeHarness();
    const box = await h.core.boxes.create({
      targetDir: h.dir("app"),
      layout: "root",
      model: "claude-opus-5-5",
      effort: "high",
    });
    const sessions = path.join(h.home, ".ai-orchestrator/sessions", box.container);
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(
      path.join(sessions, "11.json"),
      JSON.stringify({
        pid: 11,
        sessionId: box.sessionUuid,
        name: "Live name",
        nameSource: "user",
        updatedAt: 5,
      }),
    );
    fs.writeFileSync(
      path.join(sessions, "12.json"),
      JSON.stringify({
        pid: 12,
        sessionId: "00000000-0000-4000-8000-000000000000",
        name: "Other",
        nameSource: "user",
        updatedAt: 9,
      }),
    );
    h.transcript(box.targetDir, box.sessionUuid!, [
      { type: "user", message: { role: "user", content: "x" } },
      {
        type: "assistant",
        requestedModel: "claude-sonnet-5-5",
        effort: "max",
        message: { model: "claude-sonnet-5-5" },
      },
    ]);
    const after = await h.core.boxes.stop(box.id);
    expect(after).toMatchObject({
      conversationName: "Live name",
      model: "claude-sonnet-5-5",
      effort: "max",
      wasRunning: false,
    });
    expect(h.core.boxes.status(after)).toBe("stopped");
    expect(h.docker.containers.get(box.container)?.sessions.size).toBe(0);
  });

  it("does not sync a model edited since launch or an alias", async () => {
    const h = makeHarness();
    const box = await h.core.boxes.create({
      targetDir: h.dir("app"),
      layout: "root",
      model: "opus",
    });
    h.transcript(box.targetDir, box.sessionUuid!, [
      { type: "assistant", requestedModel: "claude-opus-5-5", message: {} },
    ]);
    expect(await h.core.boxes.syncRecordFromSession(box.id)).toBe(false);
    await h.core.boxes.update(box.id, { model: "claude-haiku-5-5" });
    h.transcript(box.targetDir, box.sessionUuid!, [
      { type: "assistant", requestedModel: "claude-sonnet-5-5", message: {} },
    ]);
    expect(await h.core.boxes.syncRecordFromSession(box.id)).toBe(false);
  });

  it("restarts a running box", async () => {
    const h = makeHarness();
    const box = await h.core.boxes.create({ targetDir: h.dir("app"), layout: "root" });
    await h.core.boxes.restart(box.id);
    expect(starts(h)).toHaveLength(2);
    expect(h.core.boxes.status(h.core.boxes.get(box.id))).toBe("running");
  });

  it("refuses a start while the container's mounts are stale", async () => {
    const h = makeHarness();
    const dir = h.dir("app");
    const a = await h.core.boxes.create({ targetDir: dir, layout: "root" });
    const b = await h.core.boxes.create({ targetDir: dir, layout: "root", start: false });
    const r = await h.core.projects.update(a.projectId, {
      mounts: [{ host: h.dir("extra"), container: "/extra" }],
    });
    expect(r.staleBoxes).toEqual([a.id]);
    await expect(h.core.boxes.start(b.id)).rejects.toMatchObject({ code: "stale_mounts" });
    const restarted = await h.core.boxes.restartProjectContainer(a.projectId);
    expect(restarted.done).toEqual([a.id]);
    await expect(h.core.boxes.start(b.id)).resolves.toMatchObject({ wasRunning: true });
  });

  it("keeps the project container when a box in it fails to stop", async () => {
    const h = makeHarness();
    const dir = h.dir("app");
    const a = await h.core.boxes.create({ targetDir: dir, layout: "root" });
    const b = await h.core.boxes.create({ targetDir: dir, layout: "root" });
    const containerId = h.docker.containers.get(a.container)!.id;
    h.docker.beforeExec = async (_c, options) => {
      if (options.cmd[1] === "kill-session" && options.cmd[3] === `=${b.session}`)
        throw new Error("SYNTHETIC kill failure");
    };
    const result = await h.core.boxes.restartProjectContainer(a.projectId);
    expect(result.done).toEqual([a.id]);
    expect(result.failed.map((f) => f.boxId)).toEqual([b.id]);
    // Same container, and the box that failed to stop still runs.
    expect(h.docker.containers.get(a.container)?.id).toBe(containerId);
    expect(h.core.boxes.isRunning(h.core.boxes.get(b.id))).toBe(true);
    expect(h.core.boxes.isRunning(h.core.boxes.get(a.id))).toBe(true);
  });

  it("refuses to start a box whose conversation a running box holds", async () => {
    const h = makeHarness();
    const a = await stopped(h);
    h.transcript(a.targetDir, a.sessionUuid!);
    const b = await h.core.boxes.create({
      targetDir: a.targetDir,
      layout: "root",
      conversation: { mode: "adopt", sessionUuid: a.sessionUuid! },
      force: true,
      start: false,
    });
    expect(b.sessionUuid).toBe(a.sessionUuid);
    await h.core.boxes.start(a.id);
    await expect(h.core.boxes.start(b.id)).rejects.toMatchObject({ code: "adoption_refused" });
    expect(h.core.boxes.status(h.core.boxes.get(b.id))).toBe("stopped");
  });

  it("keeps an edit made while the box starts", async () => {
    const h = makeHarness();
    const box = await stopped(h, { model: "claude-opus-5-5" });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    h.docker.beforeExec = async (_c, options) => {
      if (options.cmd[0] === START_SESSION_PATH) await held;
    };
    const starting = h.core.boxes.start(box.id);
    await expect.poll(() => h.core.boxes.status(h.core.boxes.get(box.id))).toBe("starting");
    await h.core.boxes.update(box.id, { model: "claude-sonnet-5-5", conversationName: "Edited" });
    release();
    const started = await starting;
    expect(started).toMatchObject({
      model: "claude-sonnet-5-5",
      conversationName: "Edited",
      launchedModel: "claude-opus-5-5",
      wasRunning: true,
    });
    expect(h.core.boxes.get(box.id).model).toBe("claude-sonnet-5-5");
  });

  it("makes a new container when the reused one leaves before the exec", async () => {
    const h = makeHarness();
    const box = await stopped(h);
    const created = h.docker.callsOf("createContainer").length;
    expect(h.docker.containers.get(box.container)?.running).toBe(true);
    let first = true;
    h.docker.beforeExec = async (container, options) => {
      if (first && options.cmd[0] === START_SESSION_PATH) {
        first = false;
        // The idle keeper reaches its grace limit; AutoRemove deletes it.
        h.docker.expireIdle(container);
      }
    };
    await expect(h.core.boxes.start(box.id)).resolves.toMatchObject({ wasRunning: true });
    expect(h.docker.callsOf("createContainer").length).toBe(created + 1);
    expect(h.core.boxes.status(h.core.boxes.get(box.id))).toBe("running");
  });

  it("starts despite stale mounts with force", async () => {
    const h = makeHarness();
    const dir = h.dir("app");
    await h.core.boxes.create({ targetDir: dir, layout: "root" });
    const b = await h.core.boxes.create({ targetDir: dir, layout: "root", start: false });
    await h.core.projects.update(b.projectId, {
      mounts: [{ host: h.dir("extra"), container: "/extra" }],
    });
    await expect(h.core.boxes.start(b.id, { force: true })).resolves.toMatchObject({
      wasRunning: true,
    });
    expect(h.core.boxes.status(h.core.boxes.get(b.id))).toBe("running");
  });
});

describe("remove and purge", () => {
  it("refuses a running box and removes the record and sessions directory", async () => {
    const h = makeHarness();
    const box = await h.core.boxes.create({ targetDir: h.dir("app"), layout: "root" });
    await expect(h.core.boxes.remove(box.id)).rejects.toMatchObject({ code: "box_running" });
    await h.core.boxes.stop(box.id);
    const sessions = path.join(h.home, ".ai-orchestrator/sessions", box.id);
    fs.mkdirSync(sessions, { recursive: true });
    expect(await h.core.boxes.remove(box.id)).toEqual({
      removed: true,
      worktree: "none",
      reason: null,
    });
    expect(fs.existsSync(sessions)).toBe(false);
    expect(() => h.core.boxes.get(box.id)).toThrow(ApiError);
    const last = h.events.at(-1)!;
    expect(last).toMatchObject({ type: "box.changed", boxId: box.id, box: null });
    assertContractEvent(last);
  });

  it("removes a clean worktree when asked and refuses a dirty one", async () => {
    const h = makeHarness();
    const repo = initRepo(h.dir("repo"));
    const clean = await h.core.boxes.create({
      targetDir: repo,
      layout: "worktree",
      conversationName: "clean",
    });
    const dirty = await h.core.boxes.create({
      targetDir: repo,
      layout: "worktree",
      conversationName: "dirty",
    });
    await h.core.boxes.stopAll();
    write(path.join(dirty.worktree!, "new.txt"), "x");
    expect(await h.core.boxes.remove(clean.id, { removeWorktree: true })).toMatchObject({
      worktree: "removed",
    });
    expect(fs.existsSync(clean.worktree!)).toBe(false);
    expect(await h.core.boxes.remove(dirty.id, { removeWorktree: true })).toMatchObject({
      worktree: "refused",
      reason: expect.stringContaining("uncommitted"),
    });
    expect(fs.existsSync(dirty.worktree!)).toBe(true);
  });

  it("purges transcripts and records for the directory only", async () => {
    const h = makeHarness();
    const repo = initRepo(h.dir("repo"));
    const a = await h.core.boxes.create({ targetDir: repo, layout: "root" });
    const b = await h.core.boxes.create({
      targetDir: repo,
      layout: "worktree",
      conversationName: "wt",
    });
    const other = await h.core.boxes.create({ targetDir: h.dir("other"), layout: "root" });
    h.transcript(repo, a.sessionUuid!);
    h.transcript(b.worktree!, b.sessionUuid!);
    h.transcript(other.targetDir, other.sessionUuid!);
    await expect(h.core.boxes.purge(a.id)).rejects.toMatchObject({ code: "box_running" });
    await h.core.boxes.stop(a.id);
    await h.core.boxes.stop(b.id);
    const preview = await h.core.boxes.purge(a.id, { dryRun: true });
    expect(preview.dryRun).toBe(true);
    expect(preview.removedRecords.sort()).toEqual([a.id, b.id].sort());
    expect(preview.removedTranscriptDirs).toHaveLength(2);
    expect(fs.existsSync(h.core.catalog.projectDirFor(repo))).toBe(true);
    expect(h.core.db.boxes.list()).toHaveLength(3);
    const r = await h.core.boxes.purge(a.id);
    expect(r.dryRun).toBe(false);
    expect(r.removedRecords.sort()).toEqual([a.id, b.id].sort());
    expect(r.removedTranscriptDirs).toEqual([
      h.core.catalog.projectDirFor(repo),
      h.core.catalog.projectDirFor(b.worktree!),
    ]);
    expect(fs.existsSync(repo)).toBe(true);
    expect(fs.existsSync(b.worktree!)).toBe(true);
    expect(fs.existsSync(h.core.catalog.transcriptPath(other.targetDir, other.sessionUuid!))).toBe(
      true,
    );
    expect(h.core.db.boxes.list().map((x) => x.id)).toEqual([other.id]);
  });
});

describe("purge and move during a start", () => {
  it("refuses while a box of the directory is starting", async () => {
    const h = makeHarness();
    const dir = h.dir("app");
    const a = await h.core.boxes.create({ targetDir: dir, layout: "root" });
    await h.core.boxes.stop(a.id);
    const b = await h.core.boxes.create({ targetDir: dir, layout: "root", start: false });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    h.docker.beforeExec = async (_c, options) => {
      if (options.cmd[0] === START_SESSION_PATH) await held;
    };
    const starting = h.core.boxes.start(b.id);
    await expect.poll(() => h.core.boxes.status(h.core.boxes.get(b.id))).toBe("starting");
    await expect(h.core.boxes.purge(a.id)).rejects.toMatchObject({ code: "box_running" });
    await expect(h.core.boxes.move(a.id, path.join(h.home, "moved"))).rejects.toMatchObject({
      code: "box_running",
    });
    release();
    await starting;
  });
});

describe("move and relink", () => {
  it("moves the directory, its transcripts, every record, and the project settings", async () => {
    const h = makeHarness();
    const dir = h.dir("old", "app");
    const a = await h.core.boxes.create({ targetDir: dir, layout: "root" });
    const b = await h.core.boxes.create({ targetDir: dir, layout: "root", start: false });
    await h.core.projects.update(a.projectId, {
      name: "Custom",
      tcpMaps: [{ host: 9000, container: 3000 }],
    });
    h.transcript(dir, a.sessionUuid!);
    await expect(h.core.boxes.move(a.id, path.join(h.home, "new", "app"))).rejects.toMatchObject({
      code: "box_running",
    });
    await h.core.boxes.stop(a.id);
    fs.mkdirSync(path.join(h.home, "new"));
    const target = path.join(h.home, "new", "app");
    expect((await h.core.boxes.move(a.id, target)).movedBoxes.sort()).toEqual([a.id, b.id].sort());
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.existsSync(h.core.catalog.transcriptPath(target, a.sessionUuid!))).toBe(true);
    const moved = h.core.boxes.get(a.id);
    expect(moved.targetDir).toBe(target);
    expect(moved.projectId).not.toBe(a.projectId);
    expect(moved.container).toBe(`aio-agent-proj-${moved.projectId}`);
    expect(h.core.projects.get(moved.projectId)).toMatchObject({
      name: "Custom",
      tcpMaps: [{ host: 9000, container: 3000 }],
    });
    expect(() => h.core.projects.get(a.projectId)).toThrow(ApiError);
    await expect(h.core.boxes.move(a.id, target)).resolves.toEqual({ movedBoxes: [] });
  });

  it("refuses to move a directory that holds a worktree box", async () => {
    const h = makeHarness();
    const repo = initRepo(h.dir("repo"));
    const plain = await h.core.boxes.create({ targetDir: repo, layout: "root", start: false });
    const wt = await h.core.boxes.create({
      targetDir: repo,
      layout: "worktree",
      conversationName: "feature",
    });
    await h.core.boxes.stop(wt.id);
    const target = path.join(h.home, "moved");
    await expect(h.core.boxes.move(plain.id, target)).rejects.toMatchObject({ code: "conflict" });
    expect(fs.existsSync(repo)).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
    expect(h.core.boxes.get(wt.id).worktree).toBe(wt.worktree);
    // The .worktrees folder alone is enough, such as one made by hand.
    await h.core.boxes.remove(wt.id);
    await expect(h.core.boxes.move(plain.id, target)).rejects.toMatchObject({ code: "conflict" });
  });

  it("relinks one record to another directory", async () => {
    const h = makeHarness();
    const box = await h.core.boxes.create({
      targetDir: h.dir("one"),
      layout: "root",
      start: false,
    });
    const two = h.dir("two");
    const r = await h.core.boxes.relink(box.id, two);
    expect(r).toMatchObject({ targetDir: two, container: `aio-agent-proj-${r.projectId}` });
    expect(fs.existsSync(path.join(h.home, "one"))).toBe(true);
    await expect(h.core.boxes.relink(box.id, path.join(h.home, "missing"))).rejects.toMatchObject({
      code: "validation",
    });
  });
});

describe("edit, platform, side sessions, messages", () => {
  it("edits fields and reports when a restart is needed", async () => {
    const h = makeHarness();
    const box = await h.core.boxes.create({
      targetDir: h.dir("app"),
      layout: "root",
      model: "opus",
    });
    expect((await h.core.boxes.update(box.id, { conversationName: "New" })).restartRequired).toBe(
      false,
    );
    const r = await h.core.boxes.update(box.id, { model: null, effort: "low" });
    expect(r.restartRequired).toBe(true);
    expect(r.box.model).toBeUndefined();
    expect(r.box.effort).toBe("low");
    const other = await h.core.boxes.create({ targetDir: box.targetDir, layout: "root" });
    await expect(
      h.core.boxes.update(box.id, { sessionUuid: other.sessionUuid }),
    ).rejects.toMatchObject({ code: "adoption_refused" });
    await h.core.boxes.stop(other.id);
    await expect(
      h.core.boxes.update(box.id, { sessionUuid: other.sessionUuid }),
    ).rejects.toMatchObject({ code: "session_tracked" });
    expect(
      (await h.core.boxes.update(box.id, { sessionUuid: other.sessionUuid, force: true })).box
        .sessionUuid,
    ).toBe(other.sessionUuid);
    expect((await h.core.boxes.update(box.id, { sessionUuid: null })).box.sessionUuid).toBeNull();
  });

  it("changes the platform and restarts when asked", async () => {
    const h = makeHarness();
    const box = await h.core.boxes.create({ targetDir: h.dir("app"), layout: "root" });
    await h.core.boxes.setPlatform(box.id, "copilot", true);
    expect(lastCommand(h)).toBe(
      `env COPILOT_HOME='${path.join(h.home, ".ai-orchestrator", "accounts", "copilot", "fixture")}' AIO_BOX_ID='${box.id}' copilot '--remote' '--continue' '--allow-all-tools'`,
    );
  });

  it("starts and stops side sessions", async () => {
    const h = makeHarness();
    const box = await h.core.boxes.create({ targetDir: h.dir("app"), layout: "root" });
    expect(await h.core.boxes.startSideSession(box.id, "codex")).toEqual({
      session: `${box.session}-codex`,
    });
    expect(lastCommand(h)).toBe(
      `env CODEX_HOME='${path.join(h.home, ".ai-orchestrator", "accounts", "codex", "fixture")}' AIO_BOX_ID='${box.id}' codex 'remote-control' '--no-daemon'`,
    );
    expect(h.core.boxes.view(h.core.boxes.get(box.id)).sideSessions).toEqual(["codex"]);
    await expect(h.core.boxes.startSideSession(box.id, "codex")).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(h.core.boxes.startSideSession(box.id, "claude")).rejects.toMatchObject({
      code: "conflict",
    });
    await h.core.boxes.stopSideSession(box.id, "codex");
    expect(h.core.boxes.view(h.core.boxes.get(box.id)).sideSessions).toEqual([]);
    await h.core.boxes.stop(box.id);
    await expect(h.core.boxes.startSideSession(box.id, "copilot")).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("sends a message", async () => {
    const h = makeHarness();
    const box = await h.core.boxes.create({ targetDir: h.dir("app"), layout: "root" });
    await h.core.boxes.sendMessage(box.id, "Hold edits, please.");
    await h.core.boxes.sendMessage(box.id, "- fix the tests");
    expect(h.docker.containers.get(box.container)?.sentKeys.get(box.session)).toEqual([
      "-l Hold edits, please.",
      "Enter",
      "-l - fix the tests",
      "Enter",
    ]);
    const cmds = h.docker
      .callsOf("exec")
      .map((c) => (c.args[1] as { cmd: string[] }).cmd)
      .filter((cmd) => cmd[1] === "send-keys");
    expect(cmds[0]).toEqual([
      "tmux",
      "send-keys",
      "-t",
      `=${box.session}:`,
      "-l",
      "--",
      "Hold edits, please.",
    ]);
  });

  it("builds proxy links from the engine's listeners", async () => {
    const h = makeHarness();
    const box = await h.core.boxes.create({ targetDir: h.dir("app"), layout: "root" });
    h.core.setHooks({
      listeners: () => [
        { port: 5173, proto: "tcp", process: "node", boxId: box.id },
        { port: 8080, proto: "tcp", process: "java", boxId: null },
      ],
      reviewState: () => ({ state: "under_review", runId: "01HZY3D5Q9B8M6V4T2R0P8N6K4" }),
    });
    const view = BoxViewSchema.parse(h.core.boxes.view(box));
    expect(view.proxyUrls).toEqual([{ port: 5173, url: "http://5173.app.localhost:21401/" }]);
    expect(view.reviewState.state).toBe("under_review");
  });
});

describe("bulk actions and reboot", () => {
  it("stops all, offers resume candidates, starts the ones that were running", async () => {
    const h = makeHarness();
    const dir = h.dir("app");
    const a = await h.core.boxes.create({ targetDir: dir, layout: "root" });
    await h.core.boxes.create({ targetDir: dir, layout: "root", start: false });
    expect(h.core.boxes.resumeCandidates()).toEqual([]);
    // A reboot: the container is gone and the record still says it was running.
    h.docker.containers.clear();
    fs.rmSync(path.join(h.home, ".ai-orchestrator/state"), { recursive: true, force: true });
    expect(h.core.boxes.resumeCandidates()).toEqual([a.id]);
    const r = await h.core.boxes.startAll(true);
    expect(r).toEqual({ done: [a.id], failed: [] });
    expect((await h.core.boxes.stopAll()).done).toEqual([a.id]);
    const all = await h.core.boxes.startAll(false);
    expect(all.done).toHaveLength(2);
    const restarted = await h.core.boxes.restartAll();
    expect(restarted.done).toHaveLength(2);
  });

  it("reports per-box failures in bulk results", async () => {
    const h = makeHarness();
    const box = await h.core.boxes.create({
      targetDir: h.dir("app"),
      layout: "root",
      start: false,
    });
    h.docker.images.clear();
    const r = await h.core.boxes.startAll(false);
    expect(r.failed).toEqual([
      { boxId: box.id, error: expect.objectContaining({ code: "image_missing" }) },
    ]);
  });
});

describe("convert to worktree", () => {
  it("turns a workspace clone into a worktree through the service", async () => {
    const h = makeHarness();
    const { origin, project } = originAndProject(h.dir("root"));
    const box = await h.core.boxes.create({
      targetDir: project,
      layout: "workspace",
      conversationName: "Feature",
    });
    await h.core.boxes.stop(box.id);
    const clone = path.join(project, "Feature");
    fs.rmSync(clone, { recursive: true });
    initRepo(clone, origin);
    write(path.join(clone, "work.txt"), "w");
    commitAll(clone, "Work");
    await expect(h.core.boxes.start(box.id)).resolves.toBeDefined();
    await expect(h.core.boxes.convertToWorktree(box.id)).rejects.toMatchObject({
      code: "box_running",
    });
    await expect(h.core.boxes.planConvertToWorktree(box.id)).rejects.toMatchObject({
      code: "box_running",
    });
    await h.core.boxes.stop(box.id);
    const plan = await h.core.boxes.planConvertToWorktree(box.id);
    expect(plan.report).toContain(`Worktree:    ${path.join(project, ".worktrees/Feature")}`);
    expect(plan.buildOutputBytes).toBe(0);
    expect(h.core.boxes.get(box.id).worktree).toBeUndefined();
    const logged: string[] = [];
    const r = await h.core.boxes.convertToWorktree(box.id, {}, (t) => logged.push(t));
    expect(logged.join("")).toContain("Converted");
    expect(r).toMatchObject({
      worktree: path.join(project, ".worktrees/Feature"),
      branch: "claude/Feature",
    });
    expect(h.core.boxes.get(box.id)).toMatchObject({ worktree: r.worktree, movedFrom: clone });
    expect(h.core.boxes.get(box.id).workspace).toBeUndefined();
  });

  it("refuses a plan for a box without a workspace clone", async () => {
    const h = makeHarness();
    const box = await h.core.boxes.create({
      targetDir: h.dir("app"),
      layout: "root",
      start: false,
    });
    await expect(h.core.boxes.planConvertToWorktree(box.id)).rejects.toMatchObject({
      code: "conflict",
    });
  });
});

describe("conversations", () => {
  it("lists transcripts with the boxes that track them", async () => {
    const h = makeHarness();
    const box = await h.core.boxes.create({ targetDir: h.dir("app"), layout: "root" });
    h.transcript(box.targetDir, box.sessionUuid!);
    const list = await h.core.catalog.conversations(box.targetDir);
    expect(list).toEqual([
      expect.objectContaining({
        sessionUuid: box.sessionUuid,
        trackedBy: [box.id],
        turns: 1,
        title: "Hello there",
      }),
    ]);
  });
});
