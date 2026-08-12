/**
 * SQLite bootstrapping for vibedeck's persisted data (currently just
 * workspaces). `better-sqlite3` is synchronous and file-backed — no server
 * process to run, no connection pool, just a `.db` file on disk.
 *
 * The database file lives at `~/.vibedeck/vibedeck.db` by default, but the
 * *directory* is overridable via `VIBEDECK_DATA_DIR` — every test in this
 * repo MUST set that env var to a fresh `mkdtempSync` temp directory before
 * touching the database, so tests never read or write a developer's real
 * `~/.vibedeck`. See `workspaces.test.ts` for the pattern.
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { migrate } from "./migrations.js";

/** Where the database file lives. Reads `VIBEDECK_DATA_DIR` fresh on every
 * call (not cached at module load) so tests can set the env var right
 * before opening a database, in any order relative to importing this file. */
export function getDataDir(): string {
  return process.env.VIBEDECK_DATA_DIR ?? join(homedir(), ".vibedeck");
}

const DB_FILENAME = "vibedeck.db";

/**
 * Opens (creating if necessary) the vibedeck SQLite database, ensuring the
 * data directory exists and every table is present *and up to date*. Safe
 * to call more than once — `migrate()` (see `./migrations.ts`) tracks the
 * database's schema version via `PRAGMA user_version` and only applies
 * migrations the database hasn't seen yet, so repeated calls are a no-op
 * once the database is current.
 *
 * The actual `CREATE TABLE` / `ALTER TABLE` statements live in
 * `migrations.ts`, not here — see that file's top comment for why
 * `CREATE TABLE IF NOT EXISTS` alone isn't enough once a table's definition
 * has grown a new column after some databases already exist.
 */
export function openDatabase(): Database.Database {
  const dir = getDataDir();
  mkdirSync(dir, { recursive: true });

  const dbPath = join(dir, DB_FILENAME);
  const db = new Database(dbPath);
  // WAL (write-ahead logging) lets reads and writes avoid blocking each
  // other and is the recommended mode for better-sqlite3 outside of
  // in-memory/test-only databases; it also survives fine for a single-file,
  // single-process app like this one.
  db.pragma("journal_mode = WAL");

  migrate(db, dbPath);

  return db;
}
