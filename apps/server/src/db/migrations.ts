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
 *   - Never DROP a table or column, and never DELETE rows that anything
 *     could still reach. If a change seems to need that, it doesn't belong
 *     here — stop and ask a human. Migration 9 is the one sanctioned
 *     exception, and it only qualifies because the rows it deletes are
 *     provably unreachable: their owning workspace no longer exists, so no
 *     screen can display them, no query scoped to a live workspace can
 *     return them, and no user action can delete them. That is a repair of
 *     data that is already lost, not a deletion of data someone has. Any
 *     future DELETE migration needs the same argument made explicitly, and
 *     a human to agree with it.
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
 * Migration 7: `ssh_profiles` — SSH connection profiles (see
 * `packages/shared/src/protocol.ts`'s `SshProfile` doc comment for the full
 * design, including why this is GLOBAL rather than `workspace_id`-scoped: a
 * profile names a machine, not a project).
 *
 * `UNIQUE(name)` — not `UNIQUE(workspace_id, name)` the way `agent_profiles`
 * is — is the same "let the database arbitrate a create race, don't
 * check-then-insert" pattern as every other UNIQUE constraint in this file;
 * see `swarm/claims.ts`'s top comment for the full reasoning. Because
 * profiles are global, this also directly ANSWERS "duplicate — one-click
 * Duplicate must therefore pick a NEW, non-colliding name" (see
 * `apps/server/src/ssh/store.ts`'s `duplicate()`), rather than the
 * duplicate silently landing in a different workspace where the same name
 * would've been fine.
 *
 * `user`/`port`/`default_directory`/`startup_command` are all nullable —
 * every one of them has an honest "not set" meaning (`ssh`'s own default
 * user, `ssh`'s own default port 22, no `cd`, no startup command) rather
 * than an empty string standing in for absence. `port` is INTEGER, not
 * TEXT, so `apps/server/src/ssh/spawn.ts` never has to re-parse/validate a
 * numeric string pulled back out of SQLite.
 */
function up007SshProfiles(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ssh_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      user TEXT,
      port INTEGER,
      default_directory TEXT,
      startup_command TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(name)
    )
  `);
}

/**
 * Migration 8 (session recovery / deferred restore — BridgeSpace v3.2.2 +
 * v3.4.13 parity): `session_records`, a brand-new table, so no existing
 * database has anything to repair here — same "fresh CREATE TABLE, not a
 * repair" shape as migration 6's `command_history` / migration 7's
 * `ssh_profiles`.
 *
 * A `session_record` is written at SPAWN time (see `apps/server/src/
 * index.ts`'s `POST /api/sessions` handler) and is deliberately a SEPARATE
 * row from anything `SessionManager` tracks in memory — that separation is
 * the entire point: `SessionManager`'s state is gone the instant the server
 * process dies, but this row survives (it's on disk), which is what makes a
 * session offered for resume after a restart instead of just vanishing (the
 * exact weakness — "sessions currently die if the server restarts" — this
 * migration exists to close).
 *
 *   - `pane_id` is the web app's own GridNode leaf id
 *     (`apps/web/src/grid/tree.ts`) — nullable (a board/swarm-dispatched
 *     session has no pane of origin) but set for every ordinary
 *     pane-originated spawn, and it's what lets a resume target the SAME
 *     pane rather than "any empty one".
 *   - `session_id` is the CURRENT live `SessionManager` id, cleared to NULL
 *     the moment the pty backing it is gone (see the sibling store,
 *     `db/session-records.ts`'s `markExited`/`markServerRestartOrphans`) —
 *     resuming always gets a brand-new id, since an OS process, once gone,
 *     can never be revived; this column just tracks "whichever one is
 *     currently live, if any".
 *   - `agent_session_ref` is a stable per-agent-CLI handle vibedeck controls
 *     itself at spawn time (Claude's `--session-id <uuid>` today — see
 *     `apps/server/src/pty/resume.ts`'s research notes) that survives every
 *     resume, unlike `session_id` — `claude --resume <ref>` needs the SAME
 *     uuid every time, not a fresh one per attempt.
 *   - `status` is the one actionable field: 'running' while a live pty backs
 *     it, 'recoverable' once that pty is gone for ANY reason (exited on its
 *     own, or orphaned by a server restart — `ended_reason` distinguishes
 *     which), 'discarded' once dismissed from History. There is no
 *     'exited'-as-a-dead-end status distinct from 'recoverable' — from a
 *     user's point of view "this pane isn't running anymore" is the same
 *     actionable fact whether the process quit or the server did, so both
 *     land in the one status a History screen/resume action cares about.
 *   - `ended_reason` additionally carries `'resume_failed'`: when a RESUME
 *     attempt's freshly-spawned pty exits again within a few seconds (see
 *     `apps/server/src/pty/session-lifecycle.ts`'s `RESUME_FAILURE_WINDOW_MS`),
 *     that's treated as the resume itself failing (wrong flag rejected,
 *     binary missing, immediate crash), and the record goes straight back
 *     to 'recoverable' rather than being silently lost — the specific bug
 *     BridgeSpace's own v3.4.13 note calls out ("a failed resume silently
 *     consumed the session's recoverability").
 *
 * No column here is NOT NULL where the corresponding real-world fact can be
 * legitimately absent (`workspace_id`, `pane_id`, `session_id`,
 * `ssh_profile_id`, `agent_session_ref`, `ended_at`, `ended_reason`,
 * `exit_code`) — same "NULL means a real, honest state, not a placeholder"
 * rule `workspaces.color` (migration 5) and `saved_prompts.workspace_id`
 * (migration 4) already follow.
 */
function up008SessionRecords(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_records (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      pane_id TEXT,
      session_id TEXT,
      agent TEXT NOT NULL,
      ssh_profile_id TEXT,
      agent_session_ref TEXT,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,          -- 'running' | 'recoverable' | 'discarded'
      started_at TEXT NOT NULL,
      ended_at TEXT,
      ended_reason TEXT,             -- 'exited' | 'server_restart' | 'resume_failed' | NULL
      exit_code INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  // Backs both `SessionRecordsStore.list(workspaceId)` (the History
  // screen's per-workspace feed) and `listRecoverable` (cold-start
  // restore's input) — both filter on workspace_id, the latter also on
  // status, so status rides along in the same index rather than needing a
  // second one.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_session_records_workspace ON session_records(workspace_id, status)`
  );
  // Supports "does THIS pane already have a session record" lookups
  // (deferred-pane rendering, resume-into-same-pane) without a table scan.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_session_records_pane ON session_records(pane_id)`);
}

/**
 * Migration 9 (workspace-deletion cleanup): sweeps up rows that were
 * orphaned by every workspace deletion that ran BEFORE `WorkspaceStore.
 * remove()` learned to cascade (see that method's own doc comment in
 * `workspaces.ts` for the full story — `DELETE FROM workspaces WHERE id = ?`
 * used to be the entire implementation, and none of the 11 tables below have
 * a real `FOREIGN KEY`, so every row that belonged to a deleted workspace
 * was stranded forever: invisible in the UI, never deletable, just
 * accumulating). This migration is the one-time repair for damage already
 * done; `remove()`'s transaction is what stops it from happening again.
 *
 * Two passes, order matters:
 *
 *   1. Direct tables (`board_cards`, `missions`, `agent_profiles`,
 *      `saved_prompts`, `command_history`, `session_records`) — each has its
 *      own `workspace_id` column, so "orphaned" means that id doesn't exist
 *      in `workspaces` anymore. `saved_prompts.workspace_id` and
 *      `session_records.workspace_id` are nullable (migrations 4 and 8) —
 *      NULL there means "global", not "not yet set". (`agent_profiles.
 *      workspace_id` is declared `NOT NULL` in migration 4 and is `NOT
 *      NULL` in the live database too — checked directly with `PRAGMA
 *      table_info(agent_profiles)` — so it has no global/NULL case today,
 *      unlike its two siblings.) Every DELETE below is still guarded with
 *      an explicit `workspace_id IS NOT NULL`, uniformly across all six
 *      direct tables: it's a no-op for the non-nullable columns and the
 *      thing that protects global rows for the nullable ones, and writing
 *      the same guard on every table keeps this loop simple instead of
 *      special-casing three tables out of six. The guard is technically
 *      redundant with plain SQL `NOT IN` semantics even for the nullable
 *      columns (`NULL NOT IN (...)` already evaluates to NULL/false, never
 *      true, so a global row would never match even without it) — it's
 *      kept anyway so the intent to preserve global rows is obvious on
 *      read, not an accidental side-effect of NULL-comparison trivia.
 *
 *   2. Mission-child tables (`mission_agents`, `mission_messages`,
 *      `file_claims`, `claim_conflicts`, `mission_tasks`) — these don't have
 *      a `workspace_id` of their own, only `mission_id`, so they run AFTER
 *      pass 1 has already deleted every `missions` row that belonged to a
 *      dead workspace. That ordering is what makes this a full cascade in
 *      one migration: a mission orphaned by pass 1 makes its children
 *      orphaned too, and pass 2 catches exactly those in the same run,
 *      rather than requiring a migration 10 to clean up what migration 9
 *      just created.
 *
 * The `x NOT IN (SELECT id FROM workspaces)` / `(SELECT id FROM missions)`
 * subqueries are safe from the classic `NOT IN` + NULL trap (`NOT IN`
 * returns NULL, never TRUE, for every row if the subquery's result set
 * contains even one NULL) because `workspaces.id` and `missions.id` are
 * both `PRIMARY KEY` — SQLite never allows a NULL primary key value, so
 * neither subquery can ever produce one.
 *
 * Table names below are hardcoded string literals, never user input, so
 * building each DELETE with a template string is safe — same reasoning
 * `migrate()`'s own `PRAGMA user_version = ${highestVersion}` interpolation
 * below already relies on.
 */
function up009DeleteOrphanedWorkspaceScopedRows(db: Database): void {
  const directTables = [
    "board_cards",
    "missions",
    "agent_profiles",
    "saved_prompts",
    "command_history",
    "session_records",
  ];
  for (const table of directTables) {
    db.exec(
      `DELETE FROM ${table} WHERE workspace_id IS NOT NULL AND workspace_id NOT IN (SELECT id FROM workspaces)`
    );
  }

  // Runs AFTER the loop above so a mission that pass 1 just deleted (because
  // ITS workspace was dead) makes its own children orphaned too, and they
  // get swept up here in the same migration — see the doc comment above.
  const missionChildTables = [
    "mission_agents",
    "mission_messages",
    "file_claims",
    "claim_conflicts",
    "mission_tasks",
  ];
  for (const table of missionChildTables) {
    db.exec(
      `DELETE FROM ${table} WHERE mission_id IS NOT NULL AND mission_id NOT IN (SELECT id FROM missions)`
    );
  }
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
 * Migration 7 (SSH connection profiles) is the same kind of brand-new
 * addition as migration 6's `command_history` — a fresh `CREATE TABLE`, not
 * a repair, since no existing database has ever had `ssh_profiles`. Migration
 * 9 is neither shape — it's a one-time data repair (DELETEs, not
 * CREATE/ALTER) for rows orphaned by `WorkspaceStore.remove()` before it
 * learned to cascade; see that migration's own doc comment.
 */
export const MIGRATIONS: Migration[] = [
  { version: 1, name: "full schema", up: up001FullSchema },
  { version: 2, name: "add file_claims.last_heartbeat_at", up: up002FileClaimsLastHeartbeatAt },
  { version: 3, name: "add board_cards.task_knowledge", up: up003BoardCardsTaskKnowledge },
  { version: 4, name: "add agent_profiles and saved_prompts", up: up004AgentProfilesAndSavedPrompts },
  { version: 5, name: "add workspaces.color", up: up005WorkspacesColor },
  { version: 6, name: "add command_history", up: up006CommandHistory },
  { version: 7, name: "add ssh_profiles", up: up007SshProfiles },
  { version: 8, name: "add session_records", up: up008SessionRecords },
  {
    version: 9,
    name: "delete orphaned workspace-scoped rows",
    up: up009DeleteOrphanedWorkspaceScopedRows,
  },
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
