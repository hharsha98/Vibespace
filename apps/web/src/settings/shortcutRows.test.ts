import { describe, expect, it } from "vitest";
import { KEYMAP, formatShortcut } from "../keys/keymap.js";
import { getShortcutRows } from "./shortcutRows.js";

describe("getShortcutRows", () => {
  it("derives one row per non-collapsed KEYMAP entry, plus the hand-added search row", () => {
    const collapsedCount = KEYMAP.filter((s) => s.paneIndex === undefined || s.paneIndex === 0).length;
    const rows = getShortcutRows(KEYMAP, true);
    expect(rows.length).toBe(collapsedCount + 1);
  });

  it("collapses the nine focus-pane shortcuts into a single row", () => {
    const rows = getShortcutRows(KEYMAP, true);
    const focusRow = rows.find((r) => r.id === "focus-pane-1");
    expect(focusRow).toBeDefined();
    expect(focusRow?.label).toBe("Focus pane 1–9");
    expect(focusRow?.keyDisplay).toBe("⌘1 … ⌘9");
    // None of the other eight collapse into their own row.
    for (let i = 2; i <= 9; i++) {
      expect(rows.find((r) => r.id === `focus-pane-${i}`)).toBeUndefined();
    }
  });

  it("includes the hand-added, not-in-KEYMAP terminal search row", () => {
    const rows = getShortcutRows(KEYMAP, true);
    const searchRow = rows.find((r) => r.id === "search-in-terminal");
    expect(searchRow).toEqual({ id: "search-in-terminal", label: "Search in terminal", keyDisplay: "⌘F" });
  });

  it("formats every other row's key EXACTLY as formatShortcut would — the guarantee that would fail if someone hand-typed the table instead of deriving it", () => {
    const isMac = false;
    const rows = getShortcutRows(KEYMAP, isMac);
    for (const shortcut of KEYMAP) {
      if (shortcut.paneIndex !== undefined && shortcut.paneIndex !== 0) continue; // collapsed, checked above
      const row = rows.find((r) => r.id === shortcut.id);
      expect(row, `row for KEYMAP id "${shortcut.id}" should exist`).toBeDefined();
      if (shortcut.paneIndex === 0) continue; // the collapsed row, checked above
      expect(row?.label).toBe(shortcut.label);
      expect(row?.keyDisplay).toBe(formatShortcut(shortcut, isMac));
    }
  });

  it("reflects a KEYMAP that gains a new shortcut — proof the row list can't silently drift from KEYMAP", () => {
    const extended = [
      ...KEYMAP,
      { id: "made-up-for-this-test", label: "Made up", description: "test only", key: "z" },
    ];
    const before = getShortcutRows(KEYMAP, true).length;
    const after = getShortcutRows(extended, true).length;
    expect(after).toBe(before + 1);
  });
});
