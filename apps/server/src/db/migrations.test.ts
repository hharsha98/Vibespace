/**
 * Migration-runner tests, run against real SQLite files — always inside a
 * fresh `mkdtempSync` temp directory (`VIBEDECK_DATA_DIR`), same pattern as
 * `workspaces.test.ts` and `board.test.ts`. NEVER the developer's real
 * `~/.vibedeck` — that would be catastrophic for a test suite that
 * deliberately hand-builds broken/outdated database shapes.
 *
 * The regression this whole file exists to prove fixed: `openDatabase()`
 * used to run only `CREATE TABLE IF NOT EXISTS`, which does nothing on an
 * existing database. A database created before `file_claims` grew its
 * `last_heartbeat_at` column stayed missing it forever, and every claim
 * request 500s. See `./migrations.ts`'s top comment for the full story.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./schema.js";
import { MIGRATIONS } from "./migrations.js";

// Mirrors schema.ts's private DB_FILENAME constant — not exported, so
// duplicated here; every test that hand-builds a database file must open
// exactly this filename for `openDatabase()` (which reads `VIBEDECK_DATA_DIR`
// + this same name) to find it.
const DB_FILENAME = "vibedeck.db";

const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/** Every table migration 1 creates, and the columns it should have today —
 * used to assert a fresh database lands at the full current shape. */
const EXPECTED_SCHEMA: Record<string, string[]> = {
  // "color" (Phase 9.5c, migration 5) — see that migration's own comment.
  workspaces: ["id", "name", "root_path", "layout", "color", "created_at", "updated_at"],
  board_cards: [
    "id",
    "workspace_id",
    "title",
    "description",
    "priority",
    "column_id",
    "position",
    "session_id",
    "agent",
    "created_at",
    "updated_at",
    "task_knowledge",
  ],
  missions: ["id", "workspace_id", "prompt", "status", "created_at", "updated_at"],
  mission_agents: [
    "id",
    "mission_id",
    "role",
    "label",
    "agent",
    "session_id",
    "status",
    "created_at",
    "updated_at",
  ],
  mission_messages: ["id", "mission_id", "from_agent_id", "to_agent_id", "body", "created_at"],
  file_claims: ["id", "mission_id", "path", "agent_id", "claimed_at", "last_heartbeat_at"],
  claim_conflicts: ["id", "mission_id", "path", "holder_agent_id", "detected_at"],
  mission_tasks: [
    "id",
    "mission_id",
    "title",
    "prompt",
    "declared_paths",
    "status",
    "assigned_agent_id",
    "review_approved",
    "review_notes",
    "reviewed_by_agent_id",
    "created_at",
    "updated_at",
  ],
  // Phase 9.5b (migration 4): agent records and the saved-prompts library.
  agent_profiles: [
    "id",
    "workspace_id",
    "name",
    "system_prompt",
    "base_agent",
    "created_at",
    "updated_at",
  ],
  saved_prompts: ["id", "workspace_id", "title", "body", "created_at", "updated_at"],
};

function columnsOf(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);
}

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "vibedeck-migrations-test-"));
  process.env.VIBEDECK_DATA_DIR = dataDir;
});

afterEach(() => {
  delete process.env.VIBEDECK_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("migrate() via openDatabase()", () => {
  it("a brand-new database ends at the latest user_version with every expected table and column", () => {
    const db = openDatabase();

    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_VERSION);

    for (const [table, expectedColumns] of Object.entries(EXPECTED_SCHEMA)) {
      expect(columnsOf(db, table).sort()).toEqual([...expectedColumns].sort());
    }

    db.close();
  });

  it("repairs a file_claims table created before last_heartbeat_at existed, backfilling from claimed_at", () => {
    const dbPath = join(dataDir, DB_FILENAME);

    // Hand-build the OLD shape: file_claims without last_heartbeat_at, and
    // user_version left at its default of 0 — exactly what every real
    // database created before this migration system existed looks like
    // (confirmed against the live ~/.vibedeck/vibedeck.db during this fix).
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE file_claims (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL,
        path TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        UNIQUE(mission_id, path)
      )
    `);
    raw
      .prepare(
        `INSERT INTO file_claims (id, mission_id, path, agent_id, claimed_at) VALUES (?, ?, ?, ?, ?)`
      )
      .run("claim-1", "mission-1", "src/a.ts", "agent-1", "2026-01-01T00:00:00.000Z");
    expect(raw.pragma("user_version", { simple: true })).toBe(0); // sanity: below the fix
    raw.close();

    // Open through the normal path — this is what the real server does on
    // every startup, and is what should now repair the table.
    const db = openDatabase();

    expect(columnsOf(db, "file_claims")).toContain("last_heartbeat_at");

    const row = db
      .prepare(`SELECT claimed_at, last_heartbeat_at FROM file_claims WHERE id = ?`)
      .get("claim-1") as { claimed_at: string; last_heartbeat_at: string | null };

    // The bar a broken backfill (e.g. leaving the column merely present but
    // NULL, or blank) must fail: non-null, non-empty, AND equal to the
    // claimed_at it was backfilled from.
    expect(row.last_heartbeat_at).not.toBeNull();
    expect(row.last_heartbeat_at).not.toBe("");
    expect(row.last_heartbeat_at).toBe(row.claimed_at);
    expect(row.last_heartbeat_at).toBe("2026-01-01T00:00:00.000Z");

    db.close();
  });

  it("opening an already-current database applies nothing and leaves user_version unchanged", () => {
    const first = openDatabase();
    expect(first.pragma("user_version", { simple: true })).toBe(LATEST_VERSION);
    first.close();

    const second = openDatabase();
    expect(second.pragma("user_version", { simple: true })).toBe(LATEST_VERSION);
    second.close();
  });

  it("opening the database twice in a row succeeds (idempotence)", () => {
    expect(() => {
      openDatabase().close();
      openDatabase().close();
    }).not.toThrow();
  });

  it("creates a backup file when a migration runs, and not when none does", () => {
    const dbPath = join(dataDir, DB_FILENAME);

    // First open: brand-new database, migrations 1 and 2 are both pending
    // (starting from user_version 0) -> a backup is taken first.
    const first = openDatabase();
    first.close();
    expect(existsSync(`${dbPath}.backup-v0`)).toBe(true);

    // Second open: database is already at LATEST_VERSION, nothing pending
    // -> no backup should be created for that version.
    const second = openDatabase();
    second.close();
    expect(existsSync(`${dbPath}.backup-v${LATEST_VERSION}`)).toBe(false);
  });

  it("existing rows survive a migration run untouched", () => {
    const dbPath = join(dataDir, DB_FILENAME);

    // Hand-build a database with a normal workspaces row already in it,
    // plus an old-shape file_claims table so a real migration (the
    // last_heartbeat_at repair) actually runs alongside it.
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        layout TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    raw
      .prepare(
        `INSERT INTO workspaces (id, name, root_path, layout, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run("ws-1", "vibedeck", "/tmp/vibedeck", null, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    raw.exec(`
      CREATE TABLE file_claims (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL,
        path TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        UNIQUE(mission_id, path)
      )
    `);
    raw.close();

    const db = openDatabase();

    const row = db.prepare(`SELECT * FROM workspaces WHERE id = ?`).get("ws-1");
    expect(row).toEqual({
      id: "ws-1",
      name: "vibedeck",
      root_path: "/tmp/vibedeck",
      layout: null,
      // The hand-built table above predates migration 5 (no "color" column
      // at all) — after openDatabase() repairs it, the pre-existing row
      // must come back with color = NULL, the honest "no colour chosen yet"
      // default for a workspace that predates the column, never an error or
      // a dropped row.
      color: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });

    db.close();
  });
});
