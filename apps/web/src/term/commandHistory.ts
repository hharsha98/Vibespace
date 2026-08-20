/**
 * Pure prefix-matching logic for PromptBar's command-history autocomplete
 * (BridgeSpace parity item 4). Deliberately dumb, per the phase's own
 * instruction: prefix match only, newest-first, no fuzzy matching or
 * ranking. `history` is ALREADY newest-first — it comes straight off
 * `GET /api/command-history` (see `../../server/src/db/command-history.ts`'s
 * `list()`) — so this function only ever filters, it never re-sorts.
 *
 * Kept as its own tiny pure module (no React, no fetch) so
 * `commandHistory.test.ts` can pin down the matching rules directly,
 * independent of PromptBar's own state/keyboard-handling logic.
 */

/** How many suggestions PromptBar's dropdown shows at once — a small,
 * fixed cap so the list never grows into a full-screen wall of matches for
 * a very common short prefix (e.g. typing just "g" in a workspace with 200
 * "git ..." commands in its history). */
export const MAX_SUGGESTIONS = 8;

/**
 * Every entry in `history` that starts with `input` (case-insensitively),
 * in `history`'s own order, capped at `limit`. The command exactly equal
 * to `input` (trimmed) is excluded — once what's typed already matches a
 * history entry exactly, that entry isn't a useful "suggestion" anymore
 * (see `PromptBar.tsx`'s own comment on why this is also what lets Tab/
 * Enter-to-accept quietly stop offering more suggestions right after one
 * is accepted, with no separate "dismiss" bookkeeping needed for that
 * case).
 *
 * Returns `[]` for blank/whitespace-only input — there is nothing useful
 * to prefix-match an empty string against; showing "everything" isn't a
 * suggestion, it's noise.
 */
export function matchCommandHistory(
  history: readonly string[],
  input: string,
  limit: number = MAX_SUGGESTIONS
): string[] {
  const trimmed = input.trim();
  if (trimmed.length === 0) return [];

  const lowerInput = trimmed.toLowerCase();
  const matches: string[] = [];
  for (const command of history) {
    if (command === trimmed) continue;
    if (command.toLowerCase().startsWith(lowerInput)) {
      matches.push(command);
      if (matches.length >= limit) break;
    }
  }
  return matches;
}
