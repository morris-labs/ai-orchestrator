// Builds an API server over the fake core and fake services.
import { openDatabase } from "../../src/db/index.js";
import fs from "node:fs";
import { PassThrough, Duplex } from "node:stream";
import type { BuildState, BuildSummary, EngineRouteKey, Job, RunState } from "@aio/contracts";
import type { ApiDeps, ApiEngine, ApiEngines } from "../../src/api/deps.js";
import { ApiError } from "../../src/api/errors.js";
import { createApiServer, type ApiServer } from "../../src/api/server.js";
import type { EngineCallInput } from "../../src/events/engine-client.js";
import { EventHub } from "../../src/events/hub.js";
import { RunMirror } from "../../src/events/run-mirror.js";
import { JobManager } from "../../src/jobs/jobs.js";
import type { ExecBackend, ExecRequest, ExecSession } from "../../src/terminals/exec.js";
import type { DevServerProxy } from "../../src/proxy/proxy.js";
import { createFakeCore, type FakeCore } from "./fake-core.js";
import { CONTAINER, PROJECT_ID, T1, runState } from "./fixtures.js";
import { tempDir } from "../tmp.js";

export const TOKEN = "t".repeat(64);
export const AUTH = { authorization: `Bearer ${TOKEN}` };

/** An engine whose routes answer from a handler map. */
export class FakeEngine implements ApiEngine {
  readonly calls: { key: EngineRouteKey; input: EngineCallInput }[] = [];
  mismatch = false;
  /** True when the health check that `confirmVersion` runs finds another version. */
  pendingMismatch = false;
  constructor(
    readonly endpoint: { container: string; projectId: string },
    readonly handlers: Partial<Record<EngineRouteKey, (input: EngineCallInput) => unknown>>,
  ) {}
  assertVersion(): void {
    if (this.mismatch) throw new ApiError("engine_mismatch", "Rebuild the image.");
  }
  async confirmVersion(): Promise<void> {
    if (this.pendingMismatch) this.mismatch = true;
    this.assertVersion();
  }
  async call(key: EngineRouteKey, input: EngineCallInput = {}): Promise<unknown> {
    this.calls.push({ key, input });
    const handler = this.handlers[key];
    if (!handler) throw new ApiError("conflict", `No fake for ${key}.`);
    return handler(input);
  }
}

export class FakeEngines implements ApiEngines {
  constructor(public engines: FakeEngine[]) {}
  get(container: string) {
    return this.engines.find((e) => e.endpoint.container === container);
  }
  all() {
    return this.engines;
  }
  forProject(projectId: string) {
    return this.engines.find((e) => e.endpoint.projectId === projectId);
  }
  requireProject(projectId: string) {
    const e = this.forProject(projectId);
    if (!e) throw new ApiError("conflict", "Not running.");
    e.assertVersion();
    return e;
  }
}

/** The engine state of the harness's build `add-export`, with `status`. */
export function harnessBuildState(status: BuildState["status"]): BuildState {
  return {
    version: 1,
    id: "01JB8Z5K3W6Q2V9X4T7R0M1N2Q",
    slug: "add-export",
    projectId: PROJECT_ID,
    boxId: null,
    container: CONTAINER,
    title: "Add an export",
    repoPath: "/work/example-app",
    base: "0123456789abcdef0123456789abcdef01234567",
    branch: "build/add-export",
    worktree: "/work/example-app/.worktrees/build-add-export",
    status,
    step: "tasks",
    tasks: [],
    escalations: [],
    placements: { singleVendor: null, plan: {}, live: [] },
    createdAt: T1,
    updatedAt: T1,
  };
}

/** Engine build requests for the build `add-export`. */
function buildHandlers(): Partial<Record<EngineRouteKey, (input: EngineCallInput) => unknown>> {
  const known = (input: EngineCallInput) => {
    if (input.params?.slug !== "add-export") throw new ApiError("not_found", "No such build.");
  };
  return {
    "engine.builds.pause": (i) => (known(i), harnessBuildState("paused")),
    "engine.builds.resume": (i) => (known(i), harnessBuildState("running")),
    "engine.builds.cancel": (i) => (known(i), harnessBuildState("cancelled")),
    "engine.builds.delete": (i) => (known(i), harnessBuildState("cancelled")),
    "engine.builds.inbox": (i) => (
      known(i),
      {
        buildId: "01JB8Z5K3W6Q2V9X4T7R0M1N2Q",
        slug: "add-export",
        boxId: null,
        items: [],
      }
    ),
  };
}

/** The default engine: knows one run and echoes the rest. */
export function defaultEngine(): FakeEngine {
  const runFor = (input: EngineCallInput): RunState => {
    const id = input.params?.runId;
    if (id !== undefined && id !== runState.id) throw new ApiError("run_not_found", "No such run.");
    return runState;
  };
  const finding = {
    id: "F-0001",
    fingerprint: "3f786850e387550fdab836ed7e6dc881de23001b",
    severity: "P1",
    title: "Retry loop never gives up",
    file: "src/mailer.ts",
    lines: [120, 134],
    failureCase: "A closed socket retries forever.",
    category: "correctness",
    introduced: true,
    reportedBy: "codex-gpt-5",
    alsoReportedBy: [],
    verdict: "waived",
    verification: "script",
    evidence: "repro.sh",
    runId: runState.id,
    round: 1,
    groupId: "G-01",
    hunkIds: [],
    origin: "reviewer",
    history: [],
  };
  return new FakeEngine(
    { container: CONTAINER, projectId: PROJECT_ID },
    {
      "engine.runs.list": () => ({ runs: [runState] }),
      "engine.builds.post": (input) => {
        const post = input.body as { to: string; toTask?: string; type: string; body: string };
        const message = {
          version: 1,
          id: "M1",
          buildId: "01JB8Z5K3W6Q2V9X4T7R0M1N2Q",
          from: { kind: "owner" },
          to: { kind: "seat", seat: post.to, taskId: post.toTask ?? null },
          routing: "addressed",
          type: post.type,
          taskId: post.toTask ?? null,
          milestone: null,
          paths: [],
          body: post.body,
          createdAt: "2026-10-28T09:05:00.000Z",
        };
        const { buildId, to, taskId, milestone, body, createdAt } = message;
        return {
          route: "agent",
          message,
          decision: {
            version: 1,
            id: "D1",
            buildId,
            messageId: "M1",
            to,
            taskId,
            milestone,
            body,
            createdAt,
            planChange: null,
          },
        };
      },
      "engine.repos.list": () => ({
        repos: [
          {
            path: "/work/example-app",
            name: "example-app",
            currentBranch: "main",
            headSha: "0123456789abcdef0123456789abcdef01234567",
            dirty: false,
          },
        ],
      }),
      "engine.repos.refs": (input) => ({
        localBranches: [String((input.query as { repo: string }).repo)],
        remoteBranches: [],
        tags: [],
        recentCommits: [],
        pullRequests: [],
      }),
      "engine.runs.preview": () => ({
        baseSha: "0123456789abcdef",
        tipSha: "89abcdef",
        diffBaseSha: "0123456789abcdef",
        groups: [],
        changedLines: 0,
        dirty: false,
      }),
      "engine.runs.create": (input) => ({
        ...runState,
        id: (input.body as { runId: string }).runId,
        status: "pending",
      }),
      "engine.runs.get": runFor,
      ...buildHandlers(),
      "engine.runs.pause": (i) => ({
        ...runFor(i),
        status: "paused",
        updatedAt: "2026-10-28T09:06:00.000Z",
      }),
      "engine.runs.resume": runFor,
      "engine.runs.cancel": runFor,
      "engine.runs.profile": runFor,
      "engine.runs.assign": runFor,
      "engine.runs.rebaseBase": runFor,
      "engine.runs.retry": runFor,
      "engine.runs.decide": runFor,
      "engine.runs.push": runFor,
      "engine.runs.groups": (i) => (runFor(i), { groups: [] }),
      "engine.runs.rounds": (i) => (runFor(i), { rounds: [] }),
      "engine.findings.list": (i) => (runFor(i), { findings: [finding] }),
      "engine.findings.get": (i) => (runFor(i), { finding, diff: null, fixDiff: null }),
      "engine.findings.waive": (i) => (runFor(i), finding),
    },
  );
}

/** A fake exec: the test drives the container side of the stream. */
export class FakeExec implements ExecBackend {
  readonly requests: ExecRequest[] = [];
  readonly sizes: [number, number][] = [];
  sessions: { container: Duplex; closed: boolean; exitCode: number | null }[] = [];
  fail: Error | null = null;

  async start(request: ExecRequest): Promise<ExecSession> {
    if (this.fail) throw this.fail;
    this.requests.push(request);
    const toClient = new PassThrough();
    const fromClient = new PassThrough();
    const stream = Duplex.from({ readable: toClient, writable: fromClient });
    const container = Duplex.from({ readable: fromClient, writable: toClient });
    container.on("error", () => undefined);
    const entry = { container, closed: false, exitCode: 0 as number | null };
    this.sessions.push(entry);
    return {
      stream,
      resize: async (cols, rows) => void this.sizes.push([cols, rows]),
      exitCode: async () => entry.exitCode,
      close: () => {
        entry.closed = true;
        stream.destroy();
      },
    };
  }
}

const NODE_STATUS = {
  role: "both" as const,
  name: "desk",
  machineId: null,
  hubUrl: null,
  link: "none" as const,
  error: null,
  linkPort: null,
};

export interface Harness {
  core: FakeCore;
  deps: ApiDeps;
  server: ApiServer;
  hub: EventHub;
  jobs: JobManager;
  engine: FakeEngine;
  exec: FakeExec;
  runs: RunMirror;
}

export async function createHarness(
  overrides: Partial<Pick<ApiDeps, "links" | "machines" | "token">> & {
    proxy?: DevServerProxy;
  } = {},
): Promise<Harness> {
  const core = createFakeCore();
  const db = openDatabase(":memory:");
  const hub = new EventHub({ db });
  const jobs = new JobManager();
  const engine = defaultEngine();
  const exec = new FakeExec();
  const runs = new RunMirror(db);
  const builds: BuildSummary[] = [
    {
      id: "01JB8Z5K3W6Q2V9X4T7R0M1N2Q",
      slug: "add-export",
      projectId: PROJECT_ID,
      container: CONTAINER,
      status: "running",
      step: "tasks",
      boxId: null,
      createdAt: T1,
      updatedAt: T1,
    },
  ];
  const notifications = [
    {
      notificationId: "n1",
      kind: "run_finished" as const,
      title: "Run finished",
      body: "",
      runId: null,
      boxId: null,
      severity: "info" as const,
      read: false,
    },
  ];
  const job = (kind: Job["kind"]): Job =>
    jobs.start({ kind, command: kind }, async (io) => {
      io.write("done\r\n");
      return { exitCode: 0 };
    });
  const deps: ApiDeps = {
    core,
    home: fs.realpathSync(tempDir("api-home-")),
    token: overrides.token ?? TOKEN,
    version: "1.0.0-dev",
    startedAt: new Date(),
    hub,
    jobs,
    runs,
    engines: new FakeEngines([engine]),
    usage: {
      clear: async () => 0,
      vendors: () => [
        {
          vendor: "claude",
          account: "user@example.com",
          ceiling: { kind: "utilization", window: "5h", max: 0.6 },
          latest: [],
          overCeiling: false,
          forecastAt: null,
          resetAt: null,
          window: "5h",
        },
      ],
      samples: () => [
        {
          vendor: "claude",
          account: "user@example.com",
          window: "5h",
          utilization: 0.2,
          spendUsd: null,
          ceiling: { kind: "utilization", window: "5h", max: 0.6 },
          resetAt: null,
          sampleSource: "rate_limit_event",
          time: T1,
        },
      ],
    },
    builds: {
      list: (projectId) => builds.filter((b) => !projectId || b.projectId === projectId),
      get: (buildId) => builds.find((b) => b.id === buildId),
      usage: (buildId) =>
        buildId === "01JB8Z5K3W6Q2V9X4T7R0M1N2Q"
          ? {
              buildId,
              total: { calls: 0, tokensIn: 0, tokensOut: 0, premiumRequests: 0, costEstimate: 0 },
              bySeat: [],
              byStep: [],
              bySpecialty: [],
            }
          : undefined,
      messages: (buildId) => (builds.some((b) => b.id === buildId) ? [] : undefined),
      tasks: (buildId) => (builds.some((b) => b.id === buildId) ? [] : undefined),
    },
    notifications: {
      list: (q) => notifications.filter((n) => !q.unread || !n.read),
      markRead: (id) => {
        const n = notifications.find((x) => x.notificationId === id);
        if (n) n.read = true;
        return n !== undefined;
      },
    },
    secrets: {
      view: async () => ({
        global: [],
        projects: [],
        op: { installed: false, version: null, signedIn: false, mode: "none" },
      }),
      available: async () => ({
        vaults: ["Aio"],
        candidates: [],
        vaultErrors: [],
        fetchedAt: "2026-10-28T09:00:00Z",
      }),
      check: async () => ({
        op: { installed: true, version: "2.30.0", signedIn: true, mode: "desktop" },
        results: [],
      }),
    },
    setup: {
      status: async () => ({ completed: false, defaultTargetDir: null, checks: [] }),
      fix: (id) => {
        if (id !== "ssh_key") throw new ApiError("not_found", "No such check.");
        return job("setup_fix");
      },
      buildImage: () => job("image_build"),
    },
    updates: {
      check: async () => ({
        checkedAt: T1,
        app: { current: "1.0.0-dev", latest: null, updateAvailable: false, releaseUrl: null },
        claudeCode: { image: "2.1.300", latest: null, stale: false },
      }),
    },
    ssh: {
      status: () => ({ tunnelUp: true, tunnelError: null }),
      reconnect: async () => undefined,
      test: async () => ({ ok: false, authFailed: true, output: "Permission denied" }),
      copyId: () => job("ssh_copy_id"),
    },
    exec,
    proxy: overrides.proxy,
    links: overrides.links,
    machines: overrides.machines,
    multiHost: {
      machines: async () => [
        {
          id: "local",
          name: "desk",
          role: "both",
          status: "online",
          isLocal: true,
          serverVersion: "1.0.0-dev",
          protocol: 1,
          capabilities: ["http.v1"],
          lastSeen: T1,
          platform: "linux",
        },
      ],
      enroll: async () => ({
        code: "7K2Q-M9XD-4HPA-R3TB",
        expiresAt: T1,
        hubUrl: "https://hub.example.com:21402",
      }),
      revoke: async (id) => {
        if (id !== "m1") throw new ApiError("not_found", `No machine has the id ${id}.`);
      },
      guiClients: () => ({ clients: [], port: null }),
      enrollGui: async () => ({
        code: "7K2Q-M9XD-4HPA-R3TC",
        expiresAt: T1,
        hubUrl: "https://hub.example.com:21403",
      }),
      revokeGui: async (id) => {
        if (id !== "g1") throw new ApiError("not_found", `No GUI client has the id ${id}.`);
      },
      status: () => ({ ...NODE_STATUS }),
      health: async () => ({
        engineVersion: "1.0.0-dev",
        expectedEngineVersion: "1.0.0-dev",
        image: "ready",
        diskFreeBytes: 1_000_000,
        diskTotalBytes: 4_000_000,
        checkedAt: T1,
      }),
      join: async (input) => ({
        ...NODE_STATUS,
        role: "node",
        machineId: "m1",
        hubUrl: input.hubUrl,
        link: "connecting",
      }),
    },
  };
  const server = await createApiServer(deps);
  return { core, deps, server, hub, jobs, engine, exec, runs };
}
