// Typed repositories over the SQLite tables. Each record is stored as a JSON
// document validated by its contract schema on the way in and on the way out,
// with the columns that queries need copied beside it.
import {
  AccountSchema,
  BoxSchema,
  GlobalSettingsInputSchema,
  GlobalSettingsSchema,
  ProjectSchema,
  SshRemoteSchema,
  defaultConfig,
  type Account,
  type Box,
  type GlobalSettings,
  type Project,
  type SshRemote,
} from "@aio/contracts";
import type { Sqlite } from "./database.js";

interface DataRow {
  data: string;
}

/** Reports a stored row that no longer parses, with its table. */
export type BadRowReporter = (table: string, message: string) => void;

/** Logs each distinct bad row once, to the server's log or to stderr. */
function onceReporter(log: (message: string) => void): BadRowReporter {
  const seen = new Set<string>();
  return (table, message) => {
    const line = `Skipped a ${table} record that doesn't parse: ${message}`;
    if (seen.has(line)) return;
    seen.add(line);
    log(line);
  };
}

const defaultReporter = onceReporter((m) => console.error(m));

/**
 * Parses each row's JSON document. A row that fails is skipped and reported,
 * so one bad record doesn't break every listing.
 */
function parseRows<T>(
  rows: unknown[],
  parse: (v: unknown) => T,
  table: string,
  report: BadRowReporter,
): T[] {
  const out: T[] = [];
  for (const r of rows as DataRow[]) {
    let value: unknown;
    try {
      value = JSON.parse(r.data);
      out.push(parse(value));
    } catch (err) {
      const doc = (typeof value === "object" && value !== null ? value : {}) as {
        id?: unknown;
        name?: unknown;
      };
      const id =
        typeof doc.id === "string"
          ? doc.id
          : typeof doc.name === "string"
            ? doc.name
            : "(unknown id)";
      const issue = (err as { issues?: { path: (string | number)[]; message: string }[] })
        .issues?.[0];
      const reason = issue
        ? `${issue.path.join(".") || "(record)"}: ${issue.message}`
        : err instanceof Error
          ? err.message
          : String(err);
      report(table, `${id}: ${reason}`);
    }
  }
  return out;
}

export class ProjectsRepo {
  constructor(
    private readonly db: Sqlite,
    private readonly report: BadRowReporter = defaultReporter,
  ) {}

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
    return parseRows(
      this.db.prepare("SELECT data FROM projects ORDER BY id").all(),
      (v) => ProjectSchema.parse(v),
      "project",
      this.report,
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
  constructor(
    private readonly db: Sqlite,
    private readonly report: BadRowReporter = defaultReporter,
  ) {}

  get(id: string): Box | undefined {
    const row = this.db.prepare("SELECT data FROM boxes WHERE id = ?").get(id) as
      DataRow | undefined;
    return row ? BoxSchema.parse(JSON.parse(row.data)) : undefined;
  }

  /**
   * Every stored box id, read without parsing the records, so a record that
   * `list()` skips still holds its name.
   */
  ids(): string[] {
    return (this.db.prepare("SELECT id FROM boxes ORDER BY id").all() as { id: string }[]).map(
      (r) => r.id,
    );
  }

  /** Every box, ordered by id (the 3.3.5 `known/` directory order). */
  list(): Box[] {
    return parseRows(
      this.db.prepare("SELECT data FROM boxes ORDER BY id").all(),
      (v) => BoxSchema.parse(v),
      "box",
      this.report,
    );
  }

  byProject(projectId: string): Box[] {
    return parseRows(
      this.db.prepare("SELECT data FROM boxes WHERE project_id = ? ORDER BY id").all(projectId),
      (v) => BoxSchema.parse(v),
      "box",
      this.report,
    );
  }

  bySession(sessionUuid: string): Box[] {
    return parseRows(
      this.db.prepare("SELECT data FROM boxes WHERE session_uuid = ? ORDER BY id").all(sessionUuid),
      (v) => BoxSchema.parse(v),
      "box",
      this.report,
    );
  }

  byTargetDir(targetDir: string): Box[] {
    return parseRows(
      this.db.prepare("SELECT data FROM boxes WHERE target_dir = ? ORDER BY id").all(targetDir),
      (v) => BoxSchema.parse(v),
      "box",
      this.report,
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
  constructor(
    private readonly db: Sqlite,
    private readonly report: BadRowReporter = defaultReporter,
  ) {}

  get(name: string): SshRemote | undefined {
    const row = this.db.prepare("SELECT data FROM ssh_remotes WHERE name = ?").get(name) as
      DataRow | undefined;
    return row ? SshRemoteSchema.parse(JSON.parse(row.data)) : undefined;
  }

  list(): SshRemote[] {
    return parseRows(
      this.db.prepare("SELECT data FROM ssh_remotes ORDER BY name").all(),
      (v) => SshRemoteSchema.parse(v),
      "SSH remote",
      this.report,
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

  /**
   * The stored settings, or the defaults when none were saved. The input
   * schema fills fields that a later contract added, such as `vendorDefaults`.
   */
  get(): GlobalSettings {
    const row = this.db.prepare("SELECT data FROM settings WHERE id = 1").get() as
      DataRow | undefined;
    return row ? GlobalSettingsInputSchema.parse(JSON.parse(row.data)) : defaultConfig();
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

export class AccountsRepo {
  constructor(
    private readonly db: Sqlite,
    private readonly report: BadRowReporter = defaultReporter,
  ) {}

  get(id: string): Account | undefined {
    const row = this.db.prepare("SELECT data FROM accounts WHERE id = ?").get(id) as
      DataRow | undefined;
    return row ? AccountSchema.parse(JSON.parse(row.data)) : undefined;
  }

  /** Every account, ordered by vendor, then name. */
  list(): Account[] {
    return parseRows(
      this.db.prepare("SELECT data FROM accounts ORDER BY vendor, name").all(),
      (v) => AccountSchema.parse(v),
      "account",
      this.report,
    );
  }

  /** Inserts or replaces an account. */
  put(account: Account): Account {
    const a = AccountSchema.parse(account);
    this.db
      .prepare(
        `INSERT INTO accounts (id, vendor, name, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(a.id, a.vendor, a.name, JSON.stringify(a), a.createdAt, a.updatedAt);
    return a;
  }

  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM accounts WHERE id = ?").run(id).changes > 0;
  }
}

/**
 * A project container's engine: the loopback port that maps to 20411, and its
 * token. `brokerPort` is the loopback port of the container's TCP secrets
 * broker; absent when the container uses the Unix socket.
 */
export interface EngineEndpoint {
  projectId: string;
  container: string;
  hostPort: number;
  token: string;
  brokerPort?: number;
}

interface EndpointRow {
  project_id: string;
  container: string;
  host_port: number;
  token: string;
  broker_port?: number | null;
}

export class EngineEndpointsRepo {
  constructor(private readonly db: Sqlite) {}

  private static map(row: EndpointRow): EngineEndpoint {
    return {
      projectId: row.project_id,
      container: row.container,
      hostPort: row.host_port,
      token: row.token,
      ...(typeof row.broker_port === "number" ? { brokerPort: row.broker_port } : {}),
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
        `INSERT INTO engine_endpoints (project_id, container, host_port, token, updated_at, broker_port)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET container = excluded.container,
           host_port = excluded.host_port, token = excluded.token, updated_at = excluded.updated_at,
           broker_port = excluded.broker_port`,
      )
      .run(
        endpoint.projectId,
        endpoint.container,
        endpoint.hostPort,
        endpoint.token,
        now.toISOString(),
        endpoint.brokerPort ?? null,
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
  imports: ImportsRepo;
  accounts: AccountsRepo;
  /** Runs `fn` in one transaction. */
  transaction<T>(fn: () => T): T;
  close(): void;
}

/**
 * Builds the repositories. `log` gets each record that a listing skips
 * because it no longer parses, once; the default is stderr.
 */
export function repositories(
  sqlite: Sqlite,
  options: { log?: (message: string) => void } = {},
): Repositories {
  const report = options.log ? onceReporter(options.log) : defaultReporter;
  return {
    sqlite,
    projects: new ProjectsRepo(sqlite, report),
    boxes: new BoxesRepo(sqlite, report),
    sshRemotes: new SshRemotesRepo(sqlite, report),
    settings: new SettingsRepo(sqlite),
    engines: new EngineEndpointsRepo(sqlite),
    imports: new ImportsRepo(sqlite),
    accounts: new AccountsRepo(sqlite, report),
    transaction: <T>(fn: () => T) => sqlite.transaction(fn)(),
    close: () => sqlite.close(),
  };
}
