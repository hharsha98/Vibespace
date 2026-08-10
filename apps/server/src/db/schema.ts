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

/** Where the database file lives. Reads `VIBEDECK_DATA_DIR` fresh on every
 * call (not cached at module load) so tests can set the env var right
 * before opening a database, in any order relative to importing this file. */
export function getDataDir(): string {
  return process.env.VIBEDECK_DATA_DIR ?? join(homedir(), ".vibedeck");
}

const DB_FILENAME = "vibedeck.db";

/**
 * Opens (creating if necessary) the vibedeck SQLite database, ensuring the
 * data directory exists and the `workspaces` table is present. Safe to call
 * more than once — `CREATE TABLE IF NOT EXISTS` makes table creation
 * idempotent, and each call opens its own `Database` handle.
 */
export function openDatabase(): Database.Database {
  const dir = getDataDir();
  mkdirSync(dir, { recursive: true });

  const db = new Database(join(dir, DB_FILENAME));
  // WAL (write-ahead logging) lets reads and writes avoid blocking each
  // other and is the recommended mode for better-sqlite3 outside of
  // in-memory/test-only databases; it also survives fine for a single-file,
  // single-process app like this one.
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL,
      layout TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  return db;
}
