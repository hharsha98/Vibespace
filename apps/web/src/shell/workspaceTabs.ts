/**
 * Pure logic behind the top-bar workspace tab strip (workspace switching
 * moved from the left rail to top-bar tabs, matching BridgeSpace — see
 * `WorkspaceTabs.tsx`, which renders this, and `FileSidebar.tsx`'s own top
 * comment for what replaced `WorkspaceRail.tsx` in the left sidebar).
 *
 * Kept DOM-free so it's unit-testable under plain vitest — this package has
 * no jsdom/testing-library dependency at all (see `keys/keymap.ts`'s top
 * comment for the established reason why that shapes how things get
 * tested here). Same "logic in its own pure module, component just renders
 * it" split `term/fitIfVisible.ts` and `settings/sections.ts` already use.
 */
import type { Workspace } from "@vibespace/shared";

/** One tab's derived display data — a thin, testable projection of a
 * `Workspace`. Tab order is exactly `workspaces`' own order (the order the
 * server returns them in, i.e. creation order); nothing here re-sorts, so a
 * workspace's tab position never surprises anyone who already knows where
 * it sits in, say, the command palette's "Switch to workspace" list. */
export interface WorkspaceTab {
  id: string;
  name: string;
  /** The workspace's chosen colour, or null if it never set one — the tab
   * strip falls back to the theme's neutral accent for null, same fallback
   * the old rail's `ListRow` `accentColor` prop already used. */
  color: string | null;
}

/** Projects the raw `Workspace[]` (as held in App.tsx state) into the
 * tab strip's own display shape. A pure map — no sorting, filtering, or
 * deduplication — so the derivation can never silently drop or reorder a
 * workspace the caller doesn't expect. */
export function deriveWorkspaceTabs(workspaces: readonly Workspace[]): WorkspaceTab[] {
  return workspaces.map((w) => ({ id: w.id, name: w.name, color: w.color }));
}

/**
 * Maps a 1-based tab index (Cmd+1 -> 1, Cmd+9 -> 9, per keymap.ts's
 * `workspace-tab-N` shortcuts) to the workspace id sitting at that position
 * in the tab strip, or `null` when there's no tab there — e.g. Cmd+7 with
 * only 3 workspaces open does nothing, rather than crashing on
 * `workspaces[6]` being `undefined`. Also guards non-integer/zero/negative
 * `n`, even though every real caller only ever passes 1-9, so a future
 * caller can't accidentally index off the front of the array either.
 */
export function workspaceIdForTabIndex(workspaces: readonly Workspace[], n: number): string | null {
  if (!Number.isInteger(n) || n < 1 || n > workspaces.length) return null;
  return workspaces[n - 1].id;
}

/**
 * Roving-focus arithmetic for the tab strip's `role="tablist"` keyboard
 * handling (WAI-ARIA APG's horizontal-tabs pattern: ArrowLeft/ArrowRight
 * move between tabs, Home/End jump to the ends) — the same shape as
 * `settings/sections.ts`'s `nextRailIndex` for the (vertical) Settings
 * rail, just Left/Right instead of Up/Down since this tablist is
 * horizontal, not vertical, and mirroring `Settings.tsx`'s own
 * "selection follows focus" handling (see that file's `handleRailKeyDown`).
 *
 * Returns the new index to focus/select, or `null` if `key` isn't one this
 * tablist handles (the caller should fall through to default browser
 * behaviour in that case).
 */
export function nextTabIndex(current: number, key: string, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowRight":
      return (current + 1) % count;
    case "ArrowLeft":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
