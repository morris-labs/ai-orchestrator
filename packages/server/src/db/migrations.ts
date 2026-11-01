// Schema migrations, applied in order. `PRAGMA user_version` holds the number
// of migrations applied. Never edit a migration that has shipped; add one. A
// migration is SQL, or a function for a step that SQL can't express.
import { deriveHostKey } from "@aio/contracts";
import type { Sqlite } from "./database.js";

export type Migration = string | ((db: Sqlite) => void);

/**
 * Gives every box a host key no other box has. The proxy resolves
 * `<port>.<hostKey>.localhost` across every project, so a key unique only
 * within its project could reach another project's engine. The oldest box
 * keeps a shared key; the others get a new one.
 */
export function rekeyDuplicateHostKeys(db: Sqlite): void {
  const rows = db.prepare("SELECT id, host_key, data FROM boxes ORDER BY created_at, id").all() as {
    id: string;
    host_key: string;
    data: string;
  }[];
  // Every key any row holds, so a replacement never takes a key that a later
  // row in the same project already has.
  const taken = new Set(rows.map((r) => r.host_key));
  const kept = new Set<string>();
  const update = db.prepare("UPDATE boxes SET host_key = ?, data = ? WHERE id = ?");
  for (const row of rows) {
    if (!kept.has(row.host_key)) {
      kept.add(row.host_key);
      continue;
    }
    const key = deriveHostKey(row.id, taken);
    taken.add(key);
    const data = { ...(JSON.parse(row.data) as Record<string, unknown>), hostKey: key };
    update.run(key, JSON.stringify(data), row.id);
  }
}

export const MIGRATIONS: readonly Migration[] = [
  // 1: records, settings, the engine registry, the review mirror, jobs, imports.
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    root TEXT NOT NULL UNIQUE,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE boxes (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    session_uuid TEXT,
    host_key TEXT NOT NULL,
    target_dir TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id, host_key)
  );
  CREATE INDEX boxes_session_uuid ON boxes(session_uuid);
  CREATE INDEX boxes_target_dir ON boxes(target_dir);

  CREATE TABLE ssh_remotes (
    name TEXT PRIMARY KEY,
    data TEXT NOT NULL
  );

  CREATE TABLE settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE engine_endpoints (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    container TEXT NOT NULL UNIQUE,
    host_port INTEGER NOT NULL UNIQUE,
    token TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    box_id TEXT,
    container TEXT NOT NULL,
    status TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX runs_project ON runs(project_id);
  CREATE INDEX runs_box ON runs(box_id);
  CREATE INDEX runs_status ON runs(status);

  CREATE TABLE findings (
    run_id TEXT NOT NULL,
    finding_id TEXT NOT NULL,
    round INTEGER NOT NULL,
    verdict TEXT NOT NULL,
    severity TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (run_id, finding_id)
  );

  CREATE TABLE usage_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor TEXT NOT NULL,
    account TEXT NOT NULL,
    window TEXT NOT NULL,
    time TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX usage_samples_vendor_time ON usage_samples(vendor, time);

  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    box_id TEXT,
    status TEXT NOT NULL,
    data TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT
  );

  CREATE TABLE imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    report TEXT NOT NULL
  );
  `,
  // 2: host keys unique across every project.
  (db) => {
    rekeyDuplicateHostKeys(db);
    db.exec("CREATE UNIQUE INDEX boxes_host_key_unique ON boxes(host_key)");
  },
  // 3: the service tables (event log, engine cursors, run and finding
  // mirror, notifications, usage), which their modules created on their own
  // before; and the first draft's run, finding, usage, and job tables, which
  // nothing used. IF NOT EXISTS keeps service tables that a database
  // already has.
  `
  DROP TABLE IF EXISTS runs;
  DROP TABLE IF EXISTS findings;
  DROP TABLE IF EXISTS usage_samples;
  DROP TABLE IF EXISTS jobs;
  CREATE TABLE IF NOT EXISTS svc_event_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS svc_events (seq INTEGER PRIMARY KEY, type TEXT NOT NULL, json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS svc_engine_cursors (
    container TEXT PRIMARY KEY,
    stream_id TEXT NOT NULL,
    last_seq INTEGER NOT NULL
  );
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
  CREATE TABLE IF NOT EXISTS svc_findings (
    run_id TEXT NOT NULL,
    finding_id TEXT NOT NULL,
    round INTEGER NOT NULL,
    verdict TEXT NOT NULL,
    severity TEXT NOT NULL,
    json TEXT NOT NULL,
    PRIMARY KEY (run_id, finding_id)
  );
  CREATE TABLE IF NOT EXISTS svc_notifications (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    read INTEGER NOT NULL DEFAULT 0,
    json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS svc_usage_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time TEXT NOT NULL,
    time_ms INTEGER NOT NULL,
    vendor TEXT NOT NULL,
    account TEXT NOT NULL,
    window TEXT NOT NULL,
    project_id TEXT,
    json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS svc_usage_samples_vendor ON svc_usage_samples (vendor, window, time_ms);
  CREATE TABLE IF NOT EXISTS svc_lease_settlements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time TEXT NOT NULL,
    lease_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    vendor TEXT NOT NULL,
    role TEXT NOT NULL,
    tokens_in INTEGER NOT NULL,
    tokens_out INTEGER NOT NULL,
    premium_requests REAL NOT NULL,
    cost_estimate REAL NOT NULL
  );
`,
  // 4: accounts (phase 1).
  `
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    vendor TEXT NOT NULL,
    name TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (vendor, name)
  );
`,
];
