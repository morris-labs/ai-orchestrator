// The SQLite mirror of review runs. The engines own the run files; the server
// keeps the latest `RunState` of every run it has seen, from `run.changed`
// events and from the run routes it proxies, so it knows which engine holds a
// run and which box a run holds. It also keeps the latest state of every
// finding, from `finding.changed` events.
import {
  FindingSchema,
  RunStateSchema,
  type Finding,
  type AgentBoxEvent,
  type RunState,
  type RunStatus,
} from "@agentbox/contracts";
import type { EngineEndpoint, SqlDatabase } from "../api/core-interface.js";
import { foreignRunReason } from "./engines.js";

/** The statuses in which a run holds its box's working tree. */
export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = [
  "pending",
  "running",
  "paused",
  "waiting_decision",
];

export class RunMirror {
  /** `db` comes from `openDatabase()`, whose migrations create its tables. */
  constructor(private readonly db: SqlDatabase) {}

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

  /**
   * Why a run state an engine returned doesn't belong to that engine, or
   * `null` when it does. Applies the same rules as the event relay, so the
   * server stores only runs of the engine's own project and container.
   */
  foreignReason(endpoint: Pick<EngineEndpoint, "container" | "projectId">, run: RunState) {
    return foreignRunReason(this.db, endpoint, run);
  }

  /** Mirrors `run.changed` and `finding.changed` events; ignores every other event. */
  ingest(event: AgentBoxEvent): void {
    if (event.type === "run.changed") this.upsert(event.run);
    if (event.type === "finding.changed") this.upsertFinding(event.finding);
  }

  /** Stores a finding's latest state; events arrive in order, so the last one wins. */
  upsertFinding(finding: Finding): void {
    this.db
      .prepare(
        `INSERT INTO svc_findings (run_id, finding_id, round, verdict, severity, json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (run_id, finding_id) DO UPDATE SET round = excluded.round,
           verdict = excluded.verdict, severity = excluded.severity, json = excluded.json`,
      )
      .run(
        finding.runId,
        finding.id,
        finding.round,
        finding.verdict,
        finding.severity,
        JSON.stringify(finding),
      );
  }

  /** Replaces every mirrored finding of a run, as after an engine resync. */
  replaceFindings(runId: string, findings: readonly Finding[]): void {
    const run = () => {
      this.db.prepare("DELETE FROM svc_findings WHERE run_id = ?").run(runId);
      for (const f of findings) this.upsertFinding(f);
    };
    const db = this.db as unknown as { transaction?: (fn: () => void) => () => void };
    if (typeof db.transaction === "function") db.transaction(run)();
    else run();
  }

  /** The mirrored findings of a run, by id. */
  findings(runId: string): Finding[] {
    return (
      this.db
        .prepare("SELECT json FROM svc_findings WHERE run_id = ? ORDER BY finding_id")
        .all(runId) as { json: string }[]
    ).map((r) => FindingSchema.parse(JSON.parse(r.json)));
  }

  get(runId: string): RunState | undefined {
    const row = this.db.prepare("SELECT json FROM svc_runs WHERE id = ?").get(runId) as
      { json: string } | undefined;
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
