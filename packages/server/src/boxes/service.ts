// Boxes: create (new, adopt, fork), start, stop, restart, remove, purge,
// move, relink, edit, convert to worktree, side sessions, platform, and the
// bulk actions. Ported from 3.3.5 `DockerBackend` and the `MainWindow`
// handlers that wrap it (inventory sections 1.5, 4.4, 4.5, and 4.6).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  BoxCreateSchema,
  BoxInputSchema,
  BoxUpdateSchema,
  boxWorkDir,
  expandTemplate,
  projectContainerName,
  proxyPortOf,
  withSecretsHint,
  type Box,
  type BoxCreate,
  type BoxStatus,
  type BoxView,
  type ConversationSummary,
  type ConvertToWorktreeResult,
  type Platform,
  type Project,
} from "@agentbox/contracts";
import type { z } from "zod";
import { listConversations, titleForUuid, transcriptExists } from "../catalog/conversations.js";
import { projectDirFor, transcriptPath } from "../catalog/paths.js";
import {
  liveModelAndEffort,
  liveSessionName,
  readSessionEntries,
  sameModel,
} from "../catalog/sessions.js";
import type { Repositories } from "../db/repositories.js";
import { buildSessionCommand, sessionStartCmd } from "../docker/scripts.js";
import { allLiveSessions, liveSessions } from "../docker/state.js";
import { isContainerGone, type DockerClient, type ExecResult } from "../docker/types.js";
import { detectPrimaryRepo, normalizeRoot } from "../projects/ids.js";
import type { ProjectService } from "../projects/service.js";
import { PLATFORMS, allocateHostKey, boxTmuxSession, sideSessionName } from "../records/box.js";
import {
  homePaths,
  hostToContainer,
  promptPath,
  sessionsDirFor,
  type HostEnv,
} from "../records/env.js";
import { ApiError, messageOf, notFound } from "../records/errors.js";
import type { CoreEvents } from "../records/events.js";
import type { CoreHooks } from "../records/hooks.js";
import { KeyedMutex } from "../records/mutex.js";
import type { SettingsService } from "../records/settings.js";
import {
  executeMigration,
  planMigration,
  planReport,
  type MigrationPlan,
} from "../worktrees/migration.js";
import {
  addWorktree,
  branchFor,
  ensureExcluded,
  ensureNotesDir,
  ensureWorktreeNotesDir,
  infraFile,
  removeWorktree,
  worktreePath,
} from "../worktrees/worktrees.js";
import {
  baseClaudeArgs,
  movedMessage,
  nameArg,
  platformArgs,
  pushPrompt,
  sideSessionArgs,
} from "./args.js";
import { slugifyIssueName, uniqueBoxName } from "./names.js";

export type BoxCreateInput = z.input<typeof BoxCreateSchema>;
export type BoxUpdateInput = z.input<typeof BoxUpdateSchema>;

export interface BulkResult {
  done: string[];
  failed: {
    boxId: string;
    error: { code: ApiError["code"]; message: string; details?: unknown };
  }[];
}

export interface BoxServiceDeps {
  env: HostEnv;
  repos: Repositories;
  docker: DockerClient;
  events: CoreEvents;
  settings: SettingsService;
  projects: ProjectService;
  hooks: () => CoreHooks;
  /** Milliseconds a stopped session may take to leave the keeper's list. */
  sessionGoneTimeoutMs?: number;
}

/** How long a `starting` or `stopping` mark lasts without confirmation. */
const TRANSITION_MS = 10_000;

function parseInput<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw new ApiError(
      "validation",
      r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
      { issues: r.error.issues },
    );
  }
  return r.data;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function toBulkError(err: unknown): BulkResult["failed"][number]["error"] {
  if (err instanceof ApiError) {
    const e: BulkResult["failed"][number]["error"] = { code: err.code, message: err.message };
    if (err.details !== undefined) e.details = err.details;
    return e;
  }
  return { code: "conflict", message: messageOf(err) };
}

export class BoxService {
  private readonly transitions = new Map<
    string,
    { status: "starting" | "stopping"; until: number }
  >();
  /** Boxes whose stop a person asked for, so the monitor does not call it unexpected. */
  private readonly requestedStops = new Map<string, number>();
  private readonly converting = new Set<string>();
  /** Serializes the part of `create()` that picks a name and saves the record. */
  private readonly createLock = new KeyedMutex();

  constructor(private readonly deps: BoxServiceDeps) {}

  private get repos() {
    return this.deps.repos;
  }

  private get env() {
    return this.deps.env;
  }

  private now(): string {
    return this.env.now().toISOString();
  }

  get(id: string): Box {
    return this.repos.boxes.get(id) ?? notFound(`The box ${id}`);
  }

  private project(box: Box): Project {
    return this.deps.projects.get(box.projectId);
  }

  // -------------------------------------------------------------------------
  // Status and views

  /** Whether the box's tmux session is live in its container, by the keeper's state file. */
  isRunning(box: Box): boolean {
    return liveSessions(this.env, box.container).includes(boxTmuxSession(box));
  }

  status(box: Box): BoxStatus {
    const running = this.isRunning(box);
    const t = this.transitions.get(box.id);
    if (t) {
      const settled = t.status === "starting" ? running : !running;
      if (settled || Date.now() > t.until) this.transitions.delete(box.id);
      else return t.status;
    }
    return running ? "running" : "stopped";
  }

  /** Whether a person asked for this box's last stop; consumed by the monitor. */
  takeRequestedStop(boxId: string): boolean {
    const at = this.requestedStops.get(boxId);
    this.requestedStops.delete(boxId);
    return at !== undefined && Date.now() - at < 60_000;
  }

  private mark(box: Box, status: "starting" | "stopping"): void {
    this.transitions.set(box.id, { status, until: Date.now() + TRANSITION_MS });
    this.publish(box, status);
  }

  private publish(box: Box | null, status: BoxStatus, id?: string): void {
    this.deps.events.publish({
      type: "box.changed",
      boxId: box?.id ?? (id as string),
      status,
      box,
    });
  }

  /** The record plus live and derived state, as the apps show it. */
  view(box: Box, stats: BoxView["stats"] = null): BoxView {
    const hooks = this.deps.hooks();
    const live = new Set(liveSessions(this.env, box.container));
    const settings = this.deps.settings.get();
    const proxyPort = proxyPortOf(settings);
    const listeners = hooks.listeners(box.container).filter((l) => l.boxId === box.id);
    return {
      box,
      status: this.status(box),
      container: box.container,
      tmuxSession: boxTmuxSession(box),
      reviewState: hooks.reviewState(box.id),
      stats,
      listeners,
      proxyUrls: listeners.map((l) => ({
        port: l.port,
        url: `http://${l.port}.${box.hostKey}.localhost:${proxyPort}/`,
      })),
      sideSessions: PLATFORMS.filter(
        (p) => p !== box.platform && live.has(sideSessionName(box, p)),
      ),
      targetDirExists: isDirectory(box.targetDir),
    };
  }

  list(projectId?: string): Box[] {
    return projectId === undefined
      ? this.repos.boxes.list()
      : this.repos.boxes.byProject(projectId);
  }

  // -------------------------------------------------------------------------
  // Sessions

  /**
   * Starts `program args` as tmux session `session` in the box's container,
   * creating the container when needed (twice, for a container that is on its
   * way out just as it is reached).
   */
  private async startSession(
    box: Box,
    program: string,
    args: string[],
    session = boxTmuxSession(box),
    options: { force?: boolean } = {},
  ): Promise<void> {
    const command = buildSessionCommand(program, args);
    const workDir = hostToContainer(boxWorkDir(box));
    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ensured = await this.deps.projects.ensureContainer(box.projectId);
      if (ensured.stale.length > 0 && !options.force) {
        throw new ApiError(
          "stale_mounts",
          `The container ${ensured.container} runs with old settings (${ensured.stale.join(", ")}). Restart it first.`,
          { container: ensured.container, differences: ensured.stale },
        );
      }
      let r: ExecResult;
      try {
        r = await this.deps.docker.exec(box.container, {
          cmd: sessionStartCmd(session, workDir, command),
          user: this.env.user,
          timeoutMs: 60_000,
        });
      } catch (err) {
        // The container left between ensureContainer() and the exec: its
        // keeper reached the end of its grace period. Make a new one.
        if (!isContainerGone(err)) throw err;
        lastError = messageOf(err);
        continue;
      }
      if (r.exitCode === 0) return;
      lastError = (r.stderr || r.stdout).trim();
      if (r.exitCode === 3)
        throw new ApiError("box_running", lastError || `Session ${session} is already running.`);
      const inspect = await this.deps.docker.inspectContainer(box.container);
      if (inspect?.running) break;
    }
    throw new ApiError("conflict", `Could not start the session: ${lastError || "unknown error"}.`);
  }

  private async killSession(container: string, session: string): Promise<void> {
    const inspect = await this.deps.docker.inspectContainer(container);
    if (!inspect?.running) return;
    let r: ExecResult;
    try {
      r = await this.deps.docker.exec(container, {
        cmd: ["tmux", "kill-session", "-t", `=${session}`],
        user: this.env.user,
        timeoutMs: 15_000,
      });
    } catch (err) {
      // A container that left took the session with it.
      if (isContainerGone(err)) return;
      throw err;
    }
    if (r.exitCode !== 0 && !`${r.stderr}${r.stdout}`.includes("can't find session")) {
      throw new ApiError(
        "conflict",
        `Could not stop session ${session}: ${(r.stderr || r.stdout).trim()}`,
      );
    }
  }

  /** Waits until a session leaves the keeper's list; returns whether it did. */
  private async waitSessionGone(box: Box): Promise<boolean> {
    const deadline = Date.now() + (this.deps.sessionGoneTimeoutMs ?? 5000);
    while (this.isRunning(box)) {
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Create

  /** The resolved layout for `auto`, from the remembered per-directory choices. */
  resolveLayout(targetDir: string, project: Project): "worktree" | "workspace" | "root" {
    const d = this.deps.settings.get().newBoxDefaults;
    if (project.primaryRepo && d.worktreeDirs[targetDir] !== false) return "worktree";
    const remembered = d.workspaceDirs[targetDir];
    // A tree that still has an executable new-issue.sh is organised into
    // per-issue folders; an explicit "no" outranks that.
    if (remembered === true) return "workspace";
    if (remembered === undefined && isExecutable(path.join(targetDir, "new-issue.sh")))
      return "workspace";
    return "root";
  }

  /**
   * Refuses to hand a session to a second box: a running holder always, a
   * stopped one unless `force`.
   */
  private checkAdoption(sessionUuid: string, exceptBoxId: string | null, force: boolean): void {
    const holders = this.repos.boxes.bySession(sessionUuid).filter((b) => b.id !== exceptBoxId);
    // A starting holder counts as running: the keeper lists a new session
    // about a second late.
    const running = holders.find((b) => this.isRunning(b) || this.transitions.has(b.id));
    if (running) {
      throw new ApiError(
        "adoption_refused",
        `The running box ${running.id} already holds this conversation.`,
        {
          holders: [running.id],
        },
      );
    }
    if (holders.length > 0 && !force) {
      throw new ApiError(
        "session_tracked",
        `The box ${holders.map((b) => b.id).join(", ")} already tracks this conversation.`,
        {
          holders: holders.map((b) => b.id),
        },
      );
    }
  }

  /** Every name a new box must not take. */
  private takenNames(containers: string[]): Set<string> {
    return new Set([
      ...containers,
      ...this.repos.boxes.list().map((b) => b.id),
      ...allLiveSessions(this.env),
    ]);
  }

  /**
   * Checks a `boxes.create` body before the create job starts, so the
   * request itself fails with `validation`, `adoption_refused`,
   * `session_tracked`, `image_missing`, or `engine_mismatch`. `create()`
   * repeats the checks, since the state can change in between.
   */
  async validateCreate(input: BoxCreateInput): Promise<void> {
    const req: BoxCreate = parseInput(BoxCreateSchema, input);
    if (!isDirectory(normalizeRoot(path.resolve(req.targetDir))))
      throw new ApiError("validation", `${req.targetDir} is not a directory.`);
    if (req.conversation.mode === "adopt") {
      this.checkAdoption(req.conversation.sessionUuid, null, req.force);
    } else if (req.conversation.mode === "fork") {
      const source = this.get(req.conversation.fromBoxId);
      if (!source.sessionUuid)
        throw new ApiError("conflict", `The box ${source.id} has no conversation to fork.`);
    }
    if (req.start) await this.deps.projects.checkImage();
  }

  /**
   * `boxes.create`. Provisions the worktree or workspace, builds the opening
   * prompt, picks a unique name, and starts the session (unless `start` is
   * false). A worktree this call made is removed again when the start fails.
   */
  async create(input: BoxCreateInput): Promise<Box> {
    const req: BoxCreate = parseInput(BoxCreateSchema, input);
    const targetDir = normalizeRoot(path.resolve(req.targetDir));
    if (!isDirectory(targetDir))
      throw new ApiError("validation", `${req.targetDir} is not a directory.`);
    const project = this.deps.projects.ensureForRoot(targetDir);
    const settings = this.deps.settings.get();
    const templates = settings.promptTemplates;

    let adoptUuid: string | null = null;
    let forkFrom: { uuid: string; workDir: string } | null = null;
    if (req.conversation.mode === "adopt") {
      adoptUuid = req.conversation.sessionUuid;
      this.checkAdoption(adoptUuid, null, req.force);
    } else if (req.conversation.mode === "fork") {
      const source = this.get(req.conversation.fromBoxId);
      if (!source.sessionUuid) {
        throw new ApiError("conflict", `The box ${source.id} has no conversation to fork.`);
      }
      forkFrom = { uuid: source.sessionUuid, workDir: boxWorkDir(source) };
    }
    const resumeExisting = adoptUuid !== null;

    let layout = req.layout === "auto" ? this.resolveLayout(targetDir, project) : req.layout;
    if (req.rememberLayout) {
      this.deps.settings.rememberLayout(targetDir, {
        workspace: layout === "workspace",
        worktree: project.primaryRepo ? layout === "worktree" : undefined,
      });
    }
    if (layout === "worktree" && !project.primaryRepo) {
      if (req.layout === "worktree") {
        throw new ApiError(
          "conflict",
          "This project has no git repository to make a worktree from.",
        );
      }
      layout = "root";
    }

    // Name, worktree, and record are settled under one lock, so two creates
    // that want the same name (a double-clicked Create) can't both take it,
    // and the second sees the first one's worktree as existing. The adoption
    // check repeats here for the same reason: the second of two creates that
    // adopt one conversation sees the first one's record, marked starting.
    const prepared = await this.createLock.run("create", async () => {
      if (adoptUuid !== null) this.checkAdoption(adoptUuid, null, req.force);
      let conversationName = req.conversationName.trim();
      const provision = !resumeExisting && conversationName !== "" && layout !== "root";
      let slug = "";
      let openingPrompt = "";
      let worktree: string | undefined;
      let branch: string | undefined;
      let workspace: string | undefined;
      let createdWorktree: { repo: string; path: string } | null = null;

      if (provision) {
        slug = slugifyIssueName(conversationName);
        if (slug === "")
          throw new ApiError("validation", "The conversation name has no usable characters.");
        let workPath: string;
        if (layout === "worktree") {
          const repo = project.primaryRepo as string;
          const existed = fs.existsSync(worktreePath(repo, slug));
          const added = await addWorktree(repo, slug);
          if (!added.ok)
            throw new ApiError("conflict", `Could not create the worktree: ${added.error}`);
          workPath = added.path;
          worktree = added.path;
          branch = branchFor(slug);
          if (!existed) createdWorktree = { repo, path: added.path };
        } else {
          workPath = path.join(targetDir, slug);
          if (!isDirectory(workPath)) {
            try {
              fs.mkdirSync(workPath, { recursive: true });
            } catch (err) {
              throw new ApiError(
                "conflict",
                `Could not create the workspace folder ${workPath}: ${messageOf(err)}`,
              );
            }
          }
          workspace = slug;
        }
        const notes = worktree ? ensureWorktreeNotesDir(worktree) : ensureNotesDir(targetDir, slug);
        if (project.primaryRepo) await ensureExcluded(project.primaryRepo);
        const notesPath = promptPath(this.env, notes);
        const infraPath = promptPath(this.env, infraFile(targetDir));
        openingPrompt = worktree
          ? expandTemplate(templates.worktree, [
              slug,
              conversationName,
              promptPath(this.env, workPath),
              notesPath,
              infraPath,
              promptPath(this.env, project.primaryRepo as string),
              branch as string,
            ])
          : expandTemplate(templates.workspace, [
              slug,
              conversationName,
              promptPath(this.env, workPath),
              notesPath,
              infraPath,
            ]);
        conversationName = slug;
      } else if (!resumeExisting && templates.starter !== "") {
        openingPrompt = expandTemplate(templates.starter, [
          conversationName,
          promptPath(this.env, targetDir),
        ]);
      }
      // Every project container gets the broker socket, but only a project
      // with secret references has anything for the agent to ask it for.
      if (settings.secretRefs.length > 0 || project.secretRefs.length > 0)
        openingPrompt = withSecretsHint(openingPrompt);

      const containers = (await this.deps.docker.listContainers({ all: true })).map((c) => c.name);
      const id = uniqueBoxName(slug || path.posix.basename(targetDir), this.takenNames(containers));
      const sessionUuid = adoptUuid ?? crypto.randomUUID();
      if (conversationName === "") conversationName = id;
      const now = this.now();
      const box: Box = BoxInputSchema.parse({
        id,
        projectId: project.id,
        // Unique across every project: the proxy resolves a key without one.
        hostKey: allocateHostKey(id, this.repos.boxes.list()),
        targetDir,
        sessionUuid,
        conversationName,
        transcriptSyncedName: conversationName,
        platform: req.platform,
        model: req.platform === "claude" ? req.model : undefined,
        effort: req.platform === "claude" ? req.effort : undefined,
        skipPermissions: req.skipPermissions,
        workspace,
        worktree,
        branch,
        container: projectContainerName(project.id),
        session: id,
        wasRunning: false,
        sshRemoteRefs: req.sshRemoteRefs,
        createdAt: now,
        updatedAt: now,
      });
      // The record reserves the name before the lock opens. A box saved
      // without a start waits for its first start to resume or mint a
      // session, and keeps what that start needs to open the conversation.
      const firstStart =
        openingPrompt !== "" || forkFrom
          ? { openingPrompt, ...(forkFrom ? { forkFrom } : {}) }
          : undefined;
      const saved = this.repos.boxes.put(
        req.start ? box : { ...box, sessionUuid: adoptUuid, ...(firstStart ? { firstStart } : {}) },
      );
      // Counted as starting before the lock opens, so a concurrent adoption
      // of the same conversation is refused, not run twice.
      if (req.start)
        this.transitions.set(saved.id, { status: "starting", until: Date.now() + TRANSITION_MS });
      return { box: saved, openingPrompt, conversationName, createdWorktree };
    });

    let box = prepared.box;
    const { openingPrompt, conversationName, createdWorktree } = prepared;
    const sessionUuid = box.sessionUuid as string;
    if (!req.start) {
      this.publish(box, "stopped");
      return box;
    }

    let args = [...baseClaudeArgs(box, project), nameArg(conversationName)];
    this.mark(box, "starting");
    try {
      if (forkFrom) {
        await this.copyForkTranscript(forkFrom, boxWorkDir(box));
        args.push("--resume", forkFrom.uuid, "--fork-session", "--session-id", sessionUuid);
      } else {
        args.push(resumeExisting ? "--resume" : "--session-id", sessionUuid);
      }
      pushPrompt(args, openingPrompt);
      if (box.platform !== "claude")
        args = platformArgs(box, project, box.platform, false, openingPrompt);
      await this.startSession(box, box.platform, args);
    } catch (err) {
      this.transitions.delete(box.id);
      this.repos.boxes.delete(box.id);
      // Never take a worktree from under another record.
      if (
        createdWorktree &&
        !this.repos.boxes.list().some((b) => b.worktree === createdWorktree.path)
      )
        await removeWorktree(createdWorktree.repo, createdWorktree.path, this.env.now());
      this.publish(null, "stopped", box.id);
      throw err;
    }
    // Re-read: an edit may have landed while the session started.
    const current = this.repos.boxes.get(box.id) ?? box;
    box = this.repos.boxes.put({
      ...current,
      wasRunning: true,
      launchedModel: box.model,
      launchedEffort: box.effort,
      updatedAt: this.now(),
    });
    this.publish(box, this.status(box));
    return box;
  }

  /**
   * Claude finds a transcript to resume only under its own working
   * directory, so a fork into another directory copies the source first.
   */
  private async copyForkTranscript(
    from: { uuid: string; workDir: string },
    toWorkDir: string,
  ): Promise<void> {
    const fromDir = projectDirFor(this.env, from.workDir);
    const toDir = projectDirFor(this.env, toWorkDir);
    if (fromDir === toDir) return;
    const src = path.join(fromDir, `${from.uuid}.jsonl`);
    const dst = path.join(toDir, `${from.uuid}.jsonl`);
    fs.mkdirSync(toDir, { recursive: true });
    if (fs.existsSync(dst)) return;
    if (!fs.existsSync(src)) {
      throw new ApiError("conflict", `The conversation being forked has no transcript at ${src}.`);
    }
    fs.copyFileSync(src, dst);
  }

  // -------------------------------------------------------------------------
  // Start, stop, restart

  /**
   * `boxes.start` (3.3.5 `reopen`): resumes the transcript when it exists,
   * else starts a fresh session; tells a converted box once where it moved;
   * and syncs the name from the transcript title when the record still
   * matches what was last written there. With `force`, starts the session
   * although the project container runs with stale mounts (3.3.5 "start
   * anyway").
   */
  async start(id: string, options: { syncTitle?: boolean; force?: boolean } = {}): Promise<Box> {
    let box = this.get(id);
    if (this.converting.has(id)) {
      throw new ApiError(
        "conflict",
        `${id} is being converted to a worktree; start it when that finishes.`,
      );
    }
    // The keeper lists a killed session until its next write, about a second
    // later, so a start right after a stop waits for the session to leave.
    if (this.isRunning(box) && this.transitions.get(id)?.status === "stopping") {
      await this.waitSessionGone(box);
    }
    if (this.isRunning(box)) throw new ApiError("box_running", `${id} is already running.`);
    if (box.sessionUuid) {
      // `force` lets a stopped box share a conversation; two running ones
      // would write over each other's transcript.
      const holder = this.repos.boxes
        .bySession(box.sessionUuid)
        .find((b) => b.id !== id && (this.isRunning(b) || this.transitions.has(b.id)));
      if (holder) {
        throw new ApiError(
          "adoption_refused",
          `The running box ${holder.id} already holds this conversation.`,
          { holders: [holder.id] },
        );
      }
    }
    const project = this.project(box);
    const workDir = boxWorkDir(box);

    if (
      (options.syncTitle ?? true) &&
      box.sessionUuid &&
      box.conversationName === box.transcriptSyncedName
    ) {
      const title = await titleForUuid(this.env, workDir, box.sessionUuid);
      if (title !== "" && title !== box.conversationName) {
        box = this.repos.boxes.put({
          ...box,
          conversationName: title,
          transcriptSyncedName: title,
          updatedAt: this.now(),
        });
      }
    }

    const hasTranscript =
      box.sessionUuid !== null && (await transcriptExists(this.env, workDir, box.sessionUuid));
    const sessionUuid = hasTranscript ? (box.sessionUuid as string) : crypto.randomUUID();
    // A box created without a start opens its conversation now, the way
    // create() would have: with the opening prompt, or as a fork.
    const first = hasTranscript ? undefined : box.firstStart;
    let args = baseClaudeArgs(box, project);
    if (box.conversationName !== "") args.push(nameArg(box.conversationName));
    if (first) {
      if (first.forkFrom) {
        args.push("--resume", first.forkFrom.uuid, "--fork-session", "--session-id", sessionUuid);
      } else {
        args.push("--session-id", sessionUuid);
      }
      pushPrompt(args, first.openingPrompt);
    } else {
      args.push(hasTranscript ? "--resume" : "--session-id", sessionUuid);
    }
    if (hasTranscript && box.movedFrom && box.worktree)
      pushPrompt(args, movedMessage(this.env, box));
    if (box.platform !== "claude") {
      args = first
        ? platformArgs(box, project, box.platform, false, first.openingPrompt)
        : platformArgs(box, project, box.platform, true, "");
    }

    this.mark(box, "starting");
    try {
      if (first?.forkFrom && box.platform === "claude") {
        await this.copyForkTranscript(first.forkFrom, workDir);
      }
      await this.startSession(box, box.platform, args, boxTmuxSession(box), {
        force: options.force ?? false,
      });
    } catch (err) {
      this.transitions.delete(box.id);
      this.publish(box, "stopped");
      throw err;
    }
    // Re-read: Edit Box and the session watcher write this record while the
    // session starts. Only the fields a start owns change here.
    const current = this.repos.boxes.get(id) ?? box;
    const next: Box = {
      ...current,
      sessionUuid,
      wasRunning: true,
      launchedModel: box.model,
      launchedEffort: box.effort,
      updatedAt: this.now(),
    };
    delete next.movedFrom;
    delete next.firstStart;
    if (next.launchedModel === undefined) delete next.launchedModel;
    if (next.launchedEffort === undefined) delete next.launchedEffort;
    box = this.repos.boxes.put(next);
    this.publish(box, this.status(box));
    return box;
  }

  /**
   * Catches the record up with the session before it stops: the name from
   * Claude's session file, and the model and effort from the transcript's
   * last assistant entry, unless edited since launch, left to the settings
   * files, or an alias the live id merely resolves from.
   */
  async syncRecordFromSession(id: string): Promise<boolean> {
    const box = this.get(id);
    const shared = box.container !== box.id;
    const dir = sessionsDirFor(this.env, shared ? box.container : box.id);
    const live = liveSessionName(await readSessionEntries(dir), shared ? box.sessionUuid : null);
    const next: Box = { ...box };
    let changed = false;
    if (live && live.name !== "" && live.name !== box.conversationName) {
      next.conversationName = live.name;
      changed = true;
    }
    const uuid = live?.sessionId || box.sessionUuid;
    if (uuid) {
      const { model, effort } = await liveModelAndEffort(
        transcriptPath(this.env, boxWorkDir(box), uuid),
      );
      const modelUntouched = !box.launchedModel || box.model === box.launchedModel;
      if (model && box.model && modelUntouched && !sameModel(box.model, model)) {
        next.model = model;
        changed = true;
      }
      const effortUntouched = !box.launchedEffort || box.effort === box.launchedEffort;
      if (effort && box.effort && effortUntouched && box.effort !== effort) {
        const parsed = BoxInputSchema.shape.effort.safeParse(effort);
        if (parsed.success && parsed.data) {
          next.effort = parsed.data;
          changed = true;
        }
      }
    }
    if (changed) this.repos.boxes.put({ ...next, updatedAt: this.now() });
    return changed;
  }

  /** `boxes.stop`: ends the box's tmux session; the container lingers, then leaves. */
  async stop(id: string): Promise<Box> {
    const box = this.get(id);
    this.requestedStops.set(id, Date.now());
    this.mark(box, "stopping");
    try {
      await this.syncRecordFromSession(id).catch(() => false);
      await this.killSession(box.container, boxTmuxSession(box));
    } catch (err) {
      this.transitions.delete(id);
      this.publish(box, this.status(box));
      throw err;
    }
    const saved = this.repos.boxes.put({
      ...this.get(id),
      wasRunning: false,
      updatedAt: this.now(),
    });
    this.publish(saved, this.status(saved));
    return saved;
  }

  /** `boxes.restart`: stop, wait for the session to leave, start. */
  async restart(id: string): Promise<Box> {
    const box = this.get(id);
    if (this.isRunning(box)) {
      await this.stop(id);
      await this.waitSessionGone(box);
    }
    return this.start(id);
  }

  // -------------------------------------------------------------------------
  // Remove, purge, move, relink

  /**
   * Refuses while a box of the directory runs, or is starting or stopping:
   * the keeper lists a starting session only after a second or two.
   */
  private requireSiblingsStopped(siblings: readonly Box[]): void {
    const busy = siblings.find((b) => this.isRunning(b) || this.transitions.has(b.id));
    if (busy)
      throw new ApiError(
        "box_running",
        `${busy.id} is running against this directory; stop it first.`,
      );
  }

  private requireStopped(box: Box, action: string): void {
    if (this.isRunning(box) || this.transitions.has(box.id)) {
      throw new ApiError("box_running", `Stop ${box.id} before you ${action}.`);
    }
  }

  /**
   * `boxes.remove`: drops the record and its sessions directory; the
   * conversation stays. With `removeWorktree`, removes the worktree only when
   * nothing in it would be lost.
   */
  async remove(
    id: string,
    options: { removeWorktree?: boolean } = {},
  ): Promise<{
    removed: boolean;
    worktree: "removed" | "kept" | "refused" | "none";
    reason: string | null;
  }> {
    const box = this.get(id);
    this.requireStopped(box, "remove it");
    let worktree: "removed" | "kept" | "refused" | "none" = "none";
    let reason: string | null = null;
    if (box.worktree && fs.existsSync(box.worktree)) {
      worktree = "kept";
      if (options.removeWorktree) {
        const repo =
          this.project(box).primaryRepo ?? detectPrimaryRepo(box.targetDir) ?? box.targetDir;
        const r = await removeWorktree(repo, box.worktree, this.env.now());
        if (r.ok) worktree = "removed";
        else {
          worktree = "refused";
          reason = r.reason;
        }
      }
    }
    this.repos.boxes.delete(id);
    fs.rmSync(sessionsDirFor(this.env, id), { recursive: true, force: true });
    this.publish(null, "stopped", id);
    return { removed: true, worktree, reason };
  }

  /**
   * `boxes.purge`: deletes the transcripts of the box's directory (and of
   * each worktree of a box there) and every record for that directory.
   * Never the directory itself, its worktrees, or `~/.claude.json`. With
   * `dryRun`, lists what it would delete and deletes nothing.
   */
  async purge(
    id: string,
    options: { dryRun?: boolean } = {},
  ): Promise<{ dryRun: boolean; removedRecords: string[]; removedTranscriptDirs: string[] }> {
    const dryRun = options.dryRun ?? false;
    const box = this.get(id);
    const dir = box.targetDir;
    const siblings = this.repos.boxes.byTargetDir(dir);
    this.requireSiblingsStopped(siblings);

    const paths = homePaths(this.env);
    const allowed = [`${paths.claudeProjects}/`, `${paths.dataDir}/`];
    const safe = (p: string) => allowed.some((a) => p.startsWith(a));
    const transcriptDirs = new Set<string>();
    const projectDir = projectDirFor(this.env, dir);
    if (isDirectory(projectDir)) transcriptDirs.add(projectDir);
    for (const b of siblings) {
      if (b.worktree) {
        const wt = projectDirFor(this.env, b.worktree);
        if (isDirectory(wt)) transcriptDirs.add(wt);
      }
    }
    const removedTranscriptDirs: string[] = [];
    for (const d of transcriptDirs) {
      if (!safe(d)) continue;
      if (!dryRun) fs.rmSync(d, { recursive: true, force: true });
      removedTranscriptDirs.push(d);
    }
    const removedRecords: string[] = [];
    if (dryRun) return { dryRun, removedRecords: siblings.map((b) => b.id), removedTranscriptDirs };
    for (const b of siblings) {
      this.repos.boxes.delete(b.id);
      const sessions = sessionsDirFor(this.env, b.id);
      if (safe(sessions)) fs.rmSync(sessions, { recursive: true, force: true });
      removedRecords.push(b.id);
      this.publish(null, "stopped", b.id);
    }
    return { dryRun, removedRecords, removedTranscriptDirs };
  }

  /** Points `box` at `dir`'s project and its container. The host key stays unique. */
  private repoint(box: Box, dir: string): Box {
    const project = this.deps.projects.ensureForRoot(dir);
    const others = this.repos.boxes.list().filter((b) => b.id !== box.id);
    return {
      ...box,
      targetDir: dir,
      projectId: project.id,
      container: projectContainerName(project.id),
      hostKey: others.some((b) => b.hostKey === box.hostKey)
        ? allocateHostKey(box.id, others)
        : box.hostKey,
      updatedAt: this.now(),
    };
  }

  /**
   * `boxes.move` (Move Working Directory): renames the directory and its
   * transcript directory, and repoints every record that uses it. The old
   * project's settings carry over to a project created for the new path.
   */
  async move(id: string, newDirIn: string): Promise<{ movedBoxes: string[] }> {
    const box = this.get(id);
    if (box.worktree) throw new ApiError("conflict", "A worktree box cannot be moved.");
    const currentDir = box.targetDir;
    const siblings = this.repos.boxes.byTargetDir(currentDir);
    this.requireSiblingsStopped(siblings);
    // A worktree's record and its git metadata hold absolute paths under the
    // root, so renaming the root would strand every worktree box there.
    const root = normalizeRoot(currentDir);
    const worktreeBox = this.repos.boxes
      .list()
      .find((b) => b.worktree && (b.worktree === root || b.worktree.startsWith(`${root}/`)));
    if (worktreeBox) {
      throw new ApiError(
        "conflict",
        `The worktree box ${worktreeBox.id} lives under ${root}; a directory with worktrees cannot be moved.`,
      );
    }
    if (fs.existsSync(path.join(root, ".worktrees"))) {
      throw new ApiError(
        "conflict",
        `${root} holds git worktrees in .worktrees; a directory with worktrees cannot be moved.`,
      );
    }
    const newDir = normalizeRoot(path.resolve(newDirIn));
    if (newDir === normalizeRoot(currentDir)) return { movedBoxes: [] };
    if (fs.existsSync(newDir)) throw new ApiError("conflict", `${newDir} already exists.`);
    try {
      fs.renameSync(currentDir, newDir);
    } catch (err) {
      throw new ApiError(
        "conflict",
        `Could not move ${currentDir} to ${newDir}: ${messageOf(err)}`,
      );
    }
    const oldProjectDir = projectDirFor(this.env, currentDir);
    const newProjectDir = projectDirFor(this.env, newDir);
    if (
      oldProjectDir !== newProjectDir &&
      isDirectory(oldProjectDir) &&
      !fs.existsSync(newProjectDir)
    ) {
      try {
        fs.renameSync(oldProjectDir, newProjectDir);
      } catch {
        // The directory moved; the history stays findable by hand, as in 3.3.5.
      }
    }

    const oldProject = this.project(box);
    const hadNew = this.repos.projects.byRoot(newDir) !== undefined;
    const newProject = this.deps.projects.ensureForRoot(newDir);
    if (!hadNew && oldProject.root === normalizeRoot(currentDir)) {
      const carried: Project = {
        ...newProject,
        name:
          oldProject.name === path.posix.basename(oldProject.root)
            ? newProject.name
            : oldProject.name,
        tcpMaps: oldProject.tcpMaps,
        mounts: oldProject.mounts,
        secretRefs: oldProject.secretRefs,
        policyPath: oldProject.policyPath,
        updatedAt: this.now(),
      };
      if (oldProject.ceilingsOverride) carried.ceilingsOverride = oldProject.ceilingsOverride;
      this.repos.projects.put(carried);
    }
    const moved: string[] = [];
    this.repos.transaction(() => {
      for (const b of siblings) {
        const next = this.repoint(b, newDir);
        this.repos.boxes.put(next);
        moved.push(b.id);
      }
      if (
        this.repos.boxes.byProject(oldProject.id).length === 0 &&
        !fs.existsSync(oldProject.root)
      ) {
        this.repos.engines.delete(oldProject.id);
        this.repos.projects.delete(oldProject.id);
      }
    });
    for (const m of moved) this.publish(this.get(m), "stopped");
    return { movedBoxes: moved };
  }

  /**
   * `boxes.relink` (Change Working Directory): repoints only this record.
   * The old transcript directory stays, since other sessions may use it.
   */
  async relink(id: string, targetDirIn: string): Promise<Box> {
    const box = this.get(id);
    this.requireStopped(box, "change its directory");
    if (box.worktree) throw new ApiError("conflict", "A worktree box cannot be re-pointed.");
    const targetDir = normalizeRoot(path.resolve(targetDirIn));
    if (!isDirectory(targetDir))
      throw new ApiError("validation", `${targetDirIn} is not a directory.`);
    const saved = this.repos.boxes.put(this.repoint(box, targetDir));
    this.publish(saved, "stopped");
    return saved;
  }

  // -------------------------------------------------------------------------
  // Edit, platform, convert

  /**
   * `boxes.update` (Edit Box). Relinking the conversation follows the
   * adoption rules. A running box keeps the old session id, permissions,
   * model, and effort until it restarts.
   */
  async update(id: string, input: BoxUpdateInput): Promise<{ box: Box; restartRequired: boolean }> {
    const u = parseInput(BoxUpdateSchema, input);
    const box = this.get(id);
    const next: Box = { ...box, updatedAt: this.now() };
    if (u.sessionUuid !== undefined && u.sessionUuid !== box.sessionUuid) {
      if (u.sessionUuid !== null) this.checkAdoption(u.sessionUuid, id, u.force ?? false);
      next.sessionUuid = u.sessionUuid;
    }
    if (u.conversationName !== undefined) next.conversationName = u.conversationName;
    if (u.skipPermissions !== undefined) next.skipPermissions = u.skipPermissions;
    for (const key of ["model", "effort"] as const) {
      const v = u[key];
      if (v === undefined) continue;
      if (v === null) delete next[key];
      else (next as Record<string, unknown>)[key] = v;
    }
    if (u.sshRemoteRefs !== undefined) next.sshRemoteRefs = u.sshRemoteRefs;
    const needsRestart =
      next.sessionUuid !== box.sessionUuid ||
      next.skipPermissions !== box.skipPermissions ||
      next.model !== box.model ||
      next.effort !== box.effort;
    const saved = this.repos.boxes.put(next);
    this.publish(saved, this.status(saved));
    return { box: saved, restartRequired: needsRestart && this.isRunning(saved) };
  }

  /** `boxes.platform`: changes the main CLI, restarting a running box when asked. */
  async setPlatform(id: string, platform: Platform, restart = false): Promise<Box> {
    const box = this.get(id);
    const wasRunning = this.isRunning(box);
    const saved = this.repos.boxes.put({ ...box, platform, updatedAt: this.now() });
    this.publish(saved, this.status(saved));
    if (restart && wasRunning) return this.restart(id);
    return saved;
  }

  /**
   * `boxes.convertToWorktree.plan`: what Convert to Worktree would do, as a
   * report for a person to read. Changes nothing. Throws `box_running` for a
   * running box and `conflict` when the box cannot be converted.
   */
  async planConvertToWorktree(id: string): Promise<{ report: string; buildOutputBytes: number }> {
    const box = this.get(id);
    this.requireNotConverting(box);
    const plan = await this.migrationPlan(box, false);
    return { report: planReport(plan).join("\n"), buildOutputBytes: plan.skippedBytes };
  }

  private requireNotConverting(box: Box): void {
    this.requireStopped(box, "convert it");
    if (this.converting.has(box.id))
      throw new ApiError("conflict", `${box.id} is already being converted.`);
  }

  private async migrationPlan(box: Box, includeBuildOutput: boolean): Promise<MigrationPlan> {
    const plan = await planMigration({
      env: this.env,
      box,
      primaryRepo: this.project(box).primaryRepo,
      includeBuildOutput,
    });
    if (!plan.ok) throw new ApiError("conflict", `Cannot convert ${box.id}: ${plan.problem}.`);
    return plan;
  }

  /**
   * `boxes.convertToWorktree`: turns a workspace clone into a worktree. `log`
   * receives the plan's report before the conversion starts.
   */
  async convertToWorktree(
    id: string,
    options: { copyBuildOutput?: boolean } = {},
    log: (text: string) => void = () => undefined,
  ): Promise<ConvertToWorktreeResult> {
    const box = this.get(id);
    const includeBuildOutput = options.copyBuildOutput ?? false;
    this.requireNotConverting(box);
    this.converting.add(id);
    try {
      const plan = await this.migrationPlan(box, includeBuildOutput);
      for (const line of planReport(plan)) log(`${line}\r\n`);
      const result = await executeMigration({
        env: this.env,
        box,
        plan,
        includeBuildOutput,
        saveBox: (b) => {
          this.repos.boxes.put(b);
        },
      });
      if (result.warning) log(`Warning: ${result.warning}\r\n`);
      log(`Converted ${id} to the worktree ${result.worktree}.\r\n`);
      this.publish(result.box, "stopped");
      return result;
    } finally {
      this.converting.delete(id);
    }
  }

  // -------------------------------------------------------------------------
  // Side sessions and messages

  /** `boxes.sideSessions.start`: another CLI in its own tmux session beside the main one. */
  async startSideSession(id: string, platform: Platform): Promise<{ session: string }> {
    const box = this.get(id);
    if (!this.isRunning(box)) throw new ApiError("conflict", `${id} is not running.`);
    if (platform === box.platform)
      throw new ApiError("conflict", `${platform} is the box's main platform.`);
    const session = sideSessionName(box, platform);
    if (liveSessions(this.env, box.container).includes(session)) {
      throw new ApiError("conflict", `${platform} already runs beside ${id}.`);
    }
    try {
      await this.startSession(
        box,
        platform,
        sideSessionArgs(box, this.project(box), platform),
        session,
      );
    } catch (err) {
      if (err instanceof ApiError && err.code === "box_running") {
        throw new ApiError("conflict", `${platform} already runs beside ${id}.`);
      }
      throw err;
    }
    this.publish(box, this.status(box));
    return { session };
  }

  async stopSideSession(id: string, platform: Platform): Promise<void> {
    const box = this.get(id);
    await this.killSession(box.container, sideSessionName(box, platform));
    this.publish(box, this.status(box));
  }

  /** `boxes.message`: types one message into the box's interactive session. */
  async sendMessage(id: string, text: string): Promise<void> {
    const box = this.get(id);
    if (!this.isRunning(box)) throw new ApiError("conflict", `${id} is not running.`);
    // `send-keys` takes a pane target, and tmux resolves `=NAME` without a
    // `:` as a pane or window, so it fails. The trailing `:` names the
    // session's current window and pane. `--` keeps a message that starts
    // with `-` from being read as flags.
    const target = `=${boxTmuxSession(box)}:`;
    for (const cmd of [
      ["tmux", "send-keys", "-t", target, "-l", "--", text],
      ["tmux", "send-keys", "-t", target, "Enter"],
    ]) {
      const r = await this.deps.docker.exec(box.container, {
        cmd,
        user: this.env.user,
        timeoutMs: 10_000,
      });
      if (r.exitCode !== 0)
        throw new ApiError(
          "conflict",
          `Could not send the message: ${(r.stderr || r.stdout).trim()}`,
        );
    }
  }

  // -------------------------------------------------------------------------
  // Catalog

  /** `conversations.list`: Claude's transcripts for a working directory. */
  async conversations(dir: string): Promise<ConversationSummary[]> {
    const tracked = new Map<string, string[]>();
    for (const b of this.repos.boxes.list()) {
      if (!b.sessionUuid) continue;
      tracked.set(b.sessionUuid, [...(tracked.get(b.sessionUuid) ?? []), b.id]);
    }
    return listConversations(this.env, path.resolve(dir), tracked);
  }

  // -------------------------------------------------------------------------
  // Bulk actions and reboot

  private async bulk(ids: string[], fn: (id: string) => Promise<unknown>): Promise<BulkResult> {
    const result: BulkResult = { done: [], failed: [] };
    for (const id of ids) {
      try {
        await fn(id);
        result.done.push(id);
      } catch (err) {
        result.failed.push({ boxId: id, error: toBulkError(err) });
      }
    }
    return result;
  }

  /** Starts stopped boxes: those with `wasRunning`, or all of them. Skips the title sync. */
  startAll(onlyWasRunning = true): Promise<BulkResult> {
    const ids = this.repos.boxes
      .list()
      .filter((b) => !this.isRunning(b) && (!onlyWasRunning || b.wasRunning))
      .map((b) => b.id);
    return this.bulk(ids, (id) => this.start(id, { syncTitle: false }));
  }

  stopAll(): Promise<BulkResult> {
    const ids = this.repos.boxes
      .list()
      .filter((b) => this.isRunning(b))
      .map((b) => b.id);
    return this.bulk(ids, (id) => this.stop(id));
  }

  /** Stops every running box, waits for each session to leave, then starts each again. */
  async restartAll(): Promise<BulkResult> {
    const running = this.repos.boxes.list().filter((b) => this.isRunning(b));
    const stopped = await this.bulk(
      running.map((b) => b.id),
      (id) => this.stop(id),
    );
    for (const b of running) await this.waitSessionGone(b);
    const started = await this.bulk(stopped.done, (id) => this.start(id, { syncTitle: false }));
    return { done: started.done, failed: [...stopped.failed, ...started.failed] };
  }

  /**
   * `projects.restartContainer`: stops the boxes running in the project
   * container, replaces the container, and starts those boxes again.
   */
  async restartProjectContainer(projectId: string): Promise<BulkResult> {
    const project = this.deps.projects.get(projectId);
    const running = this.repos.boxes.byProject(project.id).filter((b) => this.isRunning(b));
    const stopped = await this.bulk(
      running.map((b) => b.id),
      (id) => this.stop(id),
    );
    await this.deps.projects.stopContainer(project.id);
    if (stopped.done.length === 0) await this.deps.projects.ensureContainer(project.id);
    const started = await this.bulk(stopped.done, (id) => this.start(id, { syncTitle: false }));
    return { done: started.done, failed: [...stopped.failed, ...started.failed] };
  }

  /**
   * Boxes to offer for resuming after a reboot: when nothing runs, the
   * stopped boxes with `wasRunning` set. Empty otherwise.
   */
  resumeCandidates(): string[] {
    const boxes = this.repos.boxes.list();
    if (boxes.some((b) => this.isRunning(b))) return [];
    return boxes.filter((b) => b.wasRunning).map((b) => b.id);
  }
}
