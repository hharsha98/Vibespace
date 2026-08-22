import { describe, expect, it } from "vitest";
import {
  KEYMAP,
  formatShortcut,
  hasDesktopMarker,
  isTauriApp,
  matchShortcut,
  type KeyEventLike,
} from "./keymap.js";

/** Builds a full `KeyEventLike` from just the fields a test cares about. */
function key(overrides: Partial<KeyEventLike> & { key: string }): KeyEventLike {
  return { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...overrides };
}

describe("matchShortcut", () => {
  it("matches Cmd+K to the command palette on Mac", () => {
    expect(matchShortcut(key({ key: "k", metaKey: true }), true)).toBe("command-palette");
  });

  it("matches Cmd+Shift+N to new-pane, but plain Cmd+N matches nothing", () => {
    expect(matchShortcut(key({ key: "n", metaKey: true, shiftKey: true }), true)).toBe("new-pane");
    expect(matchShortcut(key({ key: "n", metaKey: true }), true)).toBeNull();
  });

  it("matches Cmd+Shift+W to close-pane, and plain Cmd+W to close-workspace-tab", () => {
    expect(matchShortcut(key({ key: "w", metaKey: true, shiftKey: true }), true)).toBe("close-pane");
    // Unlike new-pane's plain-⌘N alias (which only matches when isDesktop is
    // true), close-workspace-tab is a real KEYMAP entry in its own right —
    // it matches here regardless of isDesktop. Whether the keystroke ever
    // REACHES this matcher in a real browser tab is a separate story (the
    // browser itself reserves plain ⌘W and never dispatches the keydown at
    // all — see keymap.ts's top comment), not something matchShortcut needs
    // to account for.
    expect(matchShortcut(key({ key: "w", metaKey: true }), true)).toBe("close-workspace-tab");
  });

  it("matches Cmd+D to split-row and Cmd+Shift+D to split-column", () => {
    expect(matchShortcut(key({ key: "d", metaKey: true }), true)).toBe("split-row");
    expect(matchShortcut(key({ key: "d", metaKey: true, shiftKey: true }), true)).toBe("split-column");
  });

  it("maps plain Cmd+1..Cmd+9 to workspace-tab-1..workspace-tab-9, each with the right 0-based workspaceIndex", () => {
    for (let n = 1; n <= 9; n++) {
      const id = matchShortcut(key({ key: String(n), metaKey: true }), true);
      expect(id).toBe(`workspace-tab-${n}`);
      const shortcut = KEYMAP.find((s) => s.id === id);
      expect(shortcut?.workspaceIndex).toBe(n - 1);
    }
  });

  it("maps Cmd+Option+1..Cmd+Option+9 to focus-pane-1..focus-pane-9, each with the right 0-based paneIndex", () => {
    for (let n = 1; n <= 9; n++) {
      const id = matchShortcut(key({ key: String(n), metaKey: true, altKey: true }), true);
      expect(id).toBe(`focus-pane-${n}`);
      const shortcut = KEYMAP.find((s) => s.id === id);
      expect(shortcut?.paneIndex).toBe(n - 1);
    }
  });

  it("plain Cmd+1 does NOT match focus-pane-1 — Alt is required now that plain digits mean workspace tabs", () => {
    expect(matchShortcut(key({ key: "1", metaKey: true }), true)).not.toBe("focus-pane-1");
  });

  it("matches Cmd+] and Cmd+[ to cycling focus", () => {
    expect(matchShortcut(key({ key: "]", metaKey: true }), true)).toBe("cycle-focus-next");
    expect(matchShortcut(key({ key: "[", metaKey: true }), true)).toBe("cycle-focus-prev");
  });

  it("matches Cmd+Shift+T to the theme picker", () => {
    expect(matchShortcut(key({ key: "t", metaKey: true, shiftKey: true }), true)).toBe("theme-picker");
  });

  it("matches Cmd+Shift+Return to maximize-pane, but plain Cmd+Return matches nothing", () => {
    expect(matchShortcut(key({ key: "Enter", metaKey: true, shiftKey: true }), true)).toBe("maximize-pane");
    expect(matchShortcut(key({ key: "Enter", metaKey: true }), true)).toBeNull();
  });

  it("matches Cmd+Up and Cmd+Down to previous/next command block", () => {
    expect(matchShortcut(key({ key: "ArrowUp", metaKey: true }), true)).toBe("prev-block");
    expect(matchShortcut(key({ key: "ArrowDown", metaKey: true }), true)).toBe("next-block");
    // Shift held should NOT match — these shortcuts don't use Shift.
    expect(matchShortcut(key({ key: "ArrowUp", metaKey: true, shiftKey: true }), true)).toBeNull();
  });

  it("on non-Mac, Ctrl substitutes for Cmd and Cmd does not match", () => {
    expect(matchShortcut(key({ key: "k", ctrlKey: true }), false)).toBe("command-palette");
    expect(matchShortcut(key({ key: "k", metaKey: true }), false)).toBeNull();
  });

  it("on Mac, Ctrl does not substitute for Cmd", () => {
    expect(matchShortcut(key({ key: "k", ctrlKey: true }), true)).toBeNull();
  });

  it("rejects a combo that holds both modifiers at once", () => {
    expect(matchShortcut(key({ key: "k", metaKey: true, ctrlKey: true }), true)).toBeNull();
  });

  it("rejects a combo that also holds Alt", () => {
    expect(matchShortcut(key({ key: "d", metaKey: true, altKey: true }), true)).toBeNull();
  });

  it("returns null for unknown combos and for the bare key with no modifier", () => {
    expect(matchShortcut(key({ key: "z", metaKey: true }), true)).toBeNull();
    expect(matchShortcut(key({ key: "k" }), true)).toBeNull();
  });

  it("matches Cmd+G/E/B, Cmd+Shift+K, and Cmd+Shift+G to the five centre-column view switchers", () => {
    expect(matchShortcut(key({ key: "g", metaKey: true }), true)).toBe("view-terminals");
    expect(matchShortcut(key({ key: "e", metaKey: true }), true)).toBe("view-editor");
    expect(matchShortcut(key({ key: "b", metaKey: true }), true)).toBe("view-preview");
    expect(matchShortcut(key({ key: "k", metaKey: true, shiftKey: true }), true)).toBe(
      "view-board"
    );
    expect(matchShortcut(key({ key: "g", metaKey: true, shiftKey: true }), true)).toBe(
      "view-graph"
    );
  });

  it("matches Cmd+S to view-swarm", () => {
    expect(matchShortcut(key({ key: "s", metaKey: true }), true)).toBe("view-swarm");
  });

  it("does not bind Cmd+J, which Chrome reserves for itself", () => {
    // The board was originally on Cmd+J. Chrome intercepts it before the
    // page ever sees the keydown, so the board never opened — the same trap
    // as Cmd+N/W/T. Asserted here so nobody "simplifies" it back.
    expect(matchShortcut(key({ key: "j", metaKey: true }), true)).toBeNull();
  });

  it("matches Cmd+P to quick-open", () => {
    expect(matchShortcut(key({ key: "p", metaKey: true }), true)).toBe("quick-open");
  });

  describe("isDesktop (Phase 11a: the plain forms Chrome reserves)", () => {
    it("matches plain Cmd+N when isDesktop is true, on top of the Shift form still matching", () => {
      expect(matchShortcut(key({ key: "n", metaKey: true }), true, true)).toBe("new-pane");
      expect(matchShortcut(key({ key: "n", metaKey: true, shiftKey: true }), true, true)).toBe("new-pane");
    });

    it("still rejects plain Cmd+N when isDesktop is false (the default) — the browser build is unaffected", () => {
      expect(matchShortcut(key({ key: "n", metaKey: true }), true)).toBeNull();
    });

    it("does NOT extend the plain-form exception to shortcuts outside the reserved set, e.g. split-column stays Shift-only", () => {
      expect(matchShortcut(key({ key: "d", metaKey: true, shiftKey: true }), true, true)).toBe("split-column");
      // Plain Cmd+D is (and stays) split-row, never split-column, even on desktop.
      expect(matchShortcut(key({ key: "d", metaKey: true }), true, true)).toBe("split-row");
    });

    it("plain Cmd+W/Cmd+T match close-workspace-tab/new-workspace-tab the same regardless of isDesktop — they're real KEYMAP entries, not a plain-form alias of close-pane/theme-picker anymore", () => {
      expect(matchShortcut(key({ key: "w", metaKey: true }), true, false)).toBe("close-workspace-tab");
      expect(matchShortcut(key({ key: "w", metaKey: true }), true, true)).toBe("close-workspace-tab");
      expect(matchShortcut(key({ key: "t", metaKey: true }), true, false)).toBe("new-workspace-tab");
      expect(matchShortcut(key({ key: "t", metaKey: true }), true, true)).toBe("new-workspace-tab");
    });
  });

  describe("workspace-tab shortcuts (Cmd+T/Cmd+W/Cmd+1-9, matching BridgeSpace's documented set)", () => {
    it("matches plain Cmd+T to new-workspace-tab and plain Cmd+W to close-workspace-tab", () => {
      expect(matchShortcut(key({ key: "t", metaKey: true }), true)).toBe("new-workspace-tab");
      expect(matchShortcut(key({ key: "w", metaKey: true }), true)).toBe("close-workspace-tab");
    });

    it("Shift+T/Shift+W still reach theme-picker/close-pane, unaffected by the new plain bindings", () => {
      expect(matchShortcut(key({ key: "t", metaKey: true, shiftKey: true }), true)).toBe("theme-picker");
      expect(matchShortcut(key({ key: "w", metaKey: true, shiftKey: true }), true)).toBe("close-pane");
    });
  });
});

describe("hasDesktopMarker", () => {
  it("is true only for the exact ?vibedeckDesktop=1 marker the desktop wrapper appends", () => {
    expect(hasDesktopMarker("?vibedeckDesktop=1")).toBe(true);
    expect(hasDesktopMarker("?foo=bar&vibedeckDesktop=1")).toBe(true);
  });

  it("is false for a plain browser URL, an unrelated query string, or a wrong/empty value", () => {
    expect(hasDesktopMarker("")).toBe(false);
    expect(hasDesktopMarker("?foo=bar")).toBe(false);
    expect(hasDesktopMarker("?vibedeckDesktop=0")).toBe(false);
    expect(hasDesktopMarker("?vibedeckDesktop=true")).toBe(false);
  });
});

describe("isTauriApp", () => {
  it("returns false in a non-browser environment (no window global, as in this Vitest/Node run)", () => {
    expect(isTauriApp()).toBe(false);
  });
});

describe("formatShortcut", () => {
  it("renders Mac symbols", () => {
    const paletteShortcut = KEYMAP.find((s) => s.id === "command-palette")!;
    expect(formatShortcut(paletteShortcut, true)).toBe("⌘K");

    const newPaneShortcut = KEYMAP.find((s) => s.id === "new-pane")!;
    expect(formatShortcut(newPaneShortcut, true)).toBe("⌘⇧N");
  });

  it("renders a Ctrl+Shift+ word form on non-Mac", () => {
    const newPaneShortcut = KEYMAP.find((s) => s.id === "new-pane")!;
    expect(formatShortcut(newPaneShortcut, false)).toBe("Ctrl+Shift+N");

    const paletteShortcut = KEYMAP.find((s) => s.id === "command-palette")!;
    expect(formatShortcut(paletteShortcut, false)).toBe("Ctrl+K");
  });

  it("renders the maximize-pane shortcut as ⌘⇧Return / Ctrl+Shift+Return", () => {
    const maximizeShortcut = KEYMAP.find((s) => s.id === "maximize-pane")!;
    expect(formatShortcut(maximizeShortcut, true)).toBe("⌘⇧Return");
    expect(formatShortcut(maximizeShortcut, false)).toBe("Ctrl+Shift+Return");
  });

  it("renders the block-navigation shortcuts with arrow glyphs", () => {
    const prevBlock = KEYMAP.find((s) => s.id === "prev-block")!;
    const nextBlock = KEYMAP.find((s) => s.id === "next-block")!;
    expect(formatShortcut(prevBlock, true)).toBe("⌘↑");
    expect(formatShortcut(nextBlock, true)).toBe("⌘↓");
    expect(formatShortcut(prevBlock, false)).toBe("Ctrl+↑");
    expect(formatShortcut(nextBlock, false)).toBe("Ctrl+↓");
  });

  it("renders the Alt/Option modifier for the focus-pane-N shortcuts", () => {
    const focusPane1 = KEYMAP.find((s) => s.id === "focus-pane-1")!;
    expect(formatShortcut(focusPane1, true)).toBe("⌘⌥1");
    expect(formatShortcut(focusPane1, false)).toBe("Ctrl+Alt+1");
  });

  it("renders the plain workspace-tab shortcuts with no extra modifier glyph", () => {
    const workspaceTab1 = KEYMAP.find((s) => s.id === "workspace-tab-1")!;
    expect(formatShortcut(workspaceTab1, true)).toBe("⌘1");
    expect(formatShortcut(workspaceTab1, false)).toBe("Ctrl+1");
  });
});

describe("KEYMAP", () => {
  it("has a unique id for every shortcut", () => {
    const ids = KEYMAP.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // This is the test that would have caught the original ⌘T collision
  // (theme-picker's desktop-only plain alias vs. a hypothetical new
  // workspace-tab action both claiming plain ⌘T) — every shortcut's
  // key+shift+alt combination must be unique, or two actions would race for
  // the same keystroke and `matchShortcut` would silently only ever return
  // whichever one happens to appear first in the array.
  it("has no two actions sharing the same key+shift+alt combination", () => {
    const combos = new Map<string, string[]>();
    for (const shortcut of KEYMAP) {
      const combo = `${shortcut.key.toLowerCase()}|shift:${Boolean(shortcut.shift)}|alt:${Boolean(shortcut.alt)}`;
      const ids = combos.get(combo) ?? [];
      ids.push(shortcut.id);
      combos.set(combo, ids);
    }
    const collisions = [...combos.entries()].filter(([, ids]) => ids.length > 1);
    expect(collisions).toEqual([]);
  });
});
