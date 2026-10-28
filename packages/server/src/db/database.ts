// Opens the SQLite database and applies the migrations.
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { MIGRATIONS } from "./migrations.js";

export type Sqlite = Database.Database;

/**
 * Opens (and creates) the database at `file`, or an in-memory database for
 * `":memory:"`, and brings its schema up to date. The file is created with
 * mode 0600, because it holds engine tokens.
 */
export function openDatabase(file: string): Sqlite {
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, "", { mode: 0o600 });
  }
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
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
      db.exec(MIGRATIONS[i] as string);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
  return MIGRATIONS.length;
}
