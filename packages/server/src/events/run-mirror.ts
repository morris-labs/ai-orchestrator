// The SQLite mirror of review runs. The engines own the run files; the server
// keeps the latest `RunState` of every run it has seen, from `run.changed`
// events and from the run routes it proxies, so it knows which engine holds a
// run and which box a run holds.
import { RunStateSchema, type AgentBoxEvent, type RunState, type RunStatus } from "@agentbox/contracts";
import type { SqlDatabase } from "../api/core-interface.js";

/** The statuses in which a run holds its box's working tree. */
export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = [
  "pending",
  "running",
  "paused",
  "waiting_decision",
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS svc_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  box_id TEXT,
  container TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS svc_runs_box ON svc_runs (box_id, status);
`;

export class RunMirror {
  constructor(private readonly db: SqlDatabase) {
    db.exec(SCHEMA);
  }

  /** Stores a run unless the mirror already has a newer state of it. */
  upsert(run: RunState): void {
    const current = this.get(run.id);
    if (current && current.updatedAt > run.updatedAt) return;
    this.db
      .prepare(
        `INSERT INTO svc_runs (id, project_id, box_id, container, status, created_at, updated_at, json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET project_id = excluded.project_id, box_id = excluded.box_id,
           container = excluded.container, status = excluded.status, updated_at = excluded.updated_at,
           json = excluded.json`,
      )
      .run(
        run.id,
        run.projectId,
        run.boxId ?? null,
        run.container,
        run.status,
        run.createdAt,
        run.updatedAt,
        JSON.stringify(run),
      );
  }

  /** Mirrors `run.changed` events; ignores every other event. */
  ingest(event: AgentBoxEvent): void {
    if (event.type === "run.changed") this.upsert(event.run);
  }

  get(runId: string): RunState | undefined {
    const row = this.db.prepare("SELECT json FROM svc_runs WHERE id = ?").get(runId) as
      | { json: string }
      | undefined;
    return row ? RunStateSchema.parse(JSON.parse(row.json)) : undefined;
  }

  list(query: { projectId?: string; boxId?: string; status?: RunStatus } = {}): RunState[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.projectId !== undefined) {
      where.push("project_id = ?");
      params.push(query.projectId);
    }
    if (query.boxId !== undefined) {
      where.push("box_id = ?");
      params.push(query.boxId);
    }
    if (query.status !== undefined) {
      where.push("status = ?");
      params.push(query.status);
    }
    const sql = `SELECT json FROM svc_runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC`;
    return (this.db.prepare(sql).all(...params) as { json: string }[]).map((r) =>
      RunStateSchema.parse(JSON.parse(r.json)),
    );
  }

  /** The active run that holds a box, or `null`. */
  activeRunForBox(boxId: string): string | null {
    const marks = ACTIVE_RUN_STATUSES.map(() => "?").join(", ");
    const row = this.db
      .prepare(
        `SELECT id FROM svc_runs WHERE box_id = ? AND status IN (${marks}) ORDER BY created_at DESC LIMIT 1`,
      )
      .get(boxId, ...ACTIVE_RUN_STATUSES) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /** The run's current round, or 0 when the run is unknown. */
  round(runId: string): number {
    return this.get(runId)?.round ?? 0;
  }
}
