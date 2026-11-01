// Keeps one `EngineClient` per running project container: relays engine
// events into the server's stream, answers lease requests with the
// scheduler, and resynchronizes the run mirror when events were missed.
import type {
  AioEvent,
  EngineInfo,
  Finding,
  LeaseRequest,
  LeaseResponse,
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
 * to relay it. An engine emits run, agent, finding, lease, usage, and port
 * events, and only for its own container, its own project, and runs of that
 * project; a run event needs the run's `run.changed` first. Boxes,
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
    case "agent.started":
    case "agent.finished":
    case "stage.changed":
    case "handoff":
    case "role.reassigned":
    case "lease.settled":
      return ownRun(event.runId);
    default:
      return `engines don't emit ${event.type} events`;
  }
}

function sameEndpoint(a: EngineEndpoint, b: EngineEndpoint): boolean {
  return a.hostPort === b.hostPort && a.token === b.token && a.projectId === b.projectId;
}

export class EngineSupervisor {
  private readonly clients = new Map<string, EngineClient>();
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
    await Promise.all([...this.clients.values()].map((c) => c.stop()));
    this.clients.clear();
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
        await client.stop();
      }
    }
    for (const endpoint of endpoints) {
      if (this.clients.has(endpoint.container) || endpoint.hostPort === null) continue;
      const client = this.build(endpoint);
      this.clients.set(endpoint.container, client);
      client.start();
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
    } catch (err) {
      this.options.log?.(`Resync of ${container} failed: ${(err as Error).message}`);
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
