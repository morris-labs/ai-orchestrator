// Schema migrations, applied in order. `PRAGMA user_version` holds the number
// of migrations applied. Never edit a migration that has shipped; add one.

export const MIGRATIONS: readonly string[] = [
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
];
