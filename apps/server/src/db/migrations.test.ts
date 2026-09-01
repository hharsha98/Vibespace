/**
 * Migration-runner tests, run against real SQLite files — always inside a
 * fresh `mkdtempSync` temp directory (`VIBESPACE_DATA_DIR`), same pattern as
 * `workspaces.test.ts` and `board.test.ts`. NEVER the developer's real
 * `~/.vibespace` — that would be catastrophic for a test suite that
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
// exactly this filename for `openDatabase()` (which reads `VIBESPACE_DATA_DIR`
// + this same name) to find it.
const DB_FILENAME = "vibespace.db";

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
  // BridgeSpace parity item 4 (migration 6): per-workspace command history.
  command_history: ["id", "workspace_id", "command", "created_at"],
  // SSH connection profiles (migration 7).
  ssh_profiles: [
    "id",
    "name",
    "host",
    "user",
    "port",
    "default_directory",
    "startup_command",
    "created_at",
    "updated_at",
  ],
  // Session recovery / deferred restore (migration 8).
  session_records: [
    "id",
    "workspace_id",
    "pane_id",
    "session_id",
    "agent",
    "ssh_profile_id",
    "agent_session_ref",
    "cwd",
    "title",
    "status",
    "started_at",
    "ended_at",
    "ended_reason",
    "exit_code",
    "created_at",
    "updated_at",
  ],
};

function columnsOf(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);
}

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "vibespace-migrations-test-"));
  process.env.VIBESPACE_DATA_DIR = dataDir;
});

afterEach(() => {
  delete process.env.VIBESPACE_DATA_DIR;
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
    // (confirmed against the live ~/.vibespace/vibespace.db during this fix).
    //
    // Also hand-build a real workspaces row and the missions row claim-1
    // actually belongs to: migration 9 (added after this test was written —
    // see its own doc comment) deletes file_claims rows whose mission_id
    // doesn't resolve to a live mission, and deletes missions rows whose
    // workspace_id doesn't resolve to a live workspace. Without these two
    // rows, claim-1 would be swept away as an orphan before this test ever
    // gets to check the last_heartbeat_at backfill — a false failure
    // unrelated to what this test is actually about.
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        layout TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE missions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
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
        `INSERT INTO workspaces (id, name, root_path, layout, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)`
      )
      .run("ws-1", "vibespace", "/tmp/vibespace", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    raw
      .prepare(
        `INSERT INTO missions (id, workspace_id, prompt, status, created_at, updated_at) VALUES (?, ?, 'do it', 'running', ?, ?)`
      )
      .run("mission-1", "ws-1", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
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
      .run("ws-1", "vibespace", "/tmp/vibespace", null, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
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
      name: "vibespace",
      root_path: "/tmp/vibespace",
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

/**
 * Migration 9 tests: sweeping rows orphaned by workspace deletions that ran
 * BEFORE `WorkspaceStore.remove()` learned to cascade (see migration 9's own
 * doc comment in `migrations.ts`, and `workspaces.ts`'s `remove()`). These
 * tests hand-build a database at exactly the version-8 shape — every table
 * migration 8 leaves behind, with rows deliberately left dangling by
 * simulating the old one-statement `remove()` (a "dead" workspace/mission id
 * that simply has no matching row, exactly what the old bug produced) — then
 * run `migrate()` (via `openDatabase()`) and check the sweep.
 */
describe("migrate() via openDatabase() — migration 9 (delete orphaned workspace-scoped rows)", () => {
  const LIVE_WS = "ws-live";
  const DEAD_WS = "ws-dead"; // never inserted into `workspaces` — simulates an already-deleted workspace.
  const LIVE_MISSION = "mission-live";
  const DEAD_MISSION = "mission-dead"; // belongs to DEAD_WS; never inserted into `missions`, either.

  /** Hand-builds a database at the exact version-8 schema shape (every
   * column migration 1 through migration 8 leave behind — the same shape
   * `EXPECTED_SCHEMA` above asserts a fresh database lands at, minus
   * migration 9, which adds no columns) and seeds it with deliberately
   * orphaned rows alongside rows that must survive. Sets `user_version = 8`
   * directly so `openDatabase()` sees only migration 9 as pending. */
  function buildVersion8DatabaseWithOrphans(dbPath: string): void {
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL,
        layout TEXT, color TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE board_cards (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT NOT NULL,
        description TEXT, priority TEXT NOT NULL, column_id TEXT NOT NULL,
        position REAL NOT NULL, session_id TEXT, agent TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, task_knowledge TEXT
      );
      CREATE TABLE missions (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, prompt TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE mission_agents (
        id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, role TEXT NOT NULL,
        label TEXT NOT NULL, agent TEXT NOT NULL, session_id TEXT,
        status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE mission_messages (
        id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, from_agent_id TEXT,
        to_agent_id TEXT, body TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE file_claims (
        id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, path TEXT NOT NULL,
        agent_id TEXT NOT NULL, claimed_at TEXT NOT NULL, last_heartbeat_at TEXT NOT NULL,
        UNIQUE(mission_id, path)
      );
      CREATE TABLE claim_conflicts (
        id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, path TEXT NOT NULL,
        holder_agent_id TEXT NOT NULL, detected_at TEXT NOT NULL
      );
      CREATE TABLE mission_tasks (
        id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, title TEXT NOT NULL,
        prompt TEXT NOT NULL, declared_paths TEXT NOT NULL, status TEXT NOT NULL,
        assigned_agent_id TEXT, review_approved INTEGER, review_notes TEXT,
        reviewed_by_agent_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      -- workspace_id is NOT NULL here (migration 4) — no global/NULL case,
      -- unlike saved_prompts/session_records below.
      CREATE TABLE agent_profiles (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL,
        system_prompt TEXT NOT NULL, base_agent TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE saved_prompts (
        id TEXT PRIMARY KEY, workspace_id TEXT, title TEXT NOT NULL,
        body TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE command_history (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, command TEXT NOT NULL,
        created_at TEXT NOT NULL, UNIQUE(workspace_id, command)
      );
      CREATE TABLE ssh_profiles (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL, user TEXT,
        port INTEGER, default_directory TEXT, startup_command TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(name)
      );
      CREATE TABLE session_records (
        id TEXT PRIMARY KEY, workspace_id TEXT, pane_id TEXT, session_id TEXT,
        agent TEXT NOT NULL, ssh_profile_id TEXT, agent_session_ref TEXT,
        cwd TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
        started_at TEXT NOT NULL, ended_at TEXT, ended_reason TEXT,
        exit_code INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);

    const now = "2026-01-01T00:00:00.000Z";

    // Only the LIVE workspace and LIVE mission actually exist as rows —
    // DEAD_WS/DEAD_MISSION are referenced by id only, exactly what the old
    // one-statement `remove()` left behind after deleting a workspace row
    // and nothing else.
    raw
      .prepare(
        `INSERT INTO workspaces (id, name, root_path, layout, color, created_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?, ?)`
      )
      .run(LIVE_WS, "live", "/tmp/live", now, now);
    raw
      .prepare(
        `INSERT INTO missions (id, workspace_id, prompt, status, created_at, updated_at) VALUES (?, ?, 'do it', 'running', ?, ?)`
      )
      .run(LIVE_MISSION, LIVE_WS, now, now);

    // --- Direct tables: one row for the live workspace, one orphaned. ---
    raw
      .prepare(
        `INSERT INTO board_cards (id, workspace_id, title, priority, column_id, position, created_at, updated_at) VALUES (?, ?, 't', 'normal', 'todo', 1.0, ?, ?)`
      )
      .run("card-live", LIVE_WS, now, now);
    raw
      .prepare(
        `INSERT INTO board_cards (id, workspace_id, title, priority, column_id, position, created_at, updated_at) VALUES (?, ?, 't', 'normal', 'todo', 1.0, ?, ?)`
      )
      .run("card-orphan", DEAD_WS, now, now);

    raw
      .prepare(
        `INSERT INTO agent_profiles (id, workspace_id, name, system_prompt, base_agent, created_at, updated_at) VALUES (?, ?, 'p', 'be helpful', 'claude', ?, ?)`
      )
      .run("profile-live", LIVE_WS, now, now);
    raw
      .prepare(
        `INSERT INTO agent_profiles (id, workspace_id, name, system_prompt, base_agent, created_at, updated_at) VALUES (?, ?, 'p', 'be helpful', 'claude', ?, ?)`
      )
      .run("profile-orphan", DEAD_WS, now, now);

    raw
      .prepare(
        `INSERT INTO saved_prompts (id, workspace_id, title, body, created_at, updated_at) VALUES (?, ?, 't', 'b', ?, ?)`
      )
      .run("prompt-live", LIVE_WS, now, now);
    raw
      .prepare(
        `INSERT INTO saved_prompts (id, workspace_id, title, body, created_at, updated_at) VALUES (?, ?, 't', 'b', ?, ?)`
      )
      .run("prompt-orphan", DEAD_WS, now, now);
    raw
      .prepare(
        `INSERT INTO saved_prompts (id, workspace_id, title, body, created_at, updated_at) VALUES (?, NULL, 't', 'b', ?, ?)`
      )
      .run("prompt-global", now, now);

    raw
      .prepare(
        `INSERT INTO command_history (id, workspace_id, command, created_at) VALUES (?, ?, 'ls', ?)`
      )
      .run("cmd-live", LIVE_WS, now);
    raw
      .prepare(
        `INSERT INTO command_history (id, workspace_id, command, created_at) VALUES (?, ?, 'ls', ?)`
      )
      .run("cmd-orphan", DEAD_WS, now);

    raw
      .prepare(
        `INSERT INTO session_records (id, workspace_id, agent, cwd, title, status, started_at, created_at, updated_at) VALUES (?, ?, 'claude', '/tmp', 't', 'recoverable', ?, ?, ?)`
      )
      .run("session-live", LIVE_WS, now, now, now);
    raw
      .prepare(
        `INSERT INTO session_records (id, workspace_id, agent, cwd, title, status, started_at, created_at, updated_at) VALUES (?, ?, 'claude', '/tmp', 't', 'recoverable', ?, ?, ?)`
      )
      .run("session-orphan", DEAD_WS, now, now, now);
    raw
      .prepare(
        `INSERT INTO session_records (id, workspace_id, agent, cwd, title, status, started_at, created_at, updated_at) VALUES (?, NULL, 'claude', '/tmp', 't', 'recoverable', ?, ?, ?)`
      )
      .run("session-global", now, now, now);

    // --- Mission-child tables: one row for the live mission, one for the
    // dead mission (which itself belongs to the dead workspace, so pass 1
    // never even sees these rows directly — pass 2 catches them because
    // DEAD_MISSION is not in `missions` at all). ---
    raw
      .prepare(
        `INSERT INTO mission_agents (id, mission_id, role, label, agent, status, created_at, updated_at) VALUES (?, ?, 'builder', 'Builder 1', 'claude', 'idle', ?, ?)`
      )
      .run("magent-live", LIVE_MISSION, now, now);
    raw
      .prepare(
        `INSERT INTO mission_agents (id, mission_id, role, label, agent, status, created_at, updated_at) VALUES (?, ?, 'builder', 'Builder 1', 'claude', 'idle', ?, ?)`
      )
      .run("magent-orphan", DEAD_MISSION, now, now);

    raw
      .prepare(
        `INSERT INTO mission_messages (id, mission_id, body, created_at) VALUES (?, ?, 'hi', ?)`
      )
      .run("mmsg-live", LIVE_MISSION, now);
    raw
      .prepare(
        `INSERT INTO mission_messages (id, mission_id, body, created_at) VALUES (?, ?, 'hi', ?)`
      )
      .run("mmsg-orphan", DEAD_MISSION, now);

    raw
      .prepare(
        `INSERT INTO file_claims (id, mission_id, path, agent_id, claimed_at, last_heartbeat_at) VALUES (?, ?, 'src/a.ts', 'agent-1', ?, ?)`
      )
      .run("claim-live", LIVE_MISSION, now, now);
    raw
      .prepare(
        `INSERT INTO file_claims (id, mission_id, path, agent_id, claimed_at, last_heartbeat_at) VALUES (?, ?, 'src/a.ts', 'agent-1', ?, ?)`
      )
      .run("claim-orphan", DEAD_MISSION, now, now);

    raw
      .prepare(
        `INSERT INTO claim_conflicts (id, mission_id, path, holder_agent_id, detected_at) VALUES (?, ?, 'src/a.ts', 'agent-1', ?)`
      )
      .run("conflict-live", LIVE_MISSION, now);
    raw
      .prepare(
        `INSERT INTO claim_conflicts (id, mission_id, path, holder_agent_id, detected_at) VALUES (?, ?, 'src/a.ts', 'agent-1', ?)`
      )
      .run("conflict-orphan", DEAD_MISSION, now);

    raw
      .prepare(
        `INSERT INTO mission_tasks (id, mission_id, title, prompt, declared_paths, status, created_at, updated_at) VALUES (?, ?, 't', 'p', '[]', 'pending', ?, ?)`
      )
      .run("task-live", LIVE_MISSION, now, now);
    raw
      .prepare(
        `INSERT INTO mission_tasks (id, mission_id, title, prompt, declared_paths, status, created_at, updated_at) VALUES (?, ?, 't', 'p', '[]', 'pending', ?, ?)`
      )
      .run("task-orphan", DEAD_MISSION, now, now);

    raw.pragma("user_version = 8");
    raw.close();
  }

  function idsOf(db: Database.Database, table: string, column: string): string[] {
    return (db.prepare(`SELECT ${column} as v FROM ${table}`).all() as { v: string }[]).map(
      (r) => r.v
    );
  }

  it("deletes rows whose owning workspace no longer exists, from every direct table", () => {
    const dbPath = join(dataDir, DB_FILENAME);
    buildVersion8DatabaseWithOrphans(dbPath);

    const db = openDatabase();
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_VERSION);

    expect(idsOf(db, "board_cards", "id")).toEqual(["card-live"]);
    expect(idsOf(db, "agent_profiles", "id")).toEqual(["profile-live"]);
    expect(idsOf(db, "command_history", "id")).toEqual(["cmd-live"]);
    // saved_prompts/session_records: the orphan is gone, but BOTH the live
    // and the global (NULL workspace_id) row survive.
    expect(idsOf(db, "saved_prompts", "id").sort()).toEqual(["prompt-global", "prompt-live"]);
    expect(idsOf(db, "session_records", "id").sort()).toEqual(["session-global", "session-live"]);

    db.close();
  });

  it("cascades a dead workspace's dead mission to all five mission-child tables", () => {
    const dbPath = join(dataDir, DB_FILENAME);
    buildVersion8DatabaseWithOrphans(dbPath);

    const db = openDatabase();

    // The dead mission itself was swept in pass 1 (missions has a
    // workspace_id column too), and each mission-child table's dead-mission
    // row is gone in the same migration run (pass 2), while every live-
    // mission row survives untouched.
    expect(idsOf(db, "missions", "id")).toEqual([LIVE_MISSION]);
    expect(idsOf(db, "mission_agents", "id")).toEqual(["magent-live"]);
    expect(idsOf(db, "mission_messages", "id")).toEqual(["mmsg-live"]);
    expect(idsOf(db, "file_claims", "id")).toEqual(["claim-live"]);
    expect(idsOf(db, "claim_conflicts", "id")).toEqual(["conflict-live"]);
    expect(idsOf(db, "mission_tasks", "id")).toEqual(["task-live"]);

    db.close();
  });
});
