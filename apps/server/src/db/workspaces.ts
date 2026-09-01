/**
 * WorkspaceStore: the only place in the server that speaks SQL. Routes call
 * these methods and get back plain `Workspace` objects (the shared protocol
 * type) — no `Database` handle, no row shapes, leak past this file.
 */
import type { Database } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { Workspace } from "@vibespace/shared";
import { openDatabase } from "./schema.js";

/** The raw shape a row comes back as from better-sqlite3 (snake_case, as SQLite gave it to us). */
interface WorkspaceRow {
  id: string;
  name: string;
  root_path: string;
  layout: string | null;
  /** Nullable — see migrations.ts's migration 5 and `Workspace.color`'s own
   * doc comment in packages/shared/src/protocol.ts. */
  color: string | null;
  created_at: string;
  updated_at: string;
}

function rowToWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    layout: row.layout,
    color: row.color,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateWorkspaceOptions {
  name: string;
  rootPath: string;
}

export interface UpdateWorkspaceOptions {
  name?: string;
  rootPath?: string;
  layout?: string | null;
  /** Phase 9.5c (PARITY #41) — one of `WORKSPACE_COLORS`, or explicitly
   * null to clear a previously-chosen colour. Same "explicit null means
   * clear, undefined means leave alone" rule `layout` already uses below. */
  color?: string | null;
}

/**
 * Tables owned directly by a workspace (a `workspace_id` column pointing at
 * `workspaces.id`) that `remove()` deletes from before deleting the
 * workspace row itself.
 *
 * Exported so `workspaces.test.ts`'s guard test can compare this list
 * against every table the LIVE schema says actually has a `workspace_id`
 * column (via `pragma_table_info`) — if a future table gains `workspace_id`
 * and isn't added here, that test fails loudly instead of the new table's
 * rows silently surviving every workspace deletion forever. See `remove()`'s
 * own doc comment for why this hand-maintained list exists instead of a
 * `FOREIGN KEY ... ON DELETE CASCADE`.
 */
export const WORKSPACE_SCOPED_TABLES = [
  "board_cards",
  "missions",
  "agent_profiles",
  "saved_prompts",
  "command_history",
  "session_records",
] as const;

/**
 * Tables owned by a *mission*, which is itself owned by a workspace (a
 * `mission_id` column, no `workspace_id` of their own) — see migration 1 in
 * `migrations.ts` for why swarm data is shaped this way. `remove()` must
 * delete these BEFORE deleting the `missions` rows they point at: once a
 * mission row is gone, `mission_id IN (SELECT id FROM missions WHERE
 * workspace_id = ?)` can no longer find it, and the child rows would be
 * stranded exactly like the bug this whole file exists to fix.
 *
 * Not exported: none of these tables has a `workspace_id` column of its own
 * (they're one hop removed, via `mission_id`), so the guard test above has
 * no live-schema signal to check them against — a table like this that
 * needed cleanup would have to be caught by code review, not a runtime
 * assertion.
 */
const MISSION_SCOPED_TABLES = [
  "mission_agents",
  "mission_messages",
  "file_claims",
  "claim_conflicts",
  "mission_tasks",
] as const;

export class WorkspaceStore {
  private db: Database;

  /** Defaults to a fresh `openDatabase()` call; tests/callers may inject
   * their own handle (e.g. one opened against a temp-dir db) if needed. */
  constructor(db: Database = openDatabase()) {
    this.db = db;
  }

  list(): Workspace[] {
    const rows = this.db
      .prepare("SELECT * FROM workspaces ORDER BY created_at ASC")
      .all() as WorkspaceRow[];
    return rows.map(rowToWorkspace);
  }

  get(id: string): Workspace | undefined {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as
      | WorkspaceRow
      | undefined;
    return row ? rowToWorkspace(row) : undefined;
  }

  create({ name, rootPath }: CreateWorkspaceOptions): Workspace {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO workspaces (id, name, root_path, layout, color, created_at, updated_at)
         VALUES (?, ?, ?, NULL, NULL, ?, ?)`
      )
      .run(id, name, rootPath, now, now);
    // Re-read rather than constructing the object by hand, so this always
    // reflects exactly what SQLite actually stored (e.g. if a future column
    // gets a DB-side default).
    return this.get(id)!;
  }

  /** Returns the updated workspace, or undefined if `id` doesn't exist. */
  update(id: string, changes: UpdateWorkspaceOptions): Workspace | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;

    const name = changes.name ?? existing.name;
    const rootPath = changes.rootPath ?? existing.rootPath;
    // `layout`/`color` are both allowed to be explicitly set to null
    // (clearing them), so we can't use `??` here the way we do above — only
    // fall back to the existing value when the caller didn't mention that
    // field at all.
    const layout = "layout" in changes ? (changes.layout ?? null) : existing.layout;
    const color = "color" in changes ? (changes.color ?? null) : existing.color;
    const now = new Date().toISOString();

    this.db
      .prepare(
        `UPDATE workspaces SET name = ?, root_path = ?, layout = ?, color = ?, updated_at = ? WHERE id = ?`
      )
      .run(name, rootPath, layout, color, now, id);

    return this.get(id);
  }

  /**
   * Deletes a workspace AND every row anywhere in the database that belongs
   * to it — directly (`WORKSPACE_SCOPED_TABLES`) or via a mission
   * (`MISSION_SCOPED_TABLES`) — atomically.
   *
   * Why explicit deletes instead of `FOREIGN KEY ... ON DELETE CASCADE`:
   * SQLite has no `ALTER TABLE ... ADD CONSTRAINT` — a foreign key can only
   * be declared when a table is first created. Retrofitting real FKs onto
   * the 11 tables above would mean the "create a new table with the FK,
   * copy every row across, drop the old table, rename" dance, on every one
   * of them, against a real user's live database. That's a lot of surface
   * area to risk actual data on just to clean up orphaned rows. Explicit,
   * hand-listed deletes are less elegant but far lower-risk. The trade-off
   * is that a future table gaining a `workspace_id` (or `mission_id`)
   * column must be added to the relevant list by hand, or its rows will
   * silently outlive every workspace that ever owned them — see
   * `workspaces.test.ts`'s guard test, which reads the live schema and
   * fails loudly if any table has grown a `workspace_id` column without
   * being added to `WORKSPACE_SCOPED_TABLES`. That test is what makes this
   * trade-off survivable.
   *
   * Runs inside one `better-sqlite3` transaction, so this is all-or-
   * nothing: either the workspace and everything under it disappear
   * together, or (if anything throws partway through) nothing is deleted at
   * all and the database is left exactly as it was.
   *
   * `this.db` is `WorkspaceStore`'s own handle (`openDatabase()`), and every
   * other `*Store` in this directory opens its own handle too — but they
   * all point at the SAME on-disk `vibespace.db` file (see `schema.ts`), so
   * deleting `board_cards`/`missions`/etc. rows from THIS handle is not a
   * layering violation; it's the same file on disk, just reached through a
   * different `openDatabase()` call, with no separate "BoardStore.remove()"
   * this should be delegating to instead.
   *
   * Table names below come only from the hand-written constants above
   * (never user input), so building the DELETE statements with template
   * strings is safe — same reasoning `migrations.ts` uses for its
   * `PRAGMA user_version = ${highestVersion}` interpolation.
   *
   * Returns true if a workspace with this id existed and was removed, false
   * otherwise. The existence check happens up front, inside the same
   * transaction, so an unknown id runs zero DELETE statements rather than
   * relying on every dependent delete being a harmless no-op against rows
   * that were never there.
   */
  remove(id: string): boolean {
    const removeTransaction = this.db.transaction((workspaceId: string): boolean => {
      const existing = this.db.prepare("SELECT id FROM workspaces WHERE id = ?").get(workspaceId);
      if (!existing) return false;

      // Mission children FIRST — deleting `missions` rows before this would
      // leave "mission_id IN (SELECT id FROM missions WHERE workspace_id = ?)"
      // with nothing left to find.
      for (const table of MISSION_SCOPED_TABLES) {
        this.db
          .prepare(
            `DELETE FROM ${table} WHERE mission_id IN (SELECT id FROM missions WHERE workspace_id = ?)`
          )
          .run(workspaceId);
      }

      for (const table of WORKSPACE_SCOPED_TABLES) {
        this.db.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).run(workspaceId);
      }

      this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(workspaceId);
      return true;
    });

    return removeTransaction(id);
  }

  /** Closes the underlying database handle. Call on server shutdown. */
  close(): void {
    this.db.close();
  }
}
