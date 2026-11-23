// Keeps one `EngineClient` per running project container: relays engine
// events into the server's stream, answers lease requests with the
// scheduler, and resynchronizes the run mirror when events were missed.
import type {
  AioEvent,
  BuildSummary,
  EngineInfo,
  Finding,
  LeaseRequest,
  LeaseResponse,
  Listener,
  RunState,
} from "@aio/contracts";
import type { CoreEngines, EngineEndpoint, SqlDatabase } from "../api/core-interface.js";
import { ApiError } from "../api/errors.js";
import { EngineClient, type EngineClientOptions, type StreamCursor } from "./engine-client.js";

export interface EngineSupervisorOptions {
  engines: CoreEngines;
  db: SqlDatabase;
  expectedVersion: string;
  /** Receives every engine event in order. */
  relay(event: AioEvent): void;
  /** Decides a lease for the engine of `projectId`. */
  decideLease(engineKey: string, projectId: string, request: LeaseRequest): Promise<LeaseResponse>;
  /** Receives the runs an engine lists after a resync. */
  onRuns?(runs: RunState[]): void;
  /** Receives every finding of one run after a resync; the list replaces the mirrored one. */
  onFindings?(runId: string, findings: Finding[]): void;
  /**
   * Called when an engine's stream starts over (a new engine process, or a
   * first connection), before its state is reloaded. Lease answers cached
   * for `engineKey` belong to the old process.
   */
  onStreamReset?(engineKey: string): void;
  onInfo?(container: string, info: EngineInfo): void;
  /** Receives a new client's current listeners. */
  onPorts?(container: string, listeners: Listener[]): void;
  /** The wait before a failed resync runs again. Default: 10 seconds. */
  resyncRetryMs?: number;
  log?(message: string): void;
  /** How often to look for added or removed containers. */
  intervalMs?: number;
  /** Builds a client; tests replace it. */
  createClient?(options: EngineClientOptions): EngineClient;
}

/** A `StreamCursor` stored in SQLite, one row per container. */
export function sqliteCursor(db: SqlDatabase, container: string): StreamCursor {
  return {
    get() {
      const row = db
        .prepare("SELECT stream_id, last_seq FROM svc_engine_cursors WHERE container = ?")
        .get(container) as { stream_id: string; last_seq: number } | undefined;
      return row ? { streamId: row.stream_id, lastSeq: row.last_seq } : null;
    },
    set(streamId, lastSeq) {
      db.prepare(
        `INSERT INTO svc_engine_cursors (container, stream_id, last_seq) VALUES (?, ?, ?)
         ON CONFLICT (container) DO UPDATE SET stream_id = excluded.stream_id, last_seq = excluded.last_seq`,
      ).run(container, streamId, lastSeq);
    },
  };
}

/** The project a run belongs to in the mirror, or `undefined` for a run it hasn't seen. */
function runProject(db: SqlDatabase, runId: string): string | undefined {
  const row = db.prepare("SELECT project_id FROM svc_runs WHERE id = ?").get(runId) as
    { project_id: string } | undefined;
  return row?.project_id;
}

/** The project a build belongs to in the mirror, or `undefined` for a build it hasn't seen. */
function buildProject(db: SqlDatabase, buildId: string): string | undefined {
  const row = db.prepare("SELECT project_id FROM svc_builds WHERE id = ?").get(buildId) as
    { project_id: string } | undefined;
  return row?.project_id;
}

/** Why a build state doesn't belong to the engine at `endpoint`, or `null` when it does. */
export function foreignBuildReason(
  db: SqlDatabase,
  endpoint: Pick<EngineEndpoint, "container" | "projectId">,
  build: BuildSummary,
): string | null {
  if (build.projectId !== endpoint.projectId || build.container !== endpoint.container) {
    return `build ${build.id} belongs to ${build.container} in project ${build.projectId}`;
  }
  const known = buildProject(db, build.id);
  if (known !== undefined && known !== endpoint.projectId) {
    return `build ${build.id} belongs to project ${known}`;
  }
  return null;
}

/** The project of a box, or `undefined` for a box the database doesn't hold. */
function boxProject(db: SqlDatabase, boxId: string): string | undefined {
  const row = db.prepare("SELECT project_id FROM boxes WHERE id = ?").get(boxId) as
    { project_id: string } | undefined;
  return row?.project_id;
}

/** Why a run state doesn't belong to the engine at `endpoint`, or `null` when it does. */
export function foreignRunReason(
  db: SqlDatabase,
  endpoint: Pick<EngineEndpoint, "container" | "projectId">,
  run: RunState,
): string | null {
  if (run.projectId !== endpoint.projectId || run.container !== endpoint.container) {
    return `run ${run.id} belongs to ${run.container} in project ${run.projectId}`;
  }
  const known = runProject(db, run.id);
  if (known !== undefined && known !== endpoint.projectId) {
    return `run ${run.id} belongs to project ${known}`;
  }
  if (run.boxId !== undefined) {
    const owner = boxProject(db, run.boxId);
    if (owner !== undefined && owner !== endpoint.projectId) {
      return `box ${run.boxId} belongs to project ${owner}`;
    }
  }
  return null;
}

/**
 * Why the server must drop an event from the engine at `endpoint`, or `null`
 * to relay it. An engine emits run, build, message, agent, finding, lease, usage,
 * and port events, and only for its own container, its own project, and runs
 * and builds of that project; a run event needs the run's `run.changed`
 * first, and a build event the build's `build.changed`. An agent or lease
 * event names a run, a build, or both, and each must be the engine's. Boxes,
 * containers, terminals, notifications, settings, and ceilings are the
 * server's own events.
 */
export function engineEventRefusal(
  db: SqlDatabase,
  endpoint: Pick<EngineEndpoint, "container" | "projectId">,
  event: AioEvent,
): string | null {
  const ownRun = (runId: string) => {
    const project = runProject(db, runId);
    if (project === undefined) return `run ${runId} is unknown`;
    return project === endpoint.projectId ? null : `run ${runId} belongs to project ${project}`;
  };
  const ownBuild = (buildId: string) => {
    const project = buildProject(db, buildId);
    if (project === undefined) return `build ${buildId} is unknown`;
    return project === endpoint.projectId ? null : `build ${buildId} belongs to project ${project}`;
  };
  const ownCall = (owner: { runId: string | null; buildId?: string }) => {
    if (owner.runId === null && owner.buildId === undefined) {
      return "the call names neither a run nor a build";
    }
    return (
      (owner.runId === null ? null : ownRun(owner.runId)) ??
      (owner.buildId === undefined ? null : ownBuild(owner.buildId))
    );
  };
  switch (event.type) {
    case "usage.sample":
      return null;
    case "ports.changed":
      return event.container === endpoint.container
        ? null
        : `the listeners are for ${event.container}`;
    case "run.changed":
      return foreignRunReason(db, endpoint, event.run);
    case "finding.changed":
      return event.finding.runId === event.runId
        ? ownRun(event.runId)
        : `finding ${event.finding.id} belongs to run ${event.finding.runId}`;
    case "build.changed":
      return foreignBuildReason(db, endpoint, event.build);
    case "build.task.changed":
      return ownBuild(event.buildId);
    case "message.sent":
      return ownBuild(event.message.buildId);
    case "agent.started":
    case "agent.finished":
    case "lease.settled":
      return ownCall(event);
    case "stage.changed":
    case "handoff":
    case "role.reassigned":
      return ownRun(event.runId);
    default:
      return `engines don't emit ${event.type} events`;
  }
}

function sameEndpoint(a: EngineEndpoint, b: EngineEndpoint): boolean {
  return a.hostPort === b.hostPort && a.token === b.token && a.projectId === b.projectId;
}

/** How many times in a row a listener load fails before it retries less often. */
const PORT_LOAD_ATTEMPTS = 6;

/** How much longer the wait between retries is once a listener load keeps failing. */
const PORT_SLOW_RETRY_FACTOR = 30;

/** The state of one client's listener load chain. */
interface PortLoad {
  running: boolean;
  /** Another load was requested while this one ran. */
  again: boolean;
  timer: NodeJS.Timeout | null;
  failures: number;
}

export class EngineSupervisor {
  private readonly clients = new Map<string, EngineClient>();
  private readonly portLoads = new Map<EngineClient, PortLoad>();
  private timer: NodeJS.Timeout | null = null;
  private refreshing: Promise<void> | null = null;

  /** `options.db` comes from `openDatabase()`, whose migrations create its tables. */
  constructor(private readonly options: EngineSupervisorOptions) {}

  /** Starts watching; the first refresh runs at once. */
  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.options.intervalMs ?? 5000);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Clearing the map first keeps a pending retry from calling a client
    // that is stopping.
    const clients = [...this.clients.values()];
    this.clients.clear();
    clients.forEach((c) => this.forgetPorts(c));
    await Promise.all(clients.map((c) => c.stop()));
  }

  /** Reconciles the clients with the core's engine list. Concurrent calls share one pass. */
  refresh(): Promise<void> {
    this.refreshing ??= this.doRefresh().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    let endpoints: EngineEndpoint[];
    try {
      endpoints = await this.options.engines.list();
    } catch (err) {
      this.options.log?.(`Listing engines failed: ${(err as Error).message}`);
      return;
    }
    const wanted = new Map(endpoints.map((e) => [e.container, e]));
    for (const [container, client] of this.clients) {
      const endpoint = wanted.get(container);
      if (!endpoint || !sameEndpoint(endpoint, client.endpoint)) {
        this.clients.delete(container);
        this.forgetPorts(client);
        await client.stop();
      }
    }
    for (const endpoint of endpoints) {
      if (this.clients.has(endpoint.container) || endpoint.hostPort === null) continue;
      const client = this.build(endpoint);
      this.clients.set(endpoint.container, client);
      client.start();
      this.loadPorts(client);
    }
  }

  private build(endpoint: EngineEndpoint): EngineClient {
    const engineKey = endpoint.container;
    const options: EngineClientOptions = {
      endpoint,
      expectedVersion: this.options.expectedVersion,
      cursor: sqliteCursor(this.options.db, endpoint.container),
      onEvent: (event) => {
        const refusal = engineEventRefusal(this.options.db, endpoint, event);
        if (refusal) {
          this.options.log?.(`Dropped event ${event.seq} from ${endpoint.container}: ${refusal}.`);
          return;
        }
        this.options.relay(event);
      },
      onLease: (request) => this.options.decideLease(engineKey, endpoint.projectId, request),
      onResync: () => void this.resync(endpoint.container),
      onInfo: (info) => this.options.onInfo?.(endpoint.container, info),
      log: this.options.log,
    };
    return this.options.createClient?.(options) ?? new EngineClient(options);
  }

  /**
   * Loads a client's listeners. A restarted server has none in memory, and
   * listeners that haven't changed send no `ports.changed`. Each client has at
   * most one load chain: a request while a load runs makes it run once more,
   * and a request while a retry waits runs it at once.
   */
  private loadPorts(client: EngineClient): void {
    if (!this.options.onPorts) return;
    // A resync that outlived its client must not start a load that nothing
    // would ever remove.
    if (this.clients.get(client.endpoint.container) !== client) return;
    const load = this.portLoads.get(client);
    if (!load) {
      const fresh: PortLoad = { running: false, again: false, timer: null, failures: 0 };
      this.portLoads.set(client, fresh);
      void this.runPortLoad(client, fresh);
    } else if (load.running) {
      load.again = true;
    } else {
      if (load.timer) clearTimeout(load.timer);
      load.timer = null;
      load.failures = 0;
      void this.runPortLoad(client, load);
    }
  }

  private async runPortLoad(client: EngineClient, load: PortLoad): Promise<void> {
    const container = client.endpoint.container;
    const current = () =>
      this.clients.get(container) === client && this.portLoads.get(client) === load;
    load.running = true;
    load.again = false;
    try {
      const { listeners } = (await client.call("engine.ports")) as { listeners: Listener[] };
      load.failures = 0;
      if (current()) this.options.onPorts?.(container, listeners);
    } catch (err) {
      load.failures += 1;
      // Past the fast budget, the "retrying less often" line stands for every
      // later failure, so a route that never answers doesn't log forever.
      if (current() && load.failures <= PORT_LOAD_ATTEMPTS) {
        this.options.log?.(
          `Loading the listeners of ${container} failed: ${(err as Error).message}`,
        );
      }
    } finally {
      load.running = false;
    }
    if (!current()) {
      if (this.portLoads.get(client) === load) this.portLoads.delete(client);
      return;
    }
    if (load.again) {
      load.failures = 0;
      void this.runPortLoad(client, load);
      return;
    }
    if (load.failures === 0) {
      this.portLoads.delete(client);
      return;
    }
    if (load.failures === PORT_LOAD_ATTEMPTS) {
      this.options.log?.(
        `Loading the listeners of ${container} failed ${load.failures} times in a row; retrying less often.`,
      );
    }
    // An engine that is still starting answers later. Unchanged listeners
    // send no ports.changed and the stream can stay connected, so the load
    // keeps retrying, less often once it keeps failing; without a retry the
    // list stays empty until the stream resets.
    const retryMs = this.options.resyncRetryMs ?? 10_000;
    load.timer = setTimeout(
      () => {
        load.timer = null;
        if (current()) void this.runPortLoad(client, load);
      },
      load.failures >= PORT_LOAD_ATTEMPTS ? retryMs * PORT_SLOW_RETRY_FACTOR : retryMs,
    );
    load.timer.unref();
  }

  /** Cancels a client's pending listener load. */
  private forgetPorts(client: EngineClient): void {
    const load = this.portLoads.get(client);
    if (load?.timer) clearTimeout(load.timer);
    this.portLoads.delete(client);
  }

  /** Reloads an engine's runs and their findings after its stream starts over. */
  private async resync(container: string): Promise<void> {
    const client = this.clients.get(container);
    if (!client) return;
    this.options.onStreamReset?.(container);
    let runs: RunState[];
    try {
      const listed = ((await client.call("engine.runs.list")) as { runs: RunState[] }).runs;
      runs = listed.filter((run) => {
        const refusal = foreignRunReason(this.options.db, client.endpoint, run);
        if (refusal) this.options.log?.(`Resync of ${container} dropped a run: ${refusal}.`);
        return refusal === null;
      });
      this.options.onRuns?.(runs);
      // A stream that started over can have missed ports.changed events too.
      this.loadPorts(client);
    } catch (err) {
      this.options.log?.(`Resync of ${container} failed: ${(err as Error).message}`);
      // The cursor has moved, so the stream won't ask again: without a retry,
      // later events for runs missing from the mirror get dropped.
      setTimeout(() => {
        if (this.clients.get(container) === client) void this.resync(container);
      }, this.options.resyncRetryMs ?? 10_000).unref();
      return;
    }
    if (!this.options.onFindings) return;
    for (const run of runs) {
      try {
        const { findings } = (await client.call("engine.findings.list", {
          params: { runId: run.id },
        })) as { findings: Finding[] };
        this.options.onFindings(
          run.id,
          findings.filter((f) => f.runId === run.id),
        );
      } catch (err) {
        this.options.log?.(
          `Resync of the findings of run ${run.id} in ${container} failed: ${(err as Error).message}`,
        );
      }
    }
  }

  get(container: string): EngineClient | undefined {
    return this.clients.get(container);
  }

  all(): EngineClient[] {
    return [...this.clients.values()];
  }

  /** The engine of a project, or `undefined` when its container isn't running. */
  forProject(projectId: string): EngineClient | undefined {
    return this.all().find((c) => c.endpoint.projectId === projectId);
  }

  /** Like `forProject`, but throws when the engine isn't there or has the wrong version. */
  requireProject(projectId: string): EngineClient {
    const client = this.forProject(projectId);
    if (!client) {
      throw new ApiError(
        "conflict",
        `The container of project ${projectId} is not running. Start a box in the project first.`,
      );
    }
    client.assertVersion();
    return client;
  }

  /** The engine info of a container, for the core's `ContainerInfo`. */
  info(container: string): EngineInfo | null {
    return this.clients.get(container)?.info ?? null;
  }
}
