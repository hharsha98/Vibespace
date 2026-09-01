/**
 * BoardStore: the only place in the server that speaks SQL for board cards
 * (Phase 7). Routes call these methods and get back plain `BoardCard`
 * objects (the shared protocol type) — same "no row shapes leak past this
 * file" rule as `WorkspaceStore`.
 *
 * --- Why fractional positions instead of integer row order ---
 * A naive "position = row index, renumber every card on every drag" scheme
 * means every drag-and-drop reorder rewrites every OTHER card in the
 * column too — more writes than necessary, and racier under concurrent
 * drags from two browser tabs. Instead each card's `position` is a plain
 * REAL number, and a card dropped between two neighbours just gets the
 * neighbours' midpoint (`(before + after) / 2`) — no other row is touched.
 *
 * The one thing that scheme can't do forever is bisect the SAME gap
 * infinitely: repeatedly inserting into the same shrinking gap eventually
 * produces two positions close enough that floating-point can't represent
 * a distinct midpoint between them anymore. `renormalizeIfNeeded` guards
 * against that: after any write that changes a column's positions, it
 * checks whether any two adjacent cards' positions are closer than
 * `MIN_GAP`, and if so, re-spaces the WHOLE column back out to clean
 * integer multiples of `POSITION_GAP` (preserving order) so bisection has
 * room to work again.
 */
import type { Database } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { AgentId, BoardCard, CardPriority, ColumnId } from "@vibespace/shared";
import { openDatabase } from "./schema.js";

/** The raw shape a row comes back as from better-sqlite3 (snake_case, as SQLite gave it to us). */
interface BoardCardRow {
  id: string;
  workspace_id: string;
  title: string;
  description: string | null;
  priority: string;
  column_id: string;
  position: number;
  session_id: string | null;
  agent: string | null;
  created_at: string;
  updated_at: string;
  task_knowledge: string | null;
}

function rowToCard(row: BoardCardRow): BoardCard {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    description: row.description,
    taskKnowledge: row.task_knowledge,
    priority: row.priority as CardPriority,
    columnId: row.column_id as ColumnId,
    position: row.position,
    sessionId: row.session_id,
    agent: row.agent as AgentId | null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateCardOptions {
  workspaceId: string;
  title: string;
  description?: string | null;
  /** Long-form context separate from `description` — see `BoardCard`'s
   * doc comment in `packages/shared/src/protocol.ts`. Length limits are
   * enforced by the caller (the REST/MCP route), not here — same division
   * of responsibility as `title`'s emptiness check. */
  taskKnowledge?: string | null;
  priority?: CardPriority;
  /** Defaults to "todo" — a freshly-created card always starts in the first column. */
  columnId?: ColumnId;
}

export interface UpdateCardOptions {
  title?: string;
  description?: string | null;
  taskKnowledge?: string | null;
  priority?: CardPriority;
  columnId?: ColumnId;
  /** Explicit fractional position, e.g. the midpoint of the two cards this
   * one was dropped between. If omitted while `columnId` changes, the card
   * is appended to the end of the new column instead. */
  position?: number;
  sessionId?: string | null;
  agent?: AgentId | null;
}

/** Spacing between freshly-appended cards' positions. Arbitrary but large
 * enough that a column can be bisected many times over before any gap
 * between two cards gets uncomfortably small. */
const POSITION_GAP = 1000;

/**
 * Below this gap, two adjacent positions are too close for another
 * bisection to be meaningful — `(a + b) / 2` would either round back to one
 * of the endpoints or land indistinguishably close to it. Any write that
 * leaves a column with a gap this small triggers `renormalizeIfNeeded`.
 */
const MIN_GAP = 1e-6;

export class BoardStore {
  private db: Database;

  /** Defaults to a fresh `openDatabase()` call; tests/callers may inject
   * their own handle (e.g. one opened against a temp-dir db) if needed. */
  constructor(db: Database = openDatabase()) {
    this.db = db;
  }

  /** Every card for a workspace, sorted column-then-position — already in
   * the shape a caller can group by `columnId` and render directly. */
  list(workspaceId: string): BoardCard[] {
    const rows = this.db
      .prepare(`SELECT * FROM board_cards WHERE workspace_id = ? ORDER BY column_id ASC, position ASC`)
      .all(workspaceId) as BoardCardRow[];
    return rows.map(rowToCard);
  }

  get(id: string): BoardCard | undefined {
    const row = this.db.prepare("SELECT * FROM board_cards WHERE id = ?").get(id) as
      | BoardCardRow
      | undefined;
    return row ? rowToCard(row) : undefined;
  }

  create(options: CreateCardOptions): BoardCard {
    const id = randomUUID();
    const now = new Date().toISOString();
    const columnId = options.columnId ?? "todo";
    const priority = options.priority ?? "medium";
    const position = this.nextPositionInColumn(options.workspaceId, columnId);

    this.db
      .prepare(
        `INSERT INTO board_cards
           (id, workspace_id, title, description, priority, column_id, position, session_id, agent, created_at, updated_at, task_knowledge)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`
      )
      .run(
        id,
        options.workspaceId,
        options.title,
        options.description ?? null,
        priority,
        columnId,
        position,
        now,
        now,
        options.taskKnowledge ?? null
      );

    // Re-read rather than constructing the object by hand, same reasoning
    // as WorkspaceStore.create — always reflects exactly what SQLite stored.
    return this.get(id)!;
  }

  /** Returns the updated card, or undefined if `id` doesn't exist. */
  update(id: string, patch: UpdateCardOptions): BoardCard | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;

    const title = patch.title ?? existing.title;
    // `description`/`sessionId`/`agent` are all allowed to be explicitly
    // cleared to null, so — same as WorkspaceStore's `layout` — only fall
    // back to the existing value when the caller didn't mention the field
    // at all, not whenever the new value is falsy.
    const description = "description" in patch ? (patch.description ?? null) : existing.description;
    const taskKnowledge = "taskKnowledge" in patch ? (patch.taskKnowledge ?? null) : existing.taskKnowledge;
    const priority = patch.priority ?? existing.priority;
    const columnId = patch.columnId ?? existing.columnId;
    const changingColumn = patch.columnId !== undefined && patch.columnId !== existing.columnId;

    let position: number;
    if (patch.position !== undefined) {
      position = patch.position;
    } else if (changingColumn) {
      // Moved to a different column with no explicit drop position given
      // (e.g. a "Dispatch" button, not a drag-and-drop) — land at the end.
      position = this.nextPositionInColumn(existing.workspaceId, columnId);
    } else {
      position = existing.position;
    }

    const sessionId = "sessionId" in patch ? (patch.sessionId ?? null) : existing.sessionId;
    const agent = "agent" in patch ? (patch.agent ?? null) : existing.agent;
    const now = new Date().toISOString();

    this.db
      .prepare(
        `UPDATE board_cards
         SET title = ?, description = ?, priority = ?, column_id = ?, position = ?, session_id = ?, agent = ?, updated_at = ?, task_knowledge = ?
         WHERE id = ?`
      )
      .run(title, description, priority, columnId, position, sessionId, agent, now, taskKnowledge, id);

    // Only a column/position change can possibly have shrunk a gap, so only
    // bother checking then — every other field edit can't affect ordering.
    if (patch.position !== undefined || changingColumn) {
      this.renormalizeIfNeeded(existing.workspaceId, columnId);
    }

    return this.get(id);
  }

  /**
   * The drag-and-drop entry point: move a card to (possibly a different)
   * column at a specific fractional position. `position` is normally the
   * midpoint of the two cards it was dropped between — computed by the
   * caller from `list()`'s neighbours, since only the caller (the REST
   * route) knows where in the UI the card was actually dropped. Thin
   * wrapper around `update()` so both entry points share one renormalize
   * guard instead of two copies of it.
   */
  move(id: string, columnId: ColumnId, position: number): BoardCard | undefined {
    return this.update(id, { columnId, position });
  }

  /** True if a card with this id existed and was removed. */
  remove(id: string): boolean {
    const result = this.db.prepare("DELETE FROM board_cards WHERE id = ?").run(id);
    return result.changes > 0;
  }

  /** Closes the underlying database handle. Call on server shutdown. */
  close(): void {
    this.db.close();
  }

  /** Position for a freshly-appended card: one `POSITION_GAP` past the
   * current last card in that column, or `POSITION_GAP` if it's empty. */
  private nextPositionInColumn(workspaceId: string, columnId: ColumnId): number {
    const row = this.db
      .prepare(`SELECT MAX(position) as maxPos FROM board_cards WHERE workspace_id = ? AND column_id = ?`)
      .get(workspaceId, columnId) as { maxPos: number | null };
    return (row.maxPos ?? 0) + POSITION_GAP;
  }

  /**
   * Re-spaces every card in `columnId` back out to clean, widely-separated
   * positions (`POSITION_GAP`, `2 * POSITION_GAP`, ...) IF any two adjacent
   * cards' positions have collapsed to within `MIN_GAP` of each other.
   * Existing relative order is always preserved exactly; this only ever
   * rewrites the `position` column, never which column a card is in.
   */
  private renormalizeIfNeeded(workspaceId: string, columnId: ColumnId): void {
    const rows = this.db
      .prepare(
        `SELECT id, position FROM board_cards WHERE workspace_id = ? AND column_id = ? ORDER BY position ASC, id ASC`
      )
      .all(workspaceId, columnId) as { id: string; position: number }[];

    const needsRenormalize = rows.some((row, i) => i > 0 && row.position - rows[i - 1].position < MIN_GAP);
    if (!needsRenormalize) return;

    const now = new Date().toISOString();
    const stmt = this.db.prepare(`UPDATE board_cards SET position = ?, updated_at = ? WHERE id = ?`);
    const renumber = this.db.transaction((cards: { id: string; position: number }[]) => {
      cards.forEach((row, i) => {
        stmt.run((i + 1) * POSITION_GAP, now, row.id);
      });
    });
    renumber(rows);
  }
}
