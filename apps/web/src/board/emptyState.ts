/**
 * Pure logic behind the board's two distinct empty-column treatments
 * (docs/DESIGN.md §5 "Column header"/"Board card"; premium-pass round 2's
 * own brief: "'first run' and 'you finished everything' are different
 * feelings and should not look identical"). No DOM, no React — same
 * "keep the decision testable under plain Node/vitest" discipline as
 * `shell/ui.tsx`'s `sessionStatusKind` — so `emptyState.test.ts` can
 * exercise every case without a browser.
 */
import type { ColumnId } from "@vibedeck/shared";

/**
 * The three ways a column can render:
 *  - `"none"` — it has cards; render them normally.
 *  - `"invite"` — the ENTIRE board has zero cards anywhere, and this is the
 *    To Do column: a real call-to-action ("this is where work starts"),
 *    since To Do is the one column a first-time user should actually act on.
 *  - `"resting"` — either (a) the whole board is empty and this ISN'T To Do
 *    (nothing to do here yet, but this isn't the column to invite anyone
 *    into), or (b) the board has cards elsewhere and this one column just
 *    happens to be empty right now (the "you finished everything" / "this
 *    stage is just quiet" case). Both render as a quiet, textless glyph —
 *    deliberately the SAME quiet treatment, because by the time a column is
 *    empty for reason (b) the board-level "how this works" explanation has
 *    already served its purpose and shouldn't repeat five times over.
 */
export type ColumnEmptyKind = "none" | "invite" | "resting";

/**
 * Decides how `columnId` (holding `cardCount` cards) should render its
 * empty state, given whether the WHOLE board (every column, not just this
 * one) currently has zero cards. Board.tsx computes `boardIsEmpty` once
 * (`cards.length === 0`) and passes it to every column, so all five stay in
 * agreement about which "feeling" — first run vs. resting — the board is in;
 * a column never has to guess from its own slice alone.
 */
export function columnEmptyKind(columnId: ColumnId, cardCount: number, boardIsEmpty: boolean): ColumnEmptyKind {
  if (cardCount > 0) return "none";
  if (boardIsEmpty && columnId === "todo") return "invite";
  return "resting";
}
