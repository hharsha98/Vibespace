/**
 * SQLite bootstrapping for vibespace's persisted data (currently just
 * workspaces). `better-sqlite3` is synchronous and file-backed — no server
 * process to run, no connection pool, just a `.db` file on disk.
 *
 * The database file lives at `~/.vibespace/vibespace.db` by default, but the
 * *directory* is overridable via `VIBESPACE_DATA_DIR` — every test in this
 * repo MUST set that env var to a fresh `mkdtempSync` temp directory before
 * touching the database, so tests never read or write a developer's real
 * `~/.vibespace`. See `workspaces.test.ts` for the pattern.
 *
 * --- Back-compat with vibedeck (the project's previous name) ---
 * A user upgrading from a vibedeck install has their data sitting at
 * `~/.vibedeck/vibedeck.db`, not `~/.vibespace/vibespace.db` — with no
 * fallback, that upgrade would look like a fresh install with everything
 * gone. `resolveDataDir` (below) is the one-time migration that fixes
 * that: the first time `getDataDir()` runs with neither data-dir env var
 * set and `~/.vibespace` doesn't exist yet, it renames `~/.vibedeck` to
 * `~/.vibespace` in place, then renames the `.db` file inside it too. Both
 * renames are best-effort — see `resolveDataDir`'s own comment for why a
 * failure must never crash the app or lose the user's data.
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { migrate } from "./migrations.js";

const DB_FILENAME = "vibespace.db";
const LEGACY_DB_FILENAME = "vibedeck.db";

/**
 * Pure resolution logic behind `getDataDir()` — takes every path/env value
 * it needs as arguments rather than reading `process.env`/`homedir()`
 * itself, specifically so `data-dir-migration.test.ts` can drive every
 * branch (including the migration and its failure path) against
 * `mkdtempSync` temp directories and never touch a real `~/.vibespace` or
 * `~/.vibedeck`. `getDataDir()` below is just this function called with
 * the real values.
 *
 * Resolution order:
 *   1. `vibespaceDataDir` set -> use it verbatim, no migration. This is an
 *      explicit override (every test in this repo sets it) — there is
 *      nothing to migrate because the caller already told us exactly
 *      where to look.
 *   2. Else `vibedeckDataDir` set -> use it verbatim, no migration. Back-
 *      compat for existing scripts/Docker setups that already export
 *      `VIBEDECK_DATA_DIR`; same reasoning as #1, just the legacy name.
 *   3. Else, `target` (`~/.vibespace`) exists -> use it. Either a fresh
 *      install that's already been through this function once, or a user
 *      who already has vibespace data with nothing to migrate.
 *   4. Else, `legacy` (`~/.vibedeck`) exists -> one-time migration: rename
 *      the whole legacy directory to `target`, then use `target`.
 *   5. Else -> use `target` (a genuinely fresh install; `openDatabase`
 *      creates it).
 *
 * `rename` defaults to the real `renameSync` but is injectable — same
 * "pure function, real dependency defaulted, fake dependency for tests"
 * shape `runtime-config.ts`'s `resolveStaticDir` already uses for its
 * `exists` parameter — specifically because Node's ESM build of `node:fs`
 * doesn't allow `vi.spyOn`ing a named export directly ("Module namespace is
 * not configurable in ESM"), so this is how `data-dir-migration.test.ts`
 * simulates a rename failure (EACCES, EXDEV, ...) without one.
 */
export function resolveDataDir(options: {
  vibespaceDataDir: string | undefined;
  vibedeckDataDir: string | undefined;
  target: string;
  legacy: string;
  rename?: (from: string, to: string) => void;
}): string {
  const { vibespaceDataDir, vibedeckDataDir, target, legacy, rename = renameSync } = options;

  if (vibespaceDataDir) return vibespaceDataDir;
  if (vibedeckDataDir) return vibedeckDataDir;

  if (existsSync(target)) return target;
  if (!existsSync(legacy)) return target; // fresh install — nothing to migrate

  // `renameSync` across a symlinked home, onto a permission-denied target,
  // or into a non-empty existing directory can throw (EXDEV, EACCES/EPERM,
  // ENOTEMPTY) — none of that is this user's fault, and none of it should
  // ever crash the app or leave it looking like their data vanished. On
  // failure, fall back to using the legacy directory IN PLACE: the app
  // still starts, still finds every existing workspace, and simply keeps
  // living at the old path until whatever blocked the rename is fixed.
  try {
    rename(legacy, target);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `vibespace: could not migrate data directory from "${legacy}" to "${target}" (${reason}); ` +
        `continuing to use "${legacy}" so existing data isn't lost.\n`
    );
    return legacy;
  }

  // The directory itself now lives at `target`, but the database file
  // inside it is still named the old way (`vibedeck.db`) — rename that
  // too, best-effort. If THIS rename fails (partial-failure case: the
  // directory move worked but the file move didn't), don't fall back to
  // the legacy directory — `target` genuinely is the right directory now —
  // just leave `vibedeck.db` where it is; `resolveDbFilename` (below) is
  // what makes `openDatabase` still find it there instead of creating a
  // new, empty `vibespace.db` next to it.
  const legacyDbPath = join(target, LEGACY_DB_FILENAME);
  const newDbPath = join(target, DB_FILENAME);
  if (existsSync(legacyDbPath) && !existsSync(newDbPath)) {
    try {
      rename(legacyDbPath, newDbPath);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `vibespace: migrated data directory from "${legacy}" to "${target}" but could not rename ` +
          `"${LEGACY_DB_FILENAME}" to "${DB_FILENAME}" inside it (${reason}); the app will keep using "${LEGACY_DB_FILENAME}".\n`
      );
    }
  }

  return target;
}

/** Where the database file lives. Reads `VIBESPACE_DATA_DIR`/
 * `VIBEDECK_DATA_DIR` fresh on every call (not cached at module load) so
 * tests can set the env var right before opening a database, in any order
 * relative to importing this file. See `resolveDataDir` above for the full
 * resolution order, including the one-time vibedeck -> vibespace
 * migration. */
export function getDataDir(): string {
  return resolveDataDir({
    vibespaceDataDir: process.env.VIBESPACE_DATA_DIR,
    vibedeckDataDir: process.env.VIBEDECK_DATA_DIR,
    target: join(homedir(), ".vibespace"),
    legacy: join(homedir(), ".vibedeck"),
  });
}

/**
 * Which database filename to open inside `dir`. Normally `vibespace.db`,
 * but falls back to the legacy `vibedeck.db` when the new name is absent
 * and the old one is present — this is what keeps the app working when
 * `resolveDataDir`'s directory rename succeeded but its `.db` file rename
 * inside that directory didn't (see that function's partial-failure
 * comment): without this fallback, `openDatabase` would silently create a
 * brand-new, empty `vibespace.db` right next to the user's real data
 * instead of opening it.
 */
export function resolveDbFilename(dir: string): string {
  if (!existsSync(join(dir, DB_FILENAME)) && existsSync(join(dir, LEGACY_DB_FILENAME))) {
    return LEGACY_DB_FILENAME;
  }
  return DB_FILENAME;
}

/**
 * Opens (creating if necessary) the vibespace SQLite database, ensuring the
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

  const dbPath = join(dir, resolveDbFilename(dir));
  const db = new Database(dbPath);
  // WAL (write-ahead logging) lets reads and writes avoid blocking each
  // other and is the recommended mode for better-sqlite3 outside of
  // in-memory/test-only databases; it also survives fine for a single-file,
  // single-process app like this one.
  db.pragma("journal_mode = WAL");

  migrate(db, dbPath);

  return db;
}
