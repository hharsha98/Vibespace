import { describe, expect, it } from "vitest";
import { KEYMAP, formatShortcut, matchShortcut, type KeyEventLike } from "./keymap.js";

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

  it("matches Cmd+Shift+W to close-pane, but plain Cmd+W matches nothing", () => {
    expect(matchShortcut(key({ key: "w", metaKey: true, shiftKey: true }), true)).toBe("close-pane");
    expect(matchShortcut(key({ key: "w", metaKey: true }), true)).toBeNull();
  });

  it("matches Cmd+D to split-row and Cmd+Shift+D to split-column", () => {
    expect(matchShortcut(key({ key: "d", metaKey: true }), true)).toBe("split-row");
    expect(matchShortcut(key({ key: "d", metaKey: true, shiftKey: true }), true)).toBe("split-column");
  });

  it("maps Cmd+1..Cmd+9 to focus-pane-1..focus-pane-9, each with the right 0-based paneIndex", () => {
    for (let n = 1; n <= 9; n++) {
      const id = matchShortcut(key({ key: String(n), metaKey: true }), true);
      expect(id).toBe(`focus-pane-${n}`);
      const shortcut = KEYMAP.find((s) => s.id === id);
      expect(shortcut?.paneIndex).toBe(n - 1);
    }
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
});

describe("KEYMAP", () => {
  it("has a unique id for every shortcut", () => {
    const ids = KEYMAP.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
