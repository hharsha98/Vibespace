/**
 * Versioned schema migrations, applied via SQLite's `PRAGMA user_version` —
 * the canonical way to track "which schema shape does this file have" for
 * a single-file SQLite database with no separate migrations table.
 *
 * Why this exists: `schema.ts` used to run nothing but `CREATE TABLE IF NOT
 * EXISTS` statements on every `openDatabase()` call. That is idempotent for
 * a *fresh* database, but silently does nothing on an existing one — if a
 * column is added to a table's definition later, a database created before
 * that change never gets it. `file_claims.last_heartbeat_at` is exactly
 * this bug in production: it was added to the table definition after some
 * users' `~/.vibedeck/vibedeck.db` was already created, so their file_claims
 * table is missing it and every claim request 500s.
 *
 * How it works:
 *   1. Read the database's current `user_version` (0 for a brand-new file,
 *      or for any database created before this migration system existed).
 *   2. Collect every migration whose `version` is greater than that.
 *   3. If there are none, do nothing — no backup, no transaction, no write.
 *   4. If there are some: back up the database file first (see `backupDatabase`
 *      below), then run every pending migration's `up(db)`, in ascending
 *      version order, inside ONE transaction, then set `user_version` to the
 *      highest version just applied — all as part of that same transaction,
 *      so a failure partway through rolls back the whole thing (including
 *      the version bump) rather than leaving the database half-migrated.
 *
 * Rules for adding a new migration:
 *   - Never DROP a table or column, never DELETE rows. If a change seems to
 *     need that, it doesn't belong here — stop and ask a human.
 *   - `ALTER TABLE ... ADD COLUMN` cannot add a NOT NULL column without a
 *     default in SQLite, so add nullable + backfill with an UPDATE instead.
 *   - Guard every `ADD COLUMN` with `hasColumn()` first — SQLite throws
 *     `SQLITE_ERROR: duplicate column name` if you don't, and because
 *     `user_version` already prevents a completed migration from re-running,
 *     this guard mostly matters for defensive/idempotent-in-effect safety
 *     (e.g. re-running this file's logic outside the normal open path).
 *   - Bump `version` by exactly 1 from the current highest.
 */
import type { Database } from "better-sqlite3";
import { copyFileSync, existsSync } from "node:fs";

export interface Migration {
  version: number;
  name: string;
  up(db: Database): void;
}

function hasColumn(db: Database, table: string, column: string): boolean {
  const columns = db.pragma(`table_info(${table})`) as { name: string }[];
  return columns.some((c) => c.name === column);
}

/**
 * Migration 1: the current full schema, moved verbatim from what used to be
 * `openDatabase()`'s body. A brand-new database runs this and lands exactly
 * at today's shape. An existing database also runs this (since its
 * `user_version` starts at 0), but every statement here is `CREATE TABLE /
 * INDEX IF NOT EXISTS`, so on a database that already has these tables it
 * is a no-op — which is precisely why an existing table missing a column
 * needs a *later* migration (see migration 2) to actually repair it.
 */
function up001FullSchema(db: Database): void {
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

  // Phase 7: the board. `position` is a fractional index (see board.ts's top
  // comment for why) rather than an integer row number, so inserting a card
  // between two neighbours never has to renumber the rest of the column.
  db.exec(`
    CREATE TABLE IF NOT EXISTS board_cards (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      priority TEXT NOT NULL,
      column_id TEXT NOT NULL,
      position REAL NOT NULL,
      session_id TEXT,
      agent TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_board_cards_workspace ON board_cards(workspace_id, column_id, position)`
  );

  // Phase 9a: agent swarms — a mission is a prompt split across several
  // dispatched agent sessions (mission_agents), coordinating over a shared
  // mailbox (mission_messages) and a file-ownership ledger (file_claims).
  // See apps/server/src/swarm/*.ts for the stores that own each table.
  db.exec(`
    CREATE TABLE IF NOT EXISTS missions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,            -- 'running' | 'paused' | 'complete' | 'stopped'
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_missions_workspace ON missions(workspace_id)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS mission_agents (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      role TEXT NOT NULL,              -- 'coordinator' | 'builder' | 'scout' | 'reviewer'
      label TEXT NOT NULL,             -- e.g. "Builder 2"
      agent TEXT NOT NULL,             -- which CLI (claude / cursor-agent / codex / shell)
      session_id TEXT,
      status TEXT NOT NULL,            -- 'idle' | 'working' | 'blocked' | 'done' | 'failed'
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mission_agents_mission ON mission_agents(mission_id)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS mission_messages (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      from_agent_id TEXT,              -- NULL = from the human
      to_agent_id TEXT,                -- NULL = broadcast to all
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_mission_messages_mission ON mission_messages(mission_id, created_at)`
  );

  // UNIQUE(mission_id, path) is the whole safety property this phase rests
  // on: it lets SQLite itself arbitrate a claim race instead of a
  // check-then-write race in application code (see swarm/claims.ts's top
  // comment). It also doubles as the index needed for "is this path free in
  // this mission" lookups, so no separate index on those two columns is
  // needed.
  //
  // `last_heartbeat_at` is separate from `claimed_at`: `claimed_at` never
  // changes after the claim is created (it's "when did this ownership
  // start"), while `last_heartbeat_at` is bumped by `POST .../claims/heartbeat`
  // and is what staleness (swarm/claims.ts's `CLAIM_STALE_TTL_MS`) is judged
  // against — an agent that's still alive but has been silently working for
  // an hour should NOT look stale just because it claimed the file an hour
  // ago.
  db.exec(`
    CREATE TABLE IF NOT EXISTS file_claims (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      path TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      last_heartbeat_at TEXT NOT NULL,
      UNIQUE(mission_id, path)
    )
  `);
  // Supports "release every claim this agent holds" (an agent finishing, or
  // a mission stopping) without a full table scan.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_file_claims_agent ON file_claims(mission_id, agent_id)`);

  // A conflict is DETECTION, not prevention (see swarm/watch.ts's top
  // comment): a row here means a file changed on disk while some agent
  // OTHER than the one that wrote it held the claim on that path — evidence
  // of a mis-behaving or uncooperative agent, not something the registry
  // could have stopped.
  db.exec(`
    CREATE TABLE IF NOT EXISTS claim_conflicts (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      path TEXT NOT NULL,
      holder_agent_id TEXT NOT NULL,
      detected_at TEXT NOT NULL
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_claim_conflicts_mission ON claim_conflicts(mission_id, detected_at)`
  );

  // A mission_task is a unit of work with DECLARED file paths — what a
  // builder expects to touch, known up front, before any claim is ever
  // made. `swarm/schedule.ts`'s planSchedule() groups tasks with no
  // declared-path overlap into the same "wave" (safe to run concurrently)
  // and forces overlapping tasks into separate waves — this is SEQUENCING,
  // a second, complementary layer to file_claims: sequencing prevents
  // PLANNED collisions before any agent is even spawned; claims catch
  // UNPLANNED collisions at claim-time; the watcher (claim_conflicts)
  // detects what neither stopped. See docs/SWARM.md.
  //
  // `declared_paths` is a JSON array (SQLite has no array type).
  // `review_approved` is NULL until reviewed, then 0/1 — a task can only
  // reach status 'complete' via the review endpoint approving it
  // (swarm/tasks.ts enforces this; there is deliberately no other code
  // path that sets status='complete').
  db.exec(`
    CREATE TABLE IF NOT EXISTS mission_tasks (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      declared_paths TEXT NOT NULL,        -- JSON string[] of workspace-relative paths
      status TEXT NOT NULL,                -- 'pending' | 'running' | 'in_review' | 'complete' | 'blocked'
      assigned_agent_id TEXT,
      review_approved INTEGER,             -- NULL = not yet reviewed, 0 = rejected, 1 = approved
      review_notes TEXT,
      reviewed_by_agent_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mission_tasks_mission ON mission_tasks(mission_id)`);
}

/**
 * Migration 2: repairs `file_claims` tables created before
 * `last_heartbeat_at` existed in the table definition (i.e. any real
 * database that predates this migration system — it was always at
 * `user_version 0` and `CREATE TABLE IF NOT EXISTS` never added the column
 * because the table already existed).
 *
 * Backfills from `claimed_at` rather than leaving it NULL or using "now":
 * `claimed_at` is the honest value — it's the last moment we actually knew
 * the claim was alive, since heartbeats hadn't been tracked separately yet.
 */
function up002FileClaimsLastHeartbeatAt(db: Database): void {
  if (!hasColumn(db, "file_claims", "last_heartbeat_at")) {
    db.exec(`ALTER TABLE file_claims ADD COLUMN last_heartbeat_at TEXT`);
  }
  db.exec(`UPDATE file_claims SET last_heartbeat_at = claimed_at WHERE last_heartbeat_at IS NULL`);
}

/**
 * Migration 3 (Phase 9.5b, PARITY #27b): `taskKnowledge`, a field separate
 * from `description` for long-form context (architecture notes, file
 * paths, API specs) handed to a dispatched agent alongside its
 * instructions. Nullable, same reasoning as every other optional
 * `board_cards` column (`description`, `session_id`, `agent`) — an existing
 * card simply has no task knowledge until someone adds it.
 */
function up003BoardCardsTaskKnowledge(db: Database): void {
  if (!hasColumn(db, "board_cards", "task_knowledge")) {
    db.exec(`ALTER TABLE board_cards ADD COLUMN task_knowledge TEXT`);
  }
}

/**
 * Migration 4 (Phase 9.5b, PARITY #26/#27): two brand-new tables, bundled
 * into one migration because neither touches an existing table (both are
 * fresh `CREATE TABLE`s, so there's nothing an earlier database could be
 * missing that an `ALTER TABLE` would need to repair) — same "bundle
 * unrelated but simultaneous additions" reasoning migration 1 itself used
 * for `missions`/`mission_agents`/`mission_messages`/`file_claims`/
 * `claim_conflicts`/`mission_tasks` all at once.
 *
 * `agent_profiles`: a stored `{name, systemPrompt}` persona scoped to a
 * workspace (BridgeMCP's agent-records shape, docs/RESEARCH.md §2).
 * `UNIQUE(workspace_id, name)` is the same "let the database arbitrate,
 * don't check-then-insert" pattern `file_claims`'s `UNIQUE(mission_id,
 * path)` uses — see `swarm/claims.ts`'s top comment for the full reasoning
 * (two concurrent creates of the same name in the same workspace always
 * resolve to exactly one winner, with no race window to close by hand).
 *
 * `saved_prompts`: a reusable prompt, optionally workspace-scoped.
 * `workspace_id` is nullable ON PURPOSE — see `SavedPrompt`'s doc comment
 * in `packages/shared/src/protocol.ts` — a NULL means "global", not "not
 * yet set", so it's never backfilled or treated as an error.
 */
function up004AgentProfilesAndSavedPrompts(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_profiles (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      base_agent TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(workspace_id, name)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_profiles_workspace ON agent_profiles(workspace_id)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS saved_prompts (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  // Not UNIQUE-constrained on workspace_id since it's nullable and many
  // rows deliberately share the same (or a NULL) workspace_id — this index
  // only speeds up "every prompt for this workspace, or global" lookups.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_saved_prompts_workspace ON saved_prompts(workspace_id)`);
}

/**
 * Migration 5 (Phase 9.5c, PARITY #41): `workspaces.color`, a nullable
 * free-text column holding one of `WORKSPACE_COLORS` (see
 * `packages/shared/src/protocol.ts`) or NULL. NULL is the honest default for
 * every existing workspace — "no colour chosen yet", which the rail and pane
 * header both render as the current neutral look, not a randomly-assigned
 * swatch (see that constant's own doc comment for why). No backfill UPDATE
 * is needed the way migration 2's `last_heartbeat_at` needed one: NULL here
 * is already the correct, meaningful value for a workspace that predates
 * this column, not a placeholder standing in for missing data.
 */
function up005WorkspacesColor(db: Database): void {
  if (!hasColumn(db, "workspaces", "color")) {
    db.exec(`ALTER TABLE workspaces ADD COLUMN color TEXT`);
  }
}

/**
 * Migration 6 (BridgeSpace parity item 4): `command_history`, per-workspace
 * command/prompt history backing the per-pane prompt bar's autocomplete
 * (see `apps/server/src/db/command-history.ts` and
 * `apps/web/src/term/commandHistory.ts`). `UNIQUE(workspace_id, command)`
 * is the enforced invariant behind `CommandHistoryStore.record`'s
 * delete-then-insert dedupe (see that method's own comment for why it's a
 * delete+insert, in a transaction, rather than an `ON CONFLICT ... DO
 * UPDATE` — a plain UPDATE would leave a re-recorded row's original
 * `rowid` in place, breaking "most recently run sorts first" for two
 * commands recorded within the same millisecond).
 */
function up006CommandHistory(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS command_history (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      command TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(workspace_id, command)
    )
  `);
  // Serves both `CommandHistoryStore.list`'s "newest first" ordering and
  // its own pruning query (see that store's `MAX_ENTRIES_PER_WORKSPACE`).
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_command_history_workspace ON command_history(workspace_id, created_at)`
  );
}

/**
 * Every migration, in ascending version order. Audited against the live
 * `~/.vibedeck/vibedeck.db` on this machine by comparing each `CREATE
 * TABLE` above to `PRAGMA table_info` on every table that db actually had:
 * `workspaces`, `board_cards`, `missions`, `mission_agents`,
 * `mission_messages`, `claim_conflicts`, and `mission_tasks` all already
 * matched the current schema column-for-column. `file_claims` was the only
 * table missing a column (`last_heartbeat_at`), which migration 2 repairs.
 * Migrations 3 and 4 (Phase 9.5b) are new additions, not repairs — no
 * existing database has ever had `task_knowledge`, `agent_profiles`, or
 * `saved_prompts`, so there's nothing to audit them against yet. Migration 5
 * (Phase 9.5c) is the same kind of new addition for `workspaces.color`.
 */
export const MIGRATIONS: Migration[] = [
  { version: 1, name: "full schema", up: up001FullSchema },
  { version: 2, name: "add file_claims.last_heartbeat_at", up: up002FileClaimsLastHeartbeatAt },
  { version: 3, name: "add board_cards.task_knowledge", up: up003BoardCardsTaskKnowledge },
  { version: 4, name: "add agent_profiles and saved_prompts", up: up004AgentProfilesAndSavedPrompts },
  { version: 5, name: "add workspaces.color", up: up005WorkspacesColor },
  { version: 6, name: "add command_history", up: up006CommandHistory },
];

/** Copies the database file to `<dbPath>.backup-v<version>`. Flushes WAL
 * into the main file first (best-effort) so the copy isn't missing recently
 * committed data that hasn't been checkpointed yet. */
function backupDatabase(db: Database, dbPath: string, version: number): void {
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    // Best-effort: even if the checkpoint fails (e.g. nothing to
    // checkpoint), still attempt the copy below rather than aborting here.
  }

  if (!existsSync(dbPath)) {
    // Nothing on disk yet (a brand-new database) — nothing to back up.
    return;
  }

  const backupPath = `${dbPath}.backup-v${version}`;
  try {
    copyFileSync(dbPath, backupPath);
  } catch (err) {
    throw new Error(
      `Refusing to migrate "${dbPath}": failed to create backup at "${backupPath}" first (${
        err instanceof Error ? err.message : String(err)
      })`
    );
  }
}

/**
 * Applies every pending migration to `db`, in order, inside one transaction.
 * Does nothing (no backup, no transaction, no write) if the database is
 * already at the latest version. `dbPath` is needed separately from `db`
 * because backups operate on the underlying file, not the open handle.
 */
export function migrate(db: Database, dbPath: string): void {
  const currentVersion = db.pragma("user_version", { simple: true }) as number;
  const pending = MIGRATIONS.filter((m) => m.version > currentVersion).sort(
    (a, b) => a.version - b.version
  );
  if (pending.length === 0) return;

  backupDatabase(db, dbPath, currentVersion);

  const highestVersion = pending[pending.length - 1].version;
  const runPendingMigrations = db.transaction(() => {
    for (const migration of pending) {
      migration.up(db);
    }
    // PRAGMA doesn't support bound parameters; the value is our own
    // integer (never user input), so string interpolation is safe here.
    db.pragma(`user_version = ${highestVersion}`);
  });
  runPendingMigrations();
}
