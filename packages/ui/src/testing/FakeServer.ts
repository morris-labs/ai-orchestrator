// An in-memory stand-in for aio-server, built from the contracts route
// table. It matches each request to its route, parses the query and body
// with the route's schemas (answering 400 `validation` on a bad request),
// runs a handler, and checks the answer against the route's response schema.
// A response that breaks the contract is recorded in `contractViolations`,
// so a test fails when the fake and the contracts drift apart.
import {
  DEFAULT_PROMPT_TEMPLATES,
  serverRoutes,
  type AccountView,
  type AioEvent,
  type ApiErrorCode,
  type BoxView,
  type BuildSummary,
  type BuildTaskStatus,
  type BuildTaskView,
  type BuildUsage,
  type ConversationSummary,
  type GlobalSettings,
  type Job,
  type Message,
  type Mount,
  type Notification,
  type OwnerPost,
  type Project,
  type PromptTemplates,
  type SecretCandidate,
  type ServerRouteKey,
  type SetupCheck,
  type ImageStatus,
  type Updates,
} from "@aio/contracts";
import type { z } from "zod";
import type { HttpRouteKey, ResponseOf, WebSocketCtor } from "../api/client";
import { FakeSocket } from "./FakeSocket";
import {
  emptyBuildUsage,
  makeBox,
  makeJob,
  makeProject,
  makeSettings,
  projectIdFor,
  T0,
} from "./fixtures";

/** A failure a handler throws to answer with an `ApiError`. */
export class FakeApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly status = 409,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface FakeRequest {
  key: HttpRouteKey;
  params: Record<string, string>;
  query: Record<string, unknown>;
  body: unknown;
}

export type FakeHandler<K extends HttpRouteKey = HttpRouteKey> = (
  req: FakeRequest,
  server: FakeServer,
) => ResponseOf<K> | Promise<ResponseOf<K>>;

export interface FakeSshRemote {
  name: string;
  host: string;
  identity?: string;
  forwards: {
    direction: "L" | "R";
    bindAddress: string;
    bindPort: number;
    destHost: string;
    destPort: number;
  }[];
}

export interface FakeState {
  projects: Project[];
  boxes: BoxView[];
  settings: GlobalSettings;
  prompts: PromptTemplates;
  globalMounts: Mount[];
  sshRemotes: FakeSshRemote[];
  accounts: AccountView[];
  jobs: Job[];
  conversations: Record<string, ConversationSummary[]>;
  models: string[];
  setupChecks: SetupCheck[];
  image: ImageStatus;
  updates: Updates;
  notifications: Notification[];
  /** The builds the server has seen, in no order; `builds.list` sorts them. */
  builds: BuildSummary[];
  /** Each build's team chat messages, oldest first, by build id. */
  buildMessages: Record<string, Message[]>;
  /** Each build's tasks, by build id. */
  buildTasks: Record<string, BuildTaskView[]>;
  /** Each build's usage, by build id; a build without an entry has none. */
  buildUsage: Record<string, BuildUsage>;
  /** Project ids whose container has stale mounts: `boxes.start` refuses without `force`. */
  staleProjects: string[];
  /** Subdirectory names by absolute path, for `fs.dirs`. */
  dirs: Record<string, string[]>;
  /** Directories that hold an executable `new-issue.sh`, for `fs.dirs`. */
  newIssueScriptDirs: string[];
  /** The 1Password fields `secrets.available` lists. */
  secretCandidates: SecretCandidate[];
  /** When set, `secrets.available` fails with this code. */
  secretsError: "secrets_locked" | "secrets_unavailable" | null;
}

export interface FakeServerOptions {
  projects?: Project[];
  boxes?: BoxView[];
  settings?: Partial<GlobalSettings>;
  conversations?: Record<string, ConversationSummary[]>;
  accounts?: AccountView[];
  builds?: BuildSummary[];
  /** False leaves jobs running until `finishJob()`. Default true: jobs finish right away. */
  autoFinishJobs?: boolean;
}

interface CompiledRoute {
  key: ServerRouteKey;
  method: string;
  regex: RegExp;
  names: string[];
  def: (typeof serverRoutes)[ServerRouteKey];
}

function compileRoutes(): CompiledRoute[] {
  return (Object.keys(serverRoutes) as ServerRouteKey[])
    .map((key) => {
      const def = serverRoutes[key];
      const names: string[] = [];
      const pattern = def.path.replace(/:([A-Za-z0-9_]+)/g, (_m, n: string) => {
        names.push(n);
        return "([^/]+)";
      });
      return { key, method: def.method, regex: new RegExp(`^${pattern}$`), names, def };
    })
    .sort((a, b) => a.names.length - b.names.length);
}

const routesCompiled = compileRoutes();

export class FakeServer {
  readonly state: FakeState;
  readonly calls: FakeRequest[] = [];
  readonly contractViolations: string[] = [];
  readonly sockets: FakeSocket[] = [];
  readonly overrides = new Map<HttpRouteKey, FakeHandler>();
  readonly streamId = "fake-stream";
  autoFinishJobs: boolean;
  private eventLog: AioEvent[] = [];
  private jobCounter = 0;

  constructor(options: FakeServerOptions = {}) {
    const boxes = options.boxes ?? [];
    const projects = options.projects ?? [];
    for (const b of boxes) {
      if (!projects.some((p) => p.id === b.box.projectId)) {
        projects.push(makeProject({ root: b.box.targetDir, id: b.box.projectId }));
      }
    }
    this.autoFinishJobs = options.autoFinishJobs ?? true;
    this.state = {
      projects,
      boxes,
      settings: makeSettings(options.settings),
      prompts: { ...DEFAULT_PROMPT_TEMPLATES },
      globalMounts: [],
      sshRemotes: [],
      accounts: options.accounts ?? [],
      jobs: [],
      conversations: options.conversations ?? {},
      models: ["claude-opus-5-5", "claude-sonnet-5", "claude-haiku-5"],
      setupChecks: [
        { id: "docker", status: "ok", message: "Docker is reachable.", fixable: false },
        { id: "image", status: "ok", message: "The aio-agent image exists.", fixable: true },
        { id: "ssh_client", status: "ok", message: "ssh is installed.", fixable: false },
        { id: "ssh_key", status: "fail", message: "No key at ~/.ssh/id_ed25519.", fixable: true },
      ],
      image: {
        name: "aio-agent",
        exists: true,
        imageId: "sha256:abc",
        createdAt: T0,
        engineVersion: "1.0.0",
        expectedEngineVersion: "1.0.0",
        engineMatches: true,
        cliVersions: { claude: "2.1.300", codex: null, copilot: null },
      },
      updates: {
        checkedAt: T0,
        app: { current: "1.0.0", latest: "1.0.0", updateAvailable: false, releaseUrl: null },
        claudeCode: { image: "2.1.300", latest: "2.1.300", stale: false },
      },
      notifications: [],
      builds: options.builds ?? [],
      buildMessages: {},
      buildTasks: {},
      buildUsage: {},
      staleProjects: [],
      dirs: {
        "/home/user": ["src", "work"],
        "/home/user/src": ["example-app"],
        "/home/user/src/example-app": [],
        "/home/user/work": [],
      },
      newIssueScriptDirs: [],
      secretCandidates: [],
      secretsError: null,
    };
  }

  /** Replaces a route's handler. */
  on<K extends HttpRouteKey>(key: K, handler: FakeHandler<K>): this {
    this.overrides.set(key, handler as FakeHandler);
    return this;
  }

  /** Requests made to one route. */
  callsTo(key: HttpRouteKey): FakeRequest[] {
    return this.calls.filter((c) => c.key === key);
  }

  box(id: string): BoxView {
    const b = this.state.boxes.find((x) => x.box.id === id);
    if (!b) throw new FakeApiError("not_found", `No box ${id}.`, 404);
    return b;
  }

  // -------------------------------------------------------------------------
  // HTTP

  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      "http://fake.local",
    );
    const method = (init.method ?? "GET").toUpperCase();
    const route = routesCompiled.find(
      (r) => r.def.kind === "http" && r.method === method && r.regex.test(url.pathname),
    );
    if (!route)
      return this.json(404, {
        error: { code: "not_found", message: `No route for ${method} ${url.pathname}.` },
      });
    const m = route.regex.exec(url.pathname) as RegExpExecArray;
    const params = Object.fromEntries(
      route.names.map((n, i) => [n, decodeURIComponent(m[i + 1] ?? "")]),
    );
    const def = route.def as {
      query?: z.ZodTypeAny;
      body?: z.ZodTypeAny;
      response: z.ZodTypeAny;
      status?: number;
    };
    let query: Record<string, unknown> = Object.fromEntries(url.searchParams);
    if (def.query) {
      const q = def.query.safeParse(query);
      if (!q.success) return this.validation(q.error);
      query = q.data as Record<string, unknown>;
    }
    let body: unknown = undefined;
    if (typeof init.body === "string" && init.body !== "") body = JSON.parse(init.body);
    if (def.body) {
      const b = def.body.safeParse(body);
      if (!b.success) return this.validation(b.error);
      body = b.data;
    }
    const req: FakeRequest = { key: route.key as HttpRouteKey, params, query, body };
    this.calls.push(req);
    try {
      const handler = this.overrides.get(req.key) ?? defaultHandlers[req.key];
      if (!handler)
        throw new FakeApiError("not_found", `The fake has no handler for ${req.key}.`, 501);
      const result = await handler(req, this);
      const check = def.response.safeParse(result);
      if (!check.success) {
        this.contractViolations.push(
          `${req.key}: ${check.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        );
      }
      return this.json(def.status ?? 200, result);
    } catch (err) {
      if (err instanceof FakeApiError) {
        return this.json(err.status, {
          error: { code: err.code, message: err.message, details: err.details },
        });
      }
      throw err;
    }
  };

  private json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  private validation(error: z.ZodError): Response {
    return this.json(400, {
      error: {
        code: "validation",
        message: error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      },
    });
  }

  // -------------------------------------------------------------------------
  // WebSockets

  /** The constructor to give `ApiClient` as `WebSocket`. */
  get WebSocket(): WebSocketCtor {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const server = this;
    return class extends FakeSocket {
      constructor(url: string, options?: { headers?: Record<string, string> }) {
        super(url);
        this.headers = { ...options?.headers };
        server.attach(this);
      }
    } as unknown as WebSocketCtor;
  }

  /** Open sockets whose path ends with `suffix`. */
  socketsFor(suffix: string): FakeSocket[] {
    return this.sockets.filter((s) => s.readyState !== 3 && s.path.endsWith(suffix));
  }

  private attach(socket: FakeSocket) {
    this.sockets.push(socket);
    if (socket.path.endsWith("/api/v1/events")) {
      socket.onClientMessage = (data) => {
        if (typeof data !== "string") return;
        const hello = JSON.parse(data) as {
          type: string;
          streamId: string | null;
          lastSeq: number | null;
        };
        if (hello.type !== "hello") return;
        const matched = hello.streamId === this.streamId;
        const lastSeq = this.eventLog.length;
        socket.serverSend({ type: "hello", streamId: this.streamId, lastSeq, replaying: matched });
        if (matched) {
          for (const e of this.eventLog.slice(hello.lastSeq ?? 0)) socket.serverSend(e);
        }
      };
    }
  }

  /** Emits an event to every events socket, numbered in this fake's stream. */
  emit(event: AioEvent): AioEvent {
    const seq = this.eventLog.length + 1;
    const numbered = { ...event, streamId: this.streamId, seq, sourceSeq: seq } as AioEvent;
    this.eventLog.push(numbered);
    for (const s of this.socketsFor("/api/v1/events")) s.serverSend(numbered);
    return numbered;
  }

  /**
   * Stores a build's state and emits its `build.changed` event, as the
   * server does when an engine reports the build.
   */
  putBuild(build: BuildSummary): AioEvent {
    this.state.builds = [...this.state.builds.filter((b) => b.id !== build.id), build];
    return this.emit({
      type: "build.changed",
      id: `build-${build.id}-${build.updatedAt}`,
      time: build.updatedAt,
      source: "server",
      streamId: this.streamId,
      seq: 0,
      sourceSeq: 0,
      build,
    });
  }

  /** Stores team chat messages and emits a `message.sent` event for each. */
  putMessages(messages: readonly Message[]): void {
    for (const message of messages) {
      const list = (this.state.buildMessages[message.buildId] ??= []);
      list.push(message);
      this.emit({
        type: "message.sent",
        id: `message-${message.buildId}-${message.id}`,
        time: message.createdAt,
        source: "server",
        streamId: this.streamId,
        seq: 0,
        sourceSeq: 0,
        message,
      });
    }
  }

  /** Stores a task's state and emits its `build.task.changed` event. */
  putTask(
    buildId: string,
    task: { taskId: string; status: BuildTaskStatus; milestone?: string | null },
    time = T0,
  ): void {
    const list = (this.state.buildTasks[buildId] ??= []);
    const current = list.find((t) => t.taskId === task.taskId);
    const next: BuildTaskView = {
      taskId: task.taskId,
      status: task.status,
      milestone: task.milestone ?? current?.milestone ?? null,
      updatedAt: time,
    };
    this.state.buildTasks[buildId] = [...list.filter((t) => t !== current), next].sort((a, b) =>
      a.taskId.localeCompare(b.taskId),
    );
    this.emit({
      type: "build.task.changed",
      id: `task-${buildId}-${task.taskId}-${time}`,
      time,
      source: "server",
      streamId: this.streamId,
      seq: 0,
      sourceSeq: 0,
      buildId,
      taskId: task.taskId,
      status: task.status,
      previousStatus: current?.status ?? null,
      ...(task.milestone !== undefined ? { milestone: task.milestone } : {}),
    });
  }

  /**
   * Replaces a build's usage and emits a `lease.settled` event for one of
   * its calls, as the server does when a build call settles.
   */
  putBuildUsage(usage: BuildUsage, seat = "developer"): void {
    this.state.buildUsage[usage.buildId] = usage;
    this.emit({
      type: "lease.settled",
      id: `settled-${usage.buildId}-${usage.total.calls}`,
      time: T0,
      source: "server",
      streamId: this.streamId,
      seq: 0,
      sourceSeq: 0,
      leaseId: `${usage.buildId}-L${usage.total.calls}`,
      runId: null,
      buildId: usage.buildId,
      seat,
      vendor: "claude",
      role: "fixer",
      tokens: { in: 0, out: 0 },
      premiumRequests: 0,
      costEstimate: 0,
    });
  }

  // -------------------------------------------------------------------------
  // Jobs

  startJob(kind: Job["kind"], command: string, boxId: string | null, finish: () => unknown): Job {
    this.jobCounter += 1;
    const job = makeJob({ id: `job-${this.jobCounter}`, kind, command, boxId });
    this.state.jobs.push(job);
    const done = () => this.finishJob(job.id, 0, finish());
    if (this.autoFinishJobs) queueMicrotask(done);
    else pendingFinishers.set(job.id, finish);
    return { ...job };
  }

  /** Finishes a running job with an exit code and a result. */
  finishJob(id: string, exitCode = 0, result?: unknown): void {
    const job = this.state.jobs.find((j) => j.id === id);
    if (!job) return;
    const pending = pendingFinishers.get(id);
    pendingFinishers.delete(id);
    const value = result === undefined && pending ? pending() : result;
    job.status = exitCode === 0 ? "finished" : "failed";
    job.exitCode = exitCode;
    job.result = (value ?? null) as Job["result"];
    job.finishedAt = T0;
    if (exitCode !== 0) job.error = { code: "conflict", message: `exit ${exitCode}` };
  }
}

const pendingFinishers = new Map<string, () => unknown>();

// ---------------------------------------------------------------------------
// Default handlers

function holdersOf(server: FakeServer, uuid: string, except?: string): BoxView[] {
  return server.state.boxes.filter((b) => b.box.sessionUuid === uuid && b.box.id !== except);
}

function checkAdoption(server: FakeServer, uuid: string, force: boolean, except?: string) {
  const holders = holdersOf(server, uuid, except);
  const running = holders.find((h) => h.status === "running");
  if (running) {
    throw new FakeApiError("adoption_refused", `${running.box.id} is running this conversation.`);
  }
  if (holders.length > 0 && !force) {
    throw new FakeApiError("session_tracked", "A stopped box tracks this conversation.", 409, {
      holders: holders.map((h) => h.box.id),
    });
  }
}

function setStatus(server: FakeServer, view: BoxView, status: BoxView["status"]) {
  view.status = status;
  if (status === "running") view.box.wasRunning = true;
  if (status === "stopped") view.box.wasRunning = false;
}

function bulk(server: FakeServer, ids: string[], status: BoxView["status"]) {
  for (const id of ids) setStatus(server, server.box(id), status);
  return { done: ids, failed: [] };
}

function summary(server: FakeServer, p: Project) {
  const boxes = server.state.boxes.filter((b) => b.box.projectId === p.id);
  return {
    project: p,
    running: boxes.filter((b) => b.status === "running").length,
    total: boxes.length,
    // A stale project's container runs with old settings, as one from a
    // server before the secrets broker does.
    container: server.state.staleProjects.includes(p.id)
      ? {
          name: `aio-agent-proj-${p.id}`,
          state: "running" as const,
          engine: null,
          stale: ["secrets environment -> broker"],
        }
      : null,
  };
}

function remoteView(server: FakeServer, r: FakeSshRemote) {
  return {
    remote: r,
    referencedBy: server.state.boxes
      .filter((b) => b.box.sshRemoteRefs.includes(r.name))
      .map((b) => b.box.id),
    tunnelUp: false,
    tunnelError: null,
  };
}

const restartKeys = [
  "model",
  "effort",
  "skipPermissions",
  "sessionUuid",
  "sshRemoteRefs",
  "accounts",
] as const;

const defaultHandlers: Partial<Record<HttpRouteKey, FakeHandler>> = {
  health: () => ({ version: "1.0.0", uptimeS: 1 }),
  "auth.session": () => ({ ok: true }),
  "projects.list": (_r, s) => ({ projects: s.state.projects.map((p) => summary(s, p)) }),
  "projects.get": (r, s) => {
    const p = s.state.projects.find((x) => x.id === r.params.projectId);
    if (!p) throw new FakeApiError("not_found", "No such project.", 404);
    return summary(s, p);
  },
  "projects.create": (r, s) => {
    const body = r.body as { root: string; name?: string };
    const p = makeProject({ root: body.root, ...(body.name ? { name: body.name } : {}) });
    s.state.projects.push(p);
    return p;
  },
  "projects.update": (r, s) => {
    const p = s.state.projects.find((x) => x.id === r.params.projectId);
    if (!p) throw new FakeApiError("not_found", "No such project.", 404);
    const body = r.body as Partial<Project> & {
      name?: string;
      primaryRepo?: string | null;
      ceilingsOverride?: unknown;
    };
    if (body.name !== undefined)
      p.name = body.name === "" ? (p.root.split("/").pop() ?? p.root) : body.name;
    if (body.mounts) p.mounts = body.mounts;
    if (body.tcpMaps) p.tcpMaps = body.tcpMaps;
    if (body.secretRefs) p.secretRefs = body.secretRefs;
    // Secret names are not stale: the broker reads them on every request.
    const stale = body.mounts || body.tcpMaps;
    return {
      project: p,
      staleBoxes: stale
        ? s.state.boxes
            .filter((b) => b.box.projectId === p.id && b.status === "running")
            .map((b) => b.box.id)
        : [],
    };
  },
  "projects.remove": (r, s) => {
    const id = r.params.projectId as string;
    const boxes = s.state.boxes.filter((b) => b.box.projectId === id);
    if (boxes.length > 0 && !r.query.force) {
      throw new FakeApiError("conflict", `The project ${id} has boxes.`);
    }
    if (boxes.some((b) => b.status === "running")) {
      throw new FakeApiError("box_running", "Stop the boxes first.");
    }
    s.state.boxes = s.state.boxes.filter((b) => b.box.projectId !== id);
    s.state.projects = s.state.projects.filter((p) => p.id !== id);
    return { removed: true, boxes: boxes.map((b) => b.box.id) };
  },
  "projects.restartContainer": (r, s) =>
    bulk(
      s,
      s.state.boxes
        .filter((b) => b.box.projectId === r.params.projectId && b.status === "running")
        .map((b) => b.box.id),
      "running",
    ),
  "boxes.list": (r, s) => ({
    boxes: s.state.boxes.filter((b) => !r.query.projectId || b.box.projectId === r.query.projectId),
  }),
  "boxes.get": (r, s) => s.box(r.params.boxId as string),
  "boxes.create": (r, s) => {
    const body = r.body as {
      targetDir: string;
      conversationName: string;
      conversation: { mode: string; sessionUuid?: string; fromBoxId?: string };
      force: boolean;
      platform: BoxView["box"]["platform"];
      model?: string;
      effort?: BoxView["box"]["effort"];
      skipPermissions: boolean;
      accounts?: BoxView["box"]["accounts"];
      sshRemoteRefs: string[];
      start: boolean;
    };
    if (body.conversation.mode === "adopt" && body.conversation.sessionUuid) {
      checkAdoption(s, body.conversation.sessionUuid, body.force);
    }
    const slug = (body.conversationName || body.targetDir.split("/").pop() || "box")
      .replace(/[^A-Za-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");
    let id = `aio-agent-${slug.toLowerCase().replace(/[^a-z0-9_.-]/g, "-")}`;
    for (let n = 2; s.state.boxes.some((b) => b.box.id === id); n += 1)
      id = `${id.replace(/-\d+$/, "")}-${n}`;
    return s.startJob("box_create", `create ${id}`, id, () => {
      const projectId =
        s.state.projects.find((p) => p.root === body.targetDir)?.id ?? projectIdFor(body.targetDir);
      if (!s.state.projects.some((p) => p.id === projectId)) {
        s.state.projects.push(makeProject({ root: body.targetDir, id: projectId }));
      }
      const box = makeBox({
        id,
        targetDir: body.targetDir,
        projectId,
        conversationName: slug,
        platform: body.platform,
        skipPermissions: body.skipPermissions,
        ...(body.accounts ? { accounts: body.accounts } : {}),
        sshRemoteRefs: body.sshRemoteRefs,
        sessionUuid: body.conversation.sessionUuid ?? "00000000-0000-4000-8000-000000000001",
        ...(body.model ? { model: body.model } : {}),
        ...(body.effort ? { effort: body.effort } : {}),
      });
      s.state.boxes.push({
        box,
        status: body.start ? "running" : "stopped",
        container: box.container,
        tmuxSession: box.session,
        reviewState: { state: "idle" },
        stats: null,
        listeners: [],
        proxyUrls: [],
        sideSessions: [],
        targetDirExists: true,
      });
      return { box };
    });
  },
  "boxes.update": (r, s) => {
    const view = s.box(r.params.boxId as string);
    const body = r.body as Record<string, unknown> & { force?: boolean };
    if (typeof body.sessionUuid === "string" && body.sessionUuid !== view.box.sessionUuid) {
      checkAdoption(s, body.sessionUuid, body.force ?? false, view.box.id);
    }
    let changed = false;
    const rec = view.box as unknown as Record<string, unknown>;
    if (body.accounts && typeof body.accounts === "object") {
      // A patch: `null` clears a vendor, as the server does.
      const merged: Record<string, unknown> = { ...(rec.accounts as object | undefined) };
      for (const [vendor, id] of Object.entries(body.accounts)) {
        if (id === null) delete merged[vendor];
        else merged[vendor] = id;
      }
      body.accounts = Object.keys(merged).length > 0 ? merged : null;
    }
    for (const [k, v] of Object.entries(body)) {
      if (k === "force" || v === undefined) continue;
      if (
        (restartKeys as readonly string[]).includes(k) &&
        JSON.stringify(rec[k] ?? null) !== JSON.stringify(v)
      ) {
        changed = true;
      }
      if (v === null) delete rec[k];
      else rec[k] = v;
    }
    if (body.sessionUuid === null) view.box.sessionUuid = null;
    return { box: view, restartRequired: changed && view.status === "running" };
  },
  "boxes.start": (r, s) => {
    const view = s.box(r.params.boxId as string);
    if (view.status === "running") throw new FakeApiError("box_running", "The box is running.");
    const force = (r.body as { force?: boolean } | undefined)?.force ?? false;
    if (!force && s.state.staleProjects.includes(view.box.projectId)) {
      throw new FakeApiError("stale_mounts", "The project container's mounts changed.");
    }
    setStatus(s, view, "running");
    return view;
  },
  "boxes.stop": (r, s) => {
    const view = s.box(r.params.boxId as string);
    setStatus(s, view, "stopped");
    return view;
  },
  "boxes.restart": (r, s) => {
    const view = s.box(r.params.boxId as string);
    setStatus(s, view, "running");
    return view;
  },
  "boxes.remove": (r, s) => {
    const view = s.box(r.params.boxId as string);
    if (view.status === "running") throw new FakeApiError("box_running", "Stop the box first.");
    s.state.boxes = s.state.boxes.filter((b) => b !== view);
    const worktree = view.box.worktree ? (r.query.removeWorktree ? "removed" : "kept") : "none";
    return { removed: true, worktree, reason: null };
  },
  "boxes.purge": (r, s) => {
    const view = s.box(r.params.boxId as string);
    const dir = view.box.targetDir;
    const running = s.state.boxes.find((b) => b.box.targetDir === dir && b.status === "running");
    if (running)
      throw new FakeApiError("box_running", `${running.box.id} is running against this directory.`);
    const removed = s.state.boxes.filter((b) => b.box.targetDir === dir).map((b) => b.box.id);
    const dryRun = (r.body as { dryRun?: boolean } | undefined)?.dryRun ?? false;
    if (!dryRun) s.state.boxes = s.state.boxes.filter((b) => b.box.targetDir !== dir);
    return {
      dryRun,
      removedRecords: removed,
      removedTranscriptDirs: [`/home/user/.claude/projects/${dir.replace(/[^A-Za-z0-9]/g, "-")}`],
    };
  },
  "boxes.move": (r, s) => {
    const view = s.box(r.params.boxId as string);
    const old = view.box.targetDir;
    const newDir = (r.body as { newDir: string }).newDir;
    const moved = s.state.boxes.filter((b) => b.box.targetDir === old);
    for (const b of moved) b.box.targetDir = newDir;
    return { movedBoxes: moved.map((b) => b.box.id) };
  },
  "boxes.relink": (r, s) => {
    const view = s.box(r.params.boxId as string);
    if (view.status === "running") throw new FakeApiError("box_running", "Stop the box first.");
    view.box.targetDir = (r.body as { targetDir: string }).targetDir;
    return view;
  },
  "boxes.convertToWorktree": (r, s) => {
    const view = s.box(r.params.boxId as string);
    return s.startJob("convert_to_worktree", `convert ${view.box.id}`, view.box.id, () => {
      const slug = view.box.workspace?.split("/").pop() ?? "work";
      view.box.worktree = `${view.box.targetDir}/.worktrees/${slug}`;
      view.box.branch = `claude/${slug}`;
      return {
        box: view.box,
        worktree: view.box.worktree,
        branch: view.box.branch,
        oldFolder: `${view.box.workspace ?? slug}.pre-worktree`,
        recordBackup: `/home/user/.ai-orchestrator/backup/${view.box.id}.20261028`,
        keptRefs: [],
        notCarried: [],
      };
    });
  },
  "boxes.convertToWorktree.plan": (r, s) => {
    const view = s.box(r.params.boxId as string);
    const slug = view.box.workspace?.split("/").pop() ?? "work";
    return {
      report: `${view.box.workspace ?? slug} becomes ${view.box.targetDir}/.worktrees/${slug} on branch claude/${slug}.`,
      buildOutputBytes: 0,
    };
  },
  "boxes.attachCommand": (r, s) => {
    const view = s.box(r.params.boxId as string);
    const q = r.query as { kind: string; platform?: string };
    if (q.kind === "shell") return { argv: ["docker", "exec", "-it", view.container, "bash"] };
    const session = q.kind === "side" ? `${view.tmuxSession}-${q.platform}` : view.tmuxSession;
    return {
      argv: ["docker", "exec", "-it", view.container, "tmux", "attach", "-t", `=${session}`],
    };
  },
  "boxes.sideSessions.start": (r, s) => {
    const view = s.box(r.params.boxId as string);
    const p = (r.body as { platform: BoxView["box"]["platform"] }).platform;
    if (view.sideSessions.includes(p)) throw new FakeApiError("conflict", "Already running.");
    view.sideSessions.push(p);
    return { session: `${view.tmuxSession}-${p}` };
  },
  "boxes.sideSessions.stop": (r, s) => {
    const view = s.box(r.params.boxId as string);
    view.sideSessions = view.sideSessions.filter((p) => p !== r.params.platform);
    return { ok: true };
  },
  "boxes.platform": (r, s) => {
    const view = s.box(r.params.boxId as string);
    view.box.platform = (r.body as { platform: BoxView["box"]["platform"] }).platform;
    return view;
  },
  "boxes.message": () => ({ ok: true }),
  "boxes.startAll": (r, s) =>
    bulk(
      s,
      s.state.boxes
        .filter(
          (b) =>
            b.status === "stopped" &&
            (!(r.body as { onlyWasRunning: boolean }).onlyWasRunning || b.box.wasRunning),
        )
        .map((b) => b.box.id),
      "running",
    ),
  "boxes.stopAll": (_r, s) =>
    bulk(
      s,
      s.state.boxes.filter((b) => b.status === "running").map((b) => b.box.id),
      "stopped",
    ),
  "boxes.restartAll": (_r, s) =>
    bulk(
      s,
      s.state.boxes.filter((b) => b.status === "running").map((b) => b.box.id),
      "running",
    ),
  "stats.refresh": () => ({ ok: true }),
  "jobs.get": (r, s) => {
    const job = s.state.jobs.find((j) => j.id === r.params.jobId);
    if (!job) throw new FakeApiError("not_found", "No such job.", 404);
    return { ...job };
  },
  "conversations.list": (r, s) => ({
    dir: r.query.dir as string,
    conversations: s.state.conversations[r.query.dir as string] ?? [],
  }),
  "models.list": (r, s) =>
    r.query.vendor && r.query.vendor !== "claude"
      ? {
          models: r.query.vendor === "codex" ? ["gpt-6.1-sol"] : ["auto"],
          efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
          defaults: {
            model: r.query.vendor === "codex" ? "gpt-6.1-sol" : "auto",
            effort: "medium",
          },
          source: "baseline",
        }
      : {
          models: s.state.models,
          efforts: ["low", "medium", "high", "xhigh", "max"],
          defaults: { model: "claude-opus-5-5", effort: "high" },
          source: "cache",
        },
  "models.rescan": (_r, s) => ({
    models: s.state.models,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaults: { model: "claude-opus-5-5", effort: "high" },
    source: "scan",
  }),
  "image.status": (_r, s) => s.state.image,
  "image.build": (r, s) => {
    const kind = (r.body as { kind: string }).kind;
    return s.startJob("image_build", `docker build -t aio-agent (${kind})`, null, () => null);
  },
  "updates.check": (_r, s) => s.state.updates,
  "setup.get": (_r, s) => ({
    completed: s.state.settings.setupCompleted,
    defaultTargetDir: s.state.settings.defaultTargetDir ?? null,
    checks: s.state.setupChecks,
  }),
  "setup.fix": (r, s) => s.startJob("setup_fix", `fix ${r.params.checkId}`, null, () => null),
  "setup.complete": (r, s) => {
    s.state.settings.setupCompleted = true;
    const dir = (r.body as { defaultTargetDir?: string }).defaultTargetDir;
    if (dir) s.state.settings.defaultTargetDir = dir;
    return { ok: true };
  },
  "secrets.available": (_r, s) => {
    if (s.state.secretsError) {
      throw new FakeApiError(s.state.secretsError, "1Password is not available.", 503);
    }
    return {
      vaults: ["Aio"],
      candidates: s.state.secretCandidates,
      vaultErrors: [],
      fetchedAt: T0,
    };
  },
  "settings.get": (_r, s) => s.state.settings,
  "settings.patch": (r, s) => {
    mergePatch(s.state.settings as unknown as Record<string, unknown>, r.body);
    return s.state.settings;
  },
  "fs.dirs": (r, s) => {
    const path = ((r.query.path as string | undefined) ?? "/home/user").replace(/(.)\/+$/, "$1");
    const names = s.state.dirs[path];
    if (!names) throw new FakeApiError("not_found", `No directory ${path}.`, 404);
    const parent = path === "/" ? null : path.replace(/\/[^/]+$/, "") || "/";
    return {
      path,
      parent,
      entries: [...names]
        .sort()
        .map((name) => ({ name, path: `${path === "/" ? "" : path}/${name}` })),
      newIssueScript: s.state.newIssueScriptDirs.includes(path),
    };
  },
  "projects.repos.list": (r, s) => {
    const p = s.state.projects.find((x) => x.id === r.params.projectId);
    if (!p) throw new FakeApiError("not_found", "No such project.", 404);
    const path = p.primaryRepo ?? p.root;
    return {
      repos: [
        {
          path,
          name: path.split("/").filter(Boolean).pop() ?? path,
          currentBranch: "main",
          headSha: "4e1c2a9b7d3f00000000000000000000000000aa",
          dirty: false,
        },
      ],
    };
  },
  "projects.repos.refs": () => ({
    localBranches: ["main"],
    remoteBranches: ["origin/main"],
    tags: [],
    recentCommits: [],
    pullRequests: [],
  }),
  "runs.list": () => ({ runs: [] }),
  "usage.samples": () => ({ samples: [] }),
  "prompts.get": (_r, s) => ({
    templates: s.state.prompts,
    defaults: { ...DEFAULT_PROMPT_TEMPLATES },
  }),
  "prompts.put": (r, s) => {
    s.state.prompts = r.body as PromptTemplates;
    return { templates: s.state.prompts, defaults: { ...DEFAULT_PROMPT_TEMPLATES } };
  },
  "accounts.list": (_r, s) => ({ accounts: s.state.accounts }),
  "sshRemotes.list": (_r, s) => ({ remotes: s.state.sshRemotes.map((x) => remoteView(s, x)) }),
  "sshRemotes.put": (r, s) => {
    const body = r.body as FakeSshRemote;
    const old = r.params.name as string;
    if (body.name !== old && s.state.sshRemotes.some((x) => x.name === body.name)) {
      throw new FakeApiError("conflict", `A remote named ${body.name} exists.`);
    }
    s.state.sshRemotes = s.state.sshRemotes.filter((x) => x.name !== old);
    s.state.sshRemotes.push(body);
    for (const b of s.state.boxes)
      b.box.sshRemoteRefs = b.box.sshRemoteRefs.map((n) => (n === old ? body.name : n));
    return remoteView(s, body);
  },
  "sshRemotes.delete": (r, s) => {
    const name = r.params.name as string;
    s.state.sshRemotes = s.state.sshRemotes.filter((x) => x.name !== name);
    const unlinked = s.state.boxes.filter((b) => b.box.sshRemoteRefs.includes(name));
    for (const b of unlinked) b.box.sshRemoteRefs = b.box.sshRemoteRefs.filter((n) => n !== name);
    return { unlinkedBoxes: unlinked.map((b) => b.box.id) };
  },
  "sshRemotes.test": () => ({ ok: true, authFailed: false, output: "ok" }),
  "sshRemotes.testSaved": (r, s) => {
    if (r.body === undefined && !s.state.sshRemotes.some((x) => x.name === r.params.name)) {
      throw new FakeApiError("not_found", "No such remote.", 404);
    }
    return { ok: true, authFailed: false, output: "ok" };
  },
  "sshRemotes.reconnect": (r, s) => {
    const remote = s.state.sshRemotes.find((x) => x.name === r.params.name);
    if (!remote) throw new FakeApiError("not_found", "No such remote.", 404);
    return remoteView(s, remote);
  },
  "sshRemotes.copyId": (r, s) =>
    s.startJob("ssh_copy_id", `ssh-copy-id ${r.params.name}`, null, () => null),
  "globalMounts.get": (_r, s) => ({ mounts: s.state.globalMounts }),
  "globalMounts.put": (r, s) => {
    s.state.globalMounts = (r.body as { mounts: Mount[] }).mounts;
    return { mounts: s.state.globalMounts, staleContainers: [] };
  },
  "usage.get": () => ({ vendors: [] }),
  "builds.list": (r, s) => ({
    builds: s.state.builds
      .filter((b) => !r.query.projectId || b.projectId === r.query.projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)),
  }),
  "builds.get": (r, s) => {
    const build = s.state.builds.find((b) => b.id === r.params.buildId);
    if (!build) throw new FakeApiError("not_found", `No build ${r.params.buildId as string}.`, 404);
    return build;
  },
  "builds.usage": (r, s) => {
    const buildId = r.params.buildId as string;
    return s.state.buildUsage[buildId] ?? emptyBuildUsage(buildId);
  },
  "builds.messages": (r, s) => {
    const buildId = r.params.buildId as string;
    if (!s.state.builds.some((b) => b.id === buildId)) {
      throw new FakeApiError("not_found", `No build ${buildId}.`, 404);
    }
    return { messages: s.state.buildMessages[buildId] ?? [] };
  },
  "builds.post": (r, s) => {
    // Like the engine: the post is a message from the owner to one agent,
    // recorded as a decision on the addressee's task.
    const buildId = r.params.buildId as string;
    if (!s.state.builds.some((b) => b.id === buildId)) {
      throw new FakeApiError("not_found", `No build ${buildId}.`, 404);
    }
    const post = r.body as OwnerPost;
    const taskId = post.taskId ?? post.toTask ?? null;
    const milestone = post.milestone ?? null;
    if (taskId === null && milestone === null) {
      throw new FakeApiError("validation", "The post needs a task or a milestone.", 400);
    }
    const earlier = s.state.buildMessages[buildId] ?? [];
    const message: Message = {
      version: 1,
      id: `M${earlier.length + 1}`,
      buildId,
      from: { kind: "owner" },
      to: { kind: "seat", seat: post.to, taskId: post.toTask ?? null },
      routing: "addressed",
      type: post.type ?? "note",
      taskId,
      milestone,
      paths: [],
      body: post.body,
      createdAt: new Date().toISOString(),
    };
    s.putMessages([message]);
    const decisions = earlier.filter((m) => m.from.kind === "owner").length;
    return {
      route: "agent" as const,
      message,
      decision: {
        version: 1 as const,
        id: `D${decisions + 1}`,
        buildId,
        messageId: message.id,
        to: message.to,
        taskId,
        milestone,
        body: message.body,
        createdAt: message.createdAt,
        planChange: null,
      },
    };
  },
  "builds.tasks": (r, s) => {
    const buildId = r.params.buildId as string;
    if (!s.state.builds.some((b) => b.id === buildId)) {
      throw new FakeApiError("not_found", `No build ${buildId}.`, 404);
    }
    return { tasks: s.state.buildTasks[buildId] ?? [] };
  },
  "notifications.list": (_r, s) => ({ notifications: s.state.notifications }),
  "notifications.read": () => ({ ok: true }),
};

/** Applies a settings patch: nested objects merge, `null` deletes a key, other values replace. */
function mergePatch(target: Record<string, unknown>, patch: unknown): void {
  if (patch === null || typeof patch !== "object") return;
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === undefined) continue;
    if (v === null) {
      delete target[k];
    } else if (
      typeof v === "object" &&
      !Array.isArray(v) &&
      typeof target[k] === "object" &&
      target[k] !== null
    ) {
      mergePatch(target[k] as Record<string, unknown>, v);
    } else {
      target[k] = v;
    }
  }
}
