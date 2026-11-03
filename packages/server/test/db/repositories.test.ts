import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { defaultConfig, type Box, type Project } from "@aio/contracts";
import { MIGRATIONS, migrate, openDatabase, repositories } from "../../src/db/index.js";
import { tempDir } from "../tmp.js";

const T = "2026-10-28T09:00:00.000Z";

function project(id = "app-12345678", root = "/work/app"): Project {
  return {
    id,
    root,
    name: "app",
    tcpMaps: [],
    mounts: [],
    secretRefs: [],
    policyPath: ".aio/policy.yaml",
    createdAt: T,
    updatedAt: T,
  };
}

function box(id: string, overrides: Partial<Box> = {}): Box {
  return {
    id,
    projectId: "app-12345678",
    hostKey: id.replace("aio-agent-", ""),
    targetDir: "/work/app",
    sessionUuid: null,
    conversationName: "",
    transcriptSyncedName: "",
    platform: "claude",
    skipPermissions: true,
    container: "aio-agent-proj-app-12345678",
    session: id,
    wasRunning: false,
    sshRemoteRefs: [],
    createdAt: T,
    updatedAt: T,
    ...overrides,
  };
}

describe("openDatabase", () => {
  it("creates the file with mode 0600 and applies every migration once", () => {
    const dir = tempDir("aio-db-");
    const file = path.join(dir, "sub", "aio.db");
    const db = openDatabase(file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    expect(migrate(db)).toBe(MIGRATIONS.length);
    db.close();
    const again = openDatabase(file);
    expect(again.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    again.close();
  });
});

describe("database file modes", () => {
  it("keeps the directory, the database, and its WAL files private under a loose umask", () => {
    const dir = tempDir("aio-db-");
    const file = path.join(dir, "data", "aio.db");
    const old = process.umask(0o022);
    try {
      const db = openDatabase(file);
      repositories(db).projects.put(project());
      expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
      for (const f of [file, `${file}-wal`, `${file}-shm`]) {
        expect(fs.statSync(f).mode & 0o777).toBe(0o600);
      }
      db.close();
      // A file left readable by an older version is tightened on open.
      fs.chmodSync(file, 0o644);
      openDatabase(file).close();
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(old);
    }
  });
});

describe("migration 3", () => {
  it("drops the unused first-draft tables and creates the service tables", () => {
    const db = new Database(":memory:");
    db.exec(MIGRATIONS[0] as string);
    db.pragma("user_version = 2");
    migrate(db);
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((t) => t.name);
    for (const gone of ["runs", "findings", "usage_samples", "jobs"]) {
      expect(tables).not.toContain(gone);
    }
    for (const svc of [
      "svc_events",
      "svc_event_meta",
      "svc_engine_cursors",
      "svc_runs",
      "svc_findings",
      "svc_notifications",
      "svc_usage_samples",
      "svc_lease_settlements",
    ]) {
      expect(tables).toContain(svc);
    }
  });
});

describe("migration 2", () => {
  it("re-keys host keys that two projects share and then refuses a duplicate", () => {
    const db = new Database(":memory:");
    db.exec(MIGRATIONS[0] as string);
    db.pragma("user_version = 1");
    const r = repositories(db);
    r.projects.put(project());
    r.projects.put(project("api-87654321", "/work/api"));
    r.boxes.put(box("aio-agent-api.v2", { hostKey: "api-v2" }));
    r.boxes.put(
      box("aio-agent-api-v2", {
        hostKey: "api-v2",
        projectId: "api-87654321",
        targetDir: "/work/api",
        createdAt: "2026-10-29T09:00:00.000Z",
      }),
    );
    migrate(db);
    expect(r.boxes.get("aio-agent-api.v2")?.hostKey).toBe("api-v2");
    expect(r.boxes.get("aio-agent-api-v2")?.hostKey).toBe("api-v2-2");
    expect(
      (
        db.prepare("SELECT host_key FROM boxes WHERE id = ?").get("aio-agent-api-v2") as {
          host_key: string;
        }
      ).host_key,
    ).toBe("api-v2-2");
    expect(() =>
      r.boxes.put(
        box("aio-agent-other", {
          hostKey: "api-v2",
          projectId: "api-87654321",
          targetDir: "/work/api",
        }),
      ),
    ).toThrow(/UNIQUE/);
  });

  it("never gives a replacement key that a later box in the project holds", () => {
    const db = new Database(":memory:");
    db.exec(MIGRATIONS[0] as string);
    db.pragma("user_version = 1");
    const r = repositories(db);
    r.projects.put(project());
    r.projects.put(project("api-87654321", "/work/api"));
    const inApi = { projectId: "api-87654321", targetDir: "/work/api" };
    r.boxes.put(box("aio-agent-api.v2", { hostKey: "api-v2" }));
    r.boxes.put(
      box("aio-agent-api-v2", {
        ...inApi,
        hostKey: "api-v2",
        createdAt: "2026-10-29T09:00:00.000Z",
      }),
    );
    r.boxes.put(
      box("aio-agent-later", {
        ...inApi,
        hostKey: "api-v2-2",
        createdAt: "2026-10-30T09:00:00.000Z",
      }),
    );
    migrate(db);
    expect(r.boxes.get("aio-agent-api-v2")?.hostKey).toBe("api-v2-3");
    expect(r.boxes.get("aio-agent-later")?.hostKey).toBe("api-v2-2");
  });
});

describe("migrations 5 to 7", () => {
  /** A database at `version`, built from the first `version` migrations. */
  function databaseAt(version: number): Database.Database {
    const db = new Database(":memory:");
    for (const m of MIGRATIONS.slice(0, version)) {
      if (typeof m === "function") m(db);
      else db.exec(m as string);
    }
    db.pragma(`user_version = ${version}`);
    return db;
  }

  function schemaNames(db: Database.Database, type: "table" | "index"): string[] {
    return (
      db.prepare("SELECT name FROM sqlite_master WHERE type = ?").all(type) as { name: string }[]
    ).map((row) => row.name);
  }

  function engineColumns(db: Database.Database): string[] {
    return (db.prepare("PRAGMA table_info(engine_endpoints)").all() as { name: string }[]).map(
      (c) => c.name,
    );
  }

  it("keeps the usage index at 5, the broker port at 6, and the machines at 7", () => {
    expect(MIGRATIONS).toHaveLength(8);
    expect(MIGRATIONS[4]).toContain("svc_usage_samples_account");
    const six = databaseAt(6);
    expect(engineColumns(six)).toContain("broker_port");
    expect(schemaNames(six, "table")).not.toContain("machines");
    expect(schemaNames(databaseAt(7), "table")).toEqual(
      expect.arrayContaining(["machines", "enrollment_codes"]),
    );
  });

  it("adds the GUI clients at 8 and keeps the enrolled machines", () => {
    const db = databaseAt(7);
    db.prepare(
      "INSERT INTO machines (id, name, role, cert_fingerprint, capabilities, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("m1", "node-one", "node", "AA:BB", "[]", "2026-01-01", "2026-01-01");
    expect(schemaNames(db, "table")).not.toContain("gui_clients");

    expect(migrate(db)).toBe(MIGRATIONS.length);

    expect(schemaNames(db, "table")).toEqual(
      expect.arrayContaining(["gui_clients", "gui_enrollment_codes"]),
    );
    expect(db.prepare("SELECT id FROM machines").all()).toEqual([{ id: "m1" }]);
  });

  it("brings a version 5 database from main to version 7 and keeps its rows", () => {
    const db = databaseAt(5);
    expect(schemaNames(db, "index")).toContain("svc_usage_samples_account");
    expect(engineColumns(db)).not.toContain("broker_port");
    expect(schemaNames(db, "table")).not.toContain("machines");
    db.prepare(
      "INSERT INTO accounts (id, vendor, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("claude/work", "claude", "work", "{}", "2026-01-01", "2026-01-01");

    expect(migrate(db)).toBe(MIGRATIONS.length);

    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    expect(schemaNames(db, "index")).toContain("svc_usage_samples_account");
    expect(engineColumns(db)).toContain("broker_port");
    expect(schemaNames(db, "table")).toEqual(
      expect.arrayContaining(["machines", "enrollment_codes"]),
    );
    expect(db.prepare("SELECT id FROM accounts").all()).toEqual([{ id: "claude/work" }]);
  });

  describe("a database from a multi-host build before the merge with main", () => {
    const BROKER_PORT = "ALTER TABLE engine_endpoints ADD COLUMN broker_port INTEGER";
    // Migration 7's tables, as those builds created them.
    const MACHINES = `
      CREATE TABLE machines (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        cert_fingerprint TEXT NOT NULL UNIQUE,
        revoked_at TEXT,
        server_version TEXT,
        protocol INTEGER,
        capabilities TEXT NOT NULL DEFAULT '[]',
        platform TEXT,
        last_seen TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX machines_live_name ON machines (name) WHERE revoked_at IS NULL;
      CREATE TABLE enrollment_codes (
        code_key TEXT PRIMARY KEY,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL
      );
    `;

    /** A database at `version` that ran `steps` after the first four migrations. */
    function legacyDatabase(version: number, steps: string[]): Database.Database {
      const db = databaseAt(4);
      for (const step of steps) db.exec(step);
      db.pragma(`user_version = ${version}`);
      return db;
    }

    function expectFullSchema(db: Database.Database): void {
      expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
      expect(schemaNames(db, "index")).toEqual(
        expect.arrayContaining(["svc_usage_samples_account", "machines_live_name"]),
      );
      expect(engineColumns(db)).toContain("broker_port");
      expect(schemaNames(db, "table")).toEqual(
        expect.arrayContaining(["machines", "enrollment_codes"]),
      );
    }

    it("upgrades version 6 with the broker port and the machines, and keeps the rows", () => {
      const db = legacyDatabase(6, [BROKER_PORT, MACHINES]);
      db.prepare(
        "INSERT INTO machines (id, name, role, cert_fingerprint, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("m1", "node-a", "node", "fp", "2026-01-01", "2026-01-01");

      expect(migrate(db)).toBe(MIGRATIONS.length);

      expectFullSchema(db);
      expect(db.prepare("SELECT id FROM machines").all()).toEqual([{ id: "m1" }]);
    });

    it("upgrades version 5 with only the broker port, and keeps the port", () => {
      const db = legacyDatabase(5, [BROKER_PORT]);
      db.prepare(
        "INSERT INTO projects (id, root, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run("p1", "/srv/project", "{}", "2026-01-01", "2026-01-01");
      db.prepare(
        "INSERT INTO engine_endpoints (project_id, container, host_port, token, updated_at, broker_port) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("p1", "aio-agent-p1", 40001, "test-token", "2026-01-01", 40002);

      expect(migrate(db)).toBe(MIGRATIONS.length);

      expectFullSchema(db);
      expect(db.prepare("SELECT broker_port FROM engine_endpoints").all()).toEqual([
        { broker_port: 40002 },
      ]);
    });

    it("upgrades version 5 with only the machines", () => {
      const db = legacyDatabase(5, [MACHINES]);

      expect(migrate(db)).toBe(MIGRATIONS.length);

      expectFullSchema(db);
    });
  });

  it("brings a version 4 database through all three changes", () => {
    const db = databaseAt(4);
    expect(schemaNames(db, "index")).not.toContain("svc_usage_samples_account");

    expect(migrate(db)).toBe(MIGRATIONS.length);

    expect(schemaNames(db, "index")).toContain("svc_usage_samples_account");
    expect(engineColumns(db)).toContain("broker_port");
    expect(schemaNames(db, "table")).toEqual(
      expect.arrayContaining(["machines", "enrollment_codes"]),
    );
  });
});

describe("migrate", () => {
  it("refuses a database from a newer server", () => {
    const db = new Database(":memory:");
    db.pragma("user_version = 99");
    expect(() => migrate(db)).toThrow(/schema version 99, newer than this server's/);
  });
});

describe("repositories", () => {
  it("skips and reports, once, a record that no longer parses", () => {
    const db = openDatabase(":memory:");
    const logged: string[] = [];
    const r = repositories(db, { log: (m) => logged.push(m) });
    r.projects.put(project());
    r.boxes.put(box("aio-agent-good"));
    r.boxes.put(box("aio-agent-bad"));
    const bad = { ...box("aio-agent-bad"), platform: "SYNTHETIC" };
    db.prepare("UPDATE boxes SET data = ? WHERE id = ?").run(JSON.stringify(bad), "aio-agent-bad");
    expect(r.boxes.list().map((b) => b.id)).toEqual(["aio-agent-good"]);
    expect(r.boxes.byProject("app-12345678").map((b) => b.id)).toEqual(["aio-agent-good"]);
    expect(r.boxes.ids()).toEqual(["aio-agent-bad", "aio-agent-good"]);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/^Skipped a box record that doesn't parse: aio-agent-bad: platform/);
  });

  it("round-trips projects and finds them by root", () => {
    const r = repositories(openDatabase(":memory:"));
    r.projects.put(project());
    expect(r.projects.get("app-12345678")).toEqual(project());
    expect(r.projects.byRoot("/work/app")?.id).toBe("app-12345678");
    expect(r.projects.list()).toHaveLength(1);
    expect(r.projects.delete("app-12345678")).toBe(true);
    expect(r.projects.get("app-12345678")).toBeUndefined();
  });

  it("refuses an invalid record", () => {
    const r = repositories(openDatabase(":memory:"));
    expect(() => r.projects.put({ ...project(), id: "bad id" })).toThrow();
  });

  it("indexes boxes by project, session, and directory and enforces host keys", () => {
    const r = repositories(openDatabase(":memory:"));
    r.projects.put(project());
    const uuid = "6f1c3a52-6d8b-4f43-9a51-2d5b7cbd3f10";
    r.boxes.put(box("aio-agent-a", { sessionUuid: uuid }));
    r.boxes.put(box("aio-agent-b", { targetDir: "/work/other" }));
    expect(r.boxes.byProject("app-12345678").map((b) => b.id)).toEqual([
      "aio-agent-a",
      "aio-agent-b",
    ]);
    expect(r.boxes.bySession(uuid).map((b) => b.id)).toEqual(["aio-agent-a"]);
    expect(r.boxes.byTargetDir("/work/other").map((b) => b.id)).toEqual(["aio-agent-b"]);
    expect(() => r.boxes.put(box("aio-agent-c", { hostKey: "a" }))).toThrow(/UNIQUE/);
    r.boxes.put(box("aio-agent-a", { conversationName: "renamed" }));
    expect(r.boxes.get("aio-agent-a")?.conversationName).toBe("renamed");
    expect(r.boxes.delete("aio-agent-a")).toBe(true);
  });

  it("refuses a box whose project does not exist", () => {
    const r = repositories(openDatabase(":memory:"));
    expect(() => r.boxes.put(box("aio-agent-a"))).toThrow(/FOREIGN KEY/);
  });

  it("returns default settings until some are saved", () => {
    const r = repositories(openDatabase(":memory:"));
    expect(r.settings.exists()).toBe(false);
    expect(r.settings.get()).toEqual(defaultConfig());
    r.settings.put({ ...defaultConfig(), setupCompleted: true }, new Date(T));
    expect(r.settings.exists()).toBe(true);
    expect(r.settings.get().setupCompleted).toBe(true);
    expect(() =>
      r.settings.put({ ...defaultConfig(), unknown: 1 } as never, new Date(T)),
    ).toThrow();
  });

  it("keeps engine endpoints unique per port", () => {
    const r = repositories(openDatabase(":memory:"));
    r.projects.put(project());
    r.projects.put(project("other-87654321", "/work/other"));
    const e = {
      projectId: "app-12345678",
      container: "aio-agent-proj-app-12345678",
      hostPort: 41000,
      token: "t".repeat(64),
    };
    r.engines.put(e, new Date(T));
    expect(r.engines.get("app-12345678")).toEqual(e);
    expect(r.engines.byContainer(e.container)).toEqual(e);
    expect(() =>
      r.engines.put(
        { ...e, projectId: "other-87654321", container: "aio-agent-proj-other-87654321" },
        new Date(T),
      ),
    ).toThrow(/UNIQUE/);
    r.projects.delete("other-87654321");
    expect(r.engines.list()).toHaveLength(1);
  });

  it("stores ssh remotes and imports", () => {
    const r = repositories(openDatabase(":memory:"));
    r.sshRemotes.put({ name: "lab", host: "dev@203.0.113.5", forwards: [] });
    expect(r.sshRemotes.list().map((x) => x.name)).toEqual(["lab"]);
    r.imports.add("claude-box-3", { ok: true }, new Date(T));
    expect(r.imports.latest("claude-box-3")?.report).toEqual({ ok: true });
  });

  it("runs work in one transaction", () => {
    const r = repositories(openDatabase(":memory:"));
    expect(() =>
      r.transaction(() => {
        r.projects.put(project());
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(r.projects.list()).toEqual([]);
  });
});

describe("engine endpoints broker port", () => {
  it("stores the TCP broker's port and leaves it out for the Unix socket", () => {
    const r = repositories(openDatabase(":memory:"));
    r.projects.put(project());
    const base = {
      projectId: "app-12345678",
      container: "aio-agent-proj-app-12345678",
      hostPort: 41000,
      token: "a".repeat(64),
    };
    r.engines.put(base, new Date(T));
    expect(r.engines.get(base.projectId)).toEqual(base);
    expect(r.engines.get(base.projectId)).not.toHaveProperty("brokerPort");
    r.engines.put({ ...base, brokerPort: 41500 }, new Date(T));
    expect(r.engines.get(base.projectId)).toEqual({ ...base, brokerPort: 41500 });
    r.engines.put(base, new Date(T));
    expect(r.engines.list()).toEqual([base]);
  });
});
