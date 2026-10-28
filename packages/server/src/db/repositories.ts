// Typed repositories over the SQLite tables. Each record is stored as a JSON
// document validated by its contract schema on the way in and on the way out,
// with the columns that queries need copied beside it.
import {
  BoxSchema,
  FindingSchema,
  GlobalSettingsSchema,
  JobSchema,
  ProjectSchema,
  RunStateSchema,
  SshRemoteSchema,
  TimedUsageSampleSchema,
  defaultConfig,
  type Box,
  type Finding,
  type GlobalSettings,
  type Job,
  type Project,
  type RunState,
  type SshRemote,
  type TimedUsageSample,
  type Vendor,
} from "@agentbox/contracts";
import type { Sqlite } from "./database.js";

interface DataRow {
  data: string;
}

/** Builds a `WHERE` clause from the conditions whose value is defined. */
function whereOf(conditions: [sql: string, value: string | number | undefined][]): {
  sql: string;
  args: (string | number)[];
} {
  const used = conditions.filter((c): c is [string, string | number] => c[1] !== undefined);
  return {
    sql: used.length ? `WHERE ${used.map((c) => c[0]).join(" AND ")}` : "",
    args: used.map((c) => c[1]),
  };
}

function parseRows<T>(rows: unknown[], parse: (v: unknown) => T): T[] {
  return (rows as DataRow[]).map((r) => parse(JSON.parse(r.data)));
}

export class ProjectsRepo {
  constructor(private readonly db: Sqlite) {}

  get(id: string): Project | undefined {
    const row = this.db.prepare("SELECT data FROM projects WHERE id = ?").get(id) as
      DataRow | undefined;
    return row ? ProjectSchema.parse(JSON.parse(row.data)) : undefined;
  }

  byRoot(root: string): Project | undefined {
    const row = this.db.prepare("SELECT data FROM projects WHERE root = ?").get(root) as
      DataRow | undefined;
    return row ? ProjectSchema.parse(JSON.parse(row.data)) : undefined;
  }

  list(): Project[] {
    return parseRows(this.db.prepare("SELECT data FROM projects ORDER BY id").all(), (v) =>
      ProjectSchema.parse(v),
    );
  }

  /** Inserts or replaces a project. */
  put(project: Project): Project {
    const p = ProjectSchema.parse(project);
    this.db
      .prepare(
        `INSERT INTO projects (id, root, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET root = excluded.root, data = excluded.data,
           updated_at = excluded.updated_at`,
      )
      .run(p.id, p.root, JSON.stringify(p), p.createdAt, p.updatedAt);
    return p;
  }

  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM projects WHERE id = ?").run(id).changes > 0;
  }
}

export class BoxesRepo {
  constructor(private readonly db: Sqlite) {}

  get(id: string): Box | undefined {
    const row = this.db.prepare("SELECT data FROM boxes WHERE id = ?").get(id) as
      DataRow | undefined;
    return row ? BoxSchema.parse(JSON.parse(row.data)) : undefined;
  }

  /** Every box, ordered by id (the 3.3.5 `known/` directory order). */
  list(): Box[] {
    return parseRows(this.db.prepare("SELECT data FROM boxes ORDER BY id").all(), (v) =>
      BoxSchema.parse(v),
    );
  }

  byProject(projectId: string): Box[] {
    return parseRows(
      this.db.prepare("SELECT data FROM boxes WHERE project_id = ? ORDER BY id").all(projectId),
      (v) => BoxSchema.parse(v),
    );
  }

  bySession(sessionUuid: string): Box[] {
    return parseRows(
      this.db.prepare("SELECT data FROM boxes WHERE session_uuid = ? ORDER BY id").all(sessionUuid),
      (v) => BoxSchema.parse(v),
    );
  }

  byTargetDir(targetDir: string): Box[] {
    return parseRows(
      this.db.prepare("SELECT data FROM boxes WHERE target_dir = ? ORDER BY id").all(targetDir),
      (v) => BoxSchema.parse(v),
    );
  }

  /** Inserts or replaces a box. */
  put(box: Box): Box {
    const b = BoxSchema.parse(box);
    this.db
      .prepare(
        `INSERT INTO boxes (id, project_id, session_uuid, host_key, target_dir, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id,
           session_uuid = excluded.session_uuid, host_key = excluded.host_key,
           target_dir = excluded.target_dir, data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(
        b.id,
        b.projectId,
        b.sessionUuid,
        b.hostKey,
        b.targetDir,
        JSON.stringify(b),
        b.createdAt,
        b.updatedAt,
      );
    return b;
  }

  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM boxes WHERE id = ?").run(id).changes > 0;
  }
}

export class SshRemotesRepo {
  constructor(private readonly db: Sqlite) {}

  get(name: string): SshRemote | undefined {
    const row = this.db.prepare("SELECT data FROM ssh_remotes WHERE name = ?").get(name) as
      DataRow | undefined;
    return row ? SshRemoteSchema.parse(JSON.parse(row.data)) : undefined;
  }

  list(): SshRemote[] {
    return parseRows(this.db.prepare("SELECT data FROM ssh_remotes ORDER BY name").all(), (v) =>
      SshRemoteSchema.parse(v),
    );
  }

  put(remote: SshRemote): SshRemote {
    const r = SshRemoteSchema.parse(remote);
    this.db
      .prepare(
        `INSERT INTO ssh_remotes (name, data) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET data = excluded.data`,
      )
      .run(r.name, JSON.stringify(r));
    return r;
  }

  delete(name: string): boolean {
    return this.db.prepare("DELETE FROM ssh_remotes WHERE name = ?").run(name).changes > 0;
  }
}

export class SettingsRepo {
  constructor(private readonly db: Sqlite) {}

  /** Whether settings were ever saved. */
  exists(): boolean {
    return this.db.prepare("SELECT 1 FROM settings WHERE id = 1").get() !== undefined;
  }

  /** The stored settings, or the defaults when none were saved. */
  get(): GlobalSettings {
    const row = this.db.prepare("SELECT data FROM settings WHERE id = 1").get() as
      DataRow | undefined;
    return row ? GlobalSettingsSchema.parse(JSON.parse(row.data)) : defaultConfig();
  }

  put(settings: GlobalSettings, now: Date): GlobalSettings {
    const s = GlobalSettingsSchema.parse(settings);
    this.db
      .prepare(
        `INSERT INTO settings (id, data, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(s), now.toISOString());
    return s;
  }
}

/** A project container's engine: the loopback port that maps to 20411, and its token. */
export interface EngineEndpoint {
  projectId: string;
  container: string;
  hostPort: number;
  token: string;
}

interface EndpointRow {
  project_id: string;
  container: string;
  host_port: number;
  token: string;
}

export class EngineEndpointsRepo {
  constructor(private readonly db: Sqlite) {}

  private static map(row: EndpointRow): EngineEndpoint {
    return {
      projectId: row.project_id,
      container: row.container,
      hostPort: row.host_port,
      token: row.token,
    };
  }

  get(projectId: string): EngineEndpoint | undefined {
    const row = this.db
      .prepare("SELECT * FROM engine_endpoints WHERE project_id = ?")
      .get(projectId) as EndpointRow | undefined;
    return row ? EngineEndpointsRepo.map(row) : undefined;
  }

  byContainer(container: string): EngineEndpoint | undefined {
    const row = this.db
      .prepare("SELECT * FROM engine_endpoints WHERE container = ?")
      .get(container) as EndpointRow | undefined;
    return row ? EngineEndpointsRepo.map(row) : undefined;
  }

  list(): EngineEndpoint[] {
    return (
      this.db.prepare("SELECT * FROM engine_endpoints ORDER BY project_id").all() as EndpointRow[]
    ).map(EngineEndpointsRepo.map);
  }

  put(endpoint: EngineEndpoint, now: Date): EngineEndpoint {
    this.db
      .prepare(
        `INSERT INTO engine_endpoints (project_id, container, host_port, token, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET container = excluded.container,
           host_port = excluded.host_port, token = excluded.token, updated_at = excluded.updated_at`,
      )
      .run(
        endpoint.projectId,
        endpoint.container,
        endpoint.hostPort,
        endpoint.token,
        now.toISOString(),
      );
    return endpoint;
  }

  delete(projectId: string): boolean {
    return (
      this.db.prepare("DELETE FROM engine_endpoints WHERE project_id = ?").run(projectId).changes >
      0
    );
  }
}

/** The server's mirror of engine runs. W2 writes it; the core creates it. */
export class RunsRepo {
  constructor(private readonly db: Sqlite) {}

  get(id: string): RunState | undefined {
    const row = this.db.prepare("SELECT data FROM runs WHERE id = ?").get(id) as
      DataRow | undefined;
    return row ? RunStateSchema.parse(JSON.parse(row.data)) : undefined;
  }

  list(filter: { projectId?: string; boxId?: string; status?: string } = {}): RunState[] {
    const w = whereOf([
      ["project_id = ?", filter.projectId],
      ["box_id = ?", filter.boxId],
      ["status = ?", filter.status],
    ]);
    return parseRows(
      this.db.prepare(`SELECT data FROM runs ${w.sql} ORDER BY id`).all(...w.args),
      (v) => RunStateSchema.parse(v),
    );
  }

  put(run: RunState): RunState {
    const r = RunStateSchema.parse(run);
    this.db
      .prepare(
        `INSERT INTO runs (id, project_id, box_id, container, status, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, box_id = excluded.box_id,
           container = excluded.container, status = excluded.status, data = excluded.data,
           updated_at = excluded.updated_at`,
      )
      .run(
        r.id,
        r.projectId,
        r.boxId ?? null,
        r.container,
        r.status,
        JSON.stringify(r),
        r.createdAt,
        r.updatedAt,
      );
    return r;
  }
}

export class FindingsRepo {
  constructor(private readonly db: Sqlite) {}

  list(
    runId: string,
    filter: { verdict?: string; severity?: string; round?: number } = {},
  ): Finding[] {
    const w = whereOf([
      ["run_id = ?", runId],
      ["verdict = ?", filter.verdict],
      ["severity = ?", filter.severity],
      ["round = ?", filter.round],
    ]);
    return parseRows(
      this.db.prepare(`SELECT data FROM findings ${w.sql} ORDER BY finding_id`).all(...w.args),
      (v) => FindingSchema.parse(v),
    );
  }

  get(runId: string, findingId: string): Finding | undefined {
    const row = this.db
      .prepare("SELECT data FROM findings WHERE run_id = ? AND finding_id = ?")
      .get(runId, findingId) as DataRow | undefined;
    return row ? FindingSchema.parse(JSON.parse(row.data)) : undefined;
  }

  put(finding: Finding, now: Date): Finding {
    const f = FindingSchema.parse(finding);
    this.db
      .prepare(
        `INSERT INTO findings (run_id, finding_id, round, verdict, severity, data, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, finding_id) DO UPDATE SET round = excluded.round,
           verdict = excluded.verdict, severity = excluded.severity, data = excluded.data,
           updated_at = excluded.updated_at`,
      )
      .run(f.runId, f.id, f.round, f.verdict, f.severity, JSON.stringify(f), now.toISOString());
    return f;
  }
}

export class UsageSamplesRepo {
  constructor(private readonly db: Sqlite) {}

  add(sample: TimedUsageSample): TimedUsageSample {
    const s = TimedUsageSampleSchema.parse(sample);
    this.db
      .prepare(
        "INSERT INTO usage_samples (vendor, account, window, time, data) VALUES (?, ?, ?, ?, ?)",
      )
      .run(s.vendor, s.account, s.window, s.time, JSON.stringify(s));
    return s;
  }

  list(filter: { vendor?: Vendor; since?: string; until?: string } = {}): TimedUsageSample[] {
    const w = whereOf([
      ["vendor = ?", filter.vendor],
      ["time >= ?", filter.since],
      ["time <= ?", filter.until],
    ]);
    return parseRows(
      this.db.prepare(`SELECT data FROM usage_samples ${w.sql} ORDER BY time, id`).all(...w.args),
      (v) => TimedUsageSampleSchema.parse(v),
    );
  }
}

export class JobsRepo {
  constructor(private readonly db: Sqlite) {}

  get(id: string): Job | undefined {
    const row = this.db.prepare("SELECT data FROM jobs WHERE id = ?").get(id) as
      DataRow | undefined;
    return row ? JobSchema.parse(JSON.parse(row.data)) : undefined;
  }

  list(): Job[] {
    return parseRows(this.db.prepare("SELECT data FROM jobs ORDER BY started_at, id").all(), (v) =>
      JobSchema.parse(v),
    );
  }

  put(job: Job): Job {
    const j = JobSchema.parse(job);
    this.db
      .prepare(
        `INSERT INTO jobs (id, kind, box_id, status, data, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data,
           finished_at = excluded.finished_at`,
      )
      .run(j.id, j.kind, j.boxId, j.status, JSON.stringify(j), j.startedAt, j.finishedAt);
    return j;
  }
}

export interface ImportRow {
  id: number;
  source: string;
  finishedAt: string;
  report: unknown;
}

export class ImportsRepo {
  constructor(private readonly db: Sqlite) {}

  latest(source: string): ImportRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM imports WHERE source = ? ORDER BY id DESC LIMIT 1")
      .get(source) as
      { id: number; source: string; finished_at: string; report: string } | undefined;
    return row
      ? {
          id: row.id,
          source: row.source,
          finishedAt: row.finished_at,
          report: JSON.parse(row.report),
        }
      : undefined;
  }

  add(source: string, report: unknown, now: Date): void {
    this.db
      .prepare("INSERT INTO imports (source, finished_at, report) VALUES (?, ?, ?)")
      .run(source, now.toISOString(), JSON.stringify(report));
  }
}

/** Every repository over one database. */
export interface Repositories {
  sqlite: Sqlite;
  projects: ProjectsRepo;
  boxes: BoxesRepo;
  sshRemotes: SshRemotesRepo;
  settings: SettingsRepo;
  engines: EngineEndpointsRepo;
  runs: RunsRepo;
  findings: FindingsRepo;
  usage: UsageSamplesRepo;
  jobs: JobsRepo;
  imports: ImportsRepo;
  /** Runs `fn` in one transaction. */
  transaction<T>(fn: () => T): T;
  close(): void;
}

export function repositories(sqlite: Sqlite): Repositories {
  return {
    sqlite,
    projects: new ProjectsRepo(sqlite),
    boxes: new BoxesRepo(sqlite),
    sshRemotes: new SshRemotesRepo(sqlite),
    settings: new SettingsRepo(sqlite),
    engines: new EngineEndpointsRepo(sqlite),
    runs: new RunsRepo(sqlite),
    findings: new FindingsRepo(sqlite),
    usage: new UsageSamplesRepo(sqlite),
    jobs: new JobsRepo(sqlite),
    imports: new ImportsRepo(sqlite),
    transaction: <T>(fn: () => T) => sqlite.transaction(fn)(),
    close: () => sqlite.close(),
  };
}
