// Keeps one `EngineClient` per running project container: relays engine
// events into the server's stream, answers lease requests with the
// scheduler, and resynchronizes the run mirror when events were missed.
import type {
  AgentBoxEvent,
  EngineInfo,
  LeaseRequest,
  LeaseResponse,
  RunState,
} from "@agentbox/contracts";
import type { CoreEngines, EngineEndpoint, SqlDatabase } from "../api/core-interface.js";
import { ApiFailure } from "../api/errors.js";
import { EngineClient, type EngineClientOptions, type StreamCursor } from "./engine-client.js";

export interface EngineSupervisorOptions {
  engines: CoreEngines;
  db: SqlDatabase;
  expectedVersion: string;
  /** Receives every engine event in order. */
  relay(event: AgentBoxEvent): void;
  /** Decides a lease for the engine of `projectId`. */
  decideLease(engineKey: string, projectId: string, request: LeaseRequest): Promise<LeaseResponse>;
  /** Receives the runs an engine lists after a resync. */
  onRuns?(runs: RunState[]): void;
  onInfo?(container: string, info: EngineInfo): void;
  log?(message: string): void;
  /** How often to look for added or removed containers. */
  intervalMs?: number;
  /** Builds a client; tests replace it. */
  createClient?(options: EngineClientOptions): EngineClient;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS svc_engine_cursors (
  container TEXT PRIMARY KEY,
  stream_id TEXT NOT NULL,
  last_seq INTEGER NOT NULL
);
`;

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

function sameEndpoint(a: EngineEndpoint, b: EngineEndpoint): boolean {
  return a.hostPort === b.hostPort && a.token === b.token && a.projectId === b.projectId;
}

export class EngineSupervisor {
  private readonly clients = new Map<string, EngineClient>();
  private timer: NodeJS.Timeout | null = null;
  private refreshing: Promise<void> | null = null;

  constructor(private readonly options: EngineSupervisorOptions) {
    options.db.exec(SCHEMA);
  }

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
      onEvent: (event) => this.options.relay(event),
      onLease: (request) => this.options.decideLease(engineKey, endpoint.projectId, request),
      onResync: () => void this.resync(endpoint.container),
      onInfo: (info) => this.options.onInfo?.(endpoint.container, info),
      log: this.options.log,
    };
    return this.options.createClient?.(options) ?? new EngineClient(options);
  }

  private async resync(container: string): Promise<void> {
    const client = this.clients.get(container);
    if (!client) return;
    try {
      const { runs } = (await client.call("engine.runs.list")) as { runs: RunState[] };
      this.options.onRuns?.(runs);
    } catch (err) {
      this.options.log?.(`Resync of ${container} failed: ${(err as Error).message}`);
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
      throw new ApiFailure(
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
