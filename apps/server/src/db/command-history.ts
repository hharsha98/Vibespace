/**
 * CommandHistoryStore: the only place in the server that speaks SQL for
 * `command_history` (BridgeSpace parity item 4 — command history with
 * autocomplete). Same "routes get back plain values, no row shapes leak
 * past this file" rule as `BoardStore`/`WorkspaceStore`/`SavedPromptStore`.
 *
 * A workspace's history is deliberately DEDUPED, not append-only:
 * recording a command that's already in this workspace's history replaces
 * its row (see `record()`'s own comment for why that's a delete+insert,
 * not an in-place update) rather than inserting a second one. Without this, running the same command
 * repeatedly — `git status`, `ls`, `pnpm test`, all extremely common —
 * would bury genuinely different history under a wall of duplicates.
 * Deduping keeps "most recently run" and "appears once, near the top" the
 * same fact, which is exactly what makes a plain prefix match (see
 * `apps/web/src/term/commandHistory.ts` — deliberately no fuzzy ranking)
 * useful without any scoring logic on top of it.
 *
 * Note on "self-healing if corrupted" (mentioned in BridgeSpace's own
 * changelog for their equivalent feature): that concern applies to a
 * hand-rolled flat-file history store, where a half-written line or a bad
 * encoding can corrupt the whole file. This store rides on the same SQLite
 * database (with the same migration/backup machinery — see migrations.ts)
 * every other piece of persisted state in this app already uses, so there
 * is no separate bespoke format here to corrupt or repair; a malformed row
 * simply can't happen through this store's own API (every write goes
 * through parameterized `INSERT`/`DELETE` statements, never hand-built SQL
 * or a hand-parsed file).
 */
import type { Database } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { openDatabase } from "./schema.js";

/** Hard cap per workspace — keeps a workspace that's been used for months
 * from growing this table unboundedly. `record()` prunes down to this
 * after every insert (see its own comment). Purely a storage/hygiene
 * limit: PromptBar's own suggestion list (`commandHistory.ts`) caps itself
 * far below this, so raising or lowering this constant never changes what
 * the UI shows, only how much history survives in the database. Exported
 * (not just used internally) so `command-history.test.ts` can actually
 * exercise the prune boundary instead of guessing at it from outside. */
export const MAX_ENTRIES_PER_WORKSPACE = 500;

export class CommandHistoryStore {
  private db: Database;

  /** Defaults to a fresh `openDatabase()` call; tests/callers may inject
   * their own handle if needed — same convention as every other store. */
  constructor(db: Database = openDatabase()) {
    this.db = db;
  }

  /**
   * Records that `command` just ran/was submitted in `workspaceId` —
   * inserts a fresh row, or (if this exact command string is already in
   * this workspace's history) DELETEs the old row and inserts a new one in
   * its place, moving it to the front. Silently ignores a blank command
   * rather than storing a useless empty-string history entry.
   *
   * DELETE-then-INSERT (not `ON CONFLICT ... DO UPDATE`) is deliberate, not
   * just a style choice: `created_at` only has millisecond resolution, and
   * two `record()` calls in the same millisecond (trivially reachable —
   * this store's own test suite hits it) would tie on `created_at` alone.
   * An `UPDATE` leaves the row's original `rowid` untouched, so a tie would
   * keep sorting by original insertion order — the OPPOSITE of "most
   * recently run first". A fresh `INSERT` always gets a new, strictly
   * increasing `rowid`, so `list()`'s `ORDER BY created_at DESC, rowid DESC`
   * below breaks any `created_at` tie correctly: whichever row was
   * PHYSICALLY written most recently sorts first, every time.
   */
  record(workspaceId: string, command: string): void {
    if (command.length === 0) return;

    const now = new Date().toISOString();
    const runRecord = this.db.transaction(() => {
      this.db
        .prepare(`DELETE FROM command_history WHERE workspace_id = ? AND command = ?`)
        .run(workspaceId, command);
      this.db
        .prepare(
          `INSERT INTO command_history (id, workspace_id, command, created_at) VALUES (?, ?, ?, ?)`
        )
        .run(randomUUID(), workspaceId, command, now);
    });
    runRecord();

    // Prune anything past the cap, oldest first. Cheap in the common case
    // — there is usually nothing to delete — since the subquery only has
    // to walk this one workspace's rows via the (workspace_id, created_at)
    // index migration 6 creates, not the whole table.
    this.db
      .prepare(
        `DELETE FROM command_history
         WHERE workspace_id = ?
           AND id NOT IN (
             SELECT id FROM command_history
             WHERE workspace_id = ?
             ORDER BY created_at DESC, rowid DESC
             LIMIT ?
           )`
      )
      .run(workspaceId, workspaceId, MAX_ENTRIES_PER_WORKSPACE);
  }

  /** This workspace's command history, newest-first. PromptBar's own
   * prefix-matching (`apps/web/src/term/commandHistory.ts`) does the
   * actual filtering against user input — this just returns the pool it
   * filters over. `rowid DESC` is a deliberate tiebreaker — see
   * `record()`'s own comment for why `created_at` alone isn't always
   * enough to order two same-millisecond writes correctly. */
  list(workspaceId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT command FROM command_history WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC`
      )
      .all(workspaceId) as { command: string }[];
    return rows.map((r) => r.command);
  }

  /** Closes the underlying database handle. Call on server shutdown. */
  close(): void {
    this.db.close();
  }
}
