/**
 * Turns `KEYMAP` into the row list Settings.tsx's Shortcuts section (and,
 * before this rail existed, Settings.tsx's own inline JSX) renders — pulled
 * out into its own pure function so `shortcutRows.test.ts` can assert the
 * table is actually DERIVED from `KEYMAP`, the same guarantee this section's
 * own doc comment has always promised ("this list can never drift from
 * what actually works"). A hand-typed table would still compile and still
 * render; only a test that recomputes the expected rows straight from
 * `KEYMAP` itself (as this file's test does) can catch someone quietly
 * breaking that promise later.
 *
 * Collapsing rule: KEYMAP.ts's nine "focus pane N" shortcuts (paneIndex
 * 0..8) collapse into a single "Focus pane 1-9" row instead of nine
 * near-identical ones — the exact same rule KeyboardCheatSheet.tsx already
 * applies, kept in sync here rather than reinvented.
 */
import { KEYMAP, formatShortcut, type Shortcut } from "../keys/keymap.js";

export interface ShortcutRow {
  id: string;
  label: string;
  keyDisplay: string;
}

/** Not in KEYMAP: terminal search is wired directly inside Terminal.tsx's
 * own keydown listener (Cmd/Ctrl+F), not through the matchShortcut/KEYMAP
 * system every other row here is derived from — see Terminal.tsx's search
 * effect. Added by hand here for the same reason KeyboardCheatSheet.tsx
 * also hand-adds it: the table would otherwise silently omit a real,
 * working shortcut just because of where its handler happens to live. */
function searchInTerminalRow(isMac: boolean): ShortcutRow {
  return { id: "search-in-terminal", label: "Search in terminal", keyDisplay: isMac ? "⌘F" : "Ctrl+F" };
}

/** Every row the Shortcuts section shows, in order: KEYMAP's own order
 * (with the nine focus-pane entries collapsed to one), then the one
 * hand-added terminal-search row. */
export function getShortcutRows(keymap: readonly Shortcut[] = KEYMAP, isMac: boolean = false): ShortcutRow[] {
  const rows = keymap
    .filter((s) => s.paneIndex === undefined || s.paneIndex === 0)
    .map((shortcut): ShortcutRow => ({
      id: shortcut.id,
      label: shortcut.paneIndex === 0 ? "Focus pane 1–9" : shortcut.label,
      keyDisplay:
        shortcut.paneIndex === 0 ? (isMac ? "⌘1 … ⌘9" : "Ctrl+1 … Ctrl+9") : formatShortcut(shortcut, isMac),
    }));
  rows.push(searchInTerminalRow(isMac));
  return rows;
}
