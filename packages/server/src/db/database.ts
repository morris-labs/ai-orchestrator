// Opens the SQLite database and applies the migrations.
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { MIGRATIONS } from "./migrations.js";

export type Sqlite = Database.Database;

/** Sets `file` to mode 0600 when it exists. */
function tighten(file: string): void {
  try {
    fs.chmodSync(file, 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * Opens (and creates) the database at `file`, or an in-memory database for
 * `":memory:"`, and brings its schema up to date. The database holds engine
 * tokens, so a new directory gets mode 0700, and the database and its
 * `-wal` and `-shm` files get mode 0600 whatever the umask.
 */
export function openDatabase(file: string): Sqlite {
  const onDisk = file !== ":memory:";
  if (onDisk) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(file)) fs.writeFileSync(file, "", { mode: 0o600 });
    tighten(file);
  }
  // SQLite creates the -wal and -shm files on the first write; the umask
  // decides their mode, so it is narrowed while they come into being.
  const umask = onDisk ? process.umask(0o077) : undefined;
  let db: Sqlite;
  try {
    db = new Database(file);
    db.pragma("journal_mode = WAL");
  } finally {
    if (umask !== undefined) process.umask(umask);
  }
  if (onDisk) for (const suffix of ["-wal", "-shm"]) tighten(`${file}${suffix}`);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

/** Applies every migration the database lacks, each in its own transaction. */
export function migrate(db: Sqlite): number {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let i = current; i < MIGRATIONS.length; i += 1) {
    db.transaction(() => {
      const migration = MIGRATIONS[i];
      if (typeof migration === "function") migration(db);
      else db.exec(migration as string);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
  return MIGRATIONS.length;
}
