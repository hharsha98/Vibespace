/**
 * The app's keyboard shortcut table, plus pure matching/formatting helpers.
 *
 * Why this file has ZERO DOM in it (no `KeyboardEvent`, no `navigator`
 * used at module scope): CI runs on ubuntu-latest with no browser, so
 * `keymap.test.ts` needs to exercise `matchShortcut` with plain object
 * literals in Node. `matchShortcut` therefore takes `KeyEventLike` — a
 * minimal structural type with just the four fields we actually read off a
 * real `KeyboardEvent` — instead of the DOM type itself. Any real
 * `KeyboardEvent` satisfies this type automatically (structural typing), so
 * callers in the browser pass the real event straight through.
 *
 * --- Why these specific shortcuts, and not the "obvious" ⌘T/⌘N/⌘W set ---
 *
 * In a browser tab, Cmd+N (new window), Cmd+T (new tab), Cmd+W (close tab),
 * and Cmd+Q (quit) are reserved by the browser chrome itself and CANNOT be
 * intercepted with `preventDefault()` — the page never even sees them.
 * Binding "close pane" to Cmd+W would silently close the user's browser tab
 * (and their running terminal sessions) instead of the pane. So every
 * shortcut below that would collide with a reserved combo uses Shift as an
 * escape hatch instead (Cmd+Shift+N for "new pane", Cmd+Shift+W for "close
 * pane", Cmd+Shift+T for the theme picker) — Chrome does not reserve any of
 * the Shift variants. A future desktop build (Tauri, planned for Phase 11)
 * runs outside the browser chrome and can claim the natural ⌘T/⌘N/⌘W/⌘Q set
 * at that point; this file only needs to change in one place (`KEYMAP`
 * below) when that happens.
 */

/**
 * The minimal shape `matchShortcut` needs from a keyboard event. A real
 * DOM `KeyboardEvent` satisfies this automatically — this exists so the
 * matcher (and its tests) never need to import `KeyboardEvent` or run in a
 * browser/jsdom environment.
 */
export interface KeyEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * One entry in the shortcut table. Shortcuts always use the platform's
 * "primary" modifier (Cmd on Mac, Ctrl elsewhere — see `matchShortcut`),
 * optionally combined with Shift. None of vibedeck's shortcuts use Alt, so
 * there's no `alt` field; `matchShortcut` rejects any event with Alt held,
 * which also keeps macOS's Option-key dead-key/special-character input
 * (e.g. Option+D → ∂) from ever getting misread as one of our combos.
 */
export interface Shortcut {
  /** Stable id used both to match an event and to look up its handler. */
  id: string;
  /** Short label for the command palette / cheat sheet. */
  label: string;
  /** One-line explanation, shown in the cheat sheet. */
  description: string;
  /** The base key, as it appears in `KeyboardEvent.key` (lowercase for letters/digits). */
  key: string;
  /** Whether Shift must also be held. Omitted (falsy) means Shift must be UP. */
  shift?: boolean;
  /**
   * Only set on the nine "focus pane N" shortcuts: the 0-based index (into
   * `listPanes()`'s left-to-right order) that this shortcut focuses. Lets
   * callers (App.tsx, tests) get the index without parsing the id string.
   */
  paneIndex?: number;
}

/**
 * Every keyboard shortcut vibedeck recognises, in the order they're shown
 * in the command palette and cheat sheet. `matchShortcut` below is the only
 * function that ever reads this array to decide what an event means — add
 * a shortcut here and it's automatically matchable, palette-searchable, and
 * cheat-sheet-listed.
 */
export const KEYMAP: readonly Shortcut[] = [
  {
    id: "command-palette",
    label: "Command palette",
    description: "Open the command palette — search every action, workspace, and theme.",
    key: "k",
  },
  {
    id: "split-row",
    label: "Split pane (side by side)",
    description: "Split the focused pane vertically, so the two halves sit side by side.",
    key: "d",
  },
  {
    id: "split-column",
    label: "Split pane (stacked)",
    description: "Split the focused pane horizontally, so the two halves stack.",
    key: "d",
    shift: true,
  },
  {
    id: "new-pane",
    label: "New pane",
    description: "Add a new empty pane to the grid.",
    key: "n",
    shift: true,
  },
  {
    id: "close-pane",
    label: "Close pane",
    description: "Close the focused pane (and its session, if it has one).",
    key: "w",
    shift: true,
  },
  ...Array.from({ length: 9 }, (_, i) => ({
    id: `focus-pane-${i + 1}`,
    label: `Focus pane ${i + 1}`,
    description: `Move focus to pane ${i + 1} (left to right, top to bottom).`,
    key: String(i + 1),
    paneIndex: i,
  })),
  {
    id: "cycle-focus-next",
    label: "Next pane",
    description: "Move focus to the next pane.",
    key: "]",
  },
  {
    id: "cycle-focus-prev",
    label: "Previous pane",
    description: "Move focus to the previous pane.",
    key: "[",
  },
  {
    id: "theme-picker",
    label: "Theme picker",
    description: "Open the theme picker.",
    key: "t",
    shift: true,
  },
  {
    id: "maximize-pane",
    label: "Maximize pane",
    description: "Temporarily expand the focused pane to fill the grid; press again (or Escape) to restore.",
    key: "enter",
    shift: true,
  },
  {
    id: "prev-block",
    label: "Previous command block",
    description: "Scroll the focused pane's terminal to the previous command block (Phase 5, shell panes only).",
    key: "arrowup",
  },
  {
    id: "next-block",
    label: "Next command block",
    description: "Scroll the focused pane's terminal to the next command block (Phase 5, shell panes only).",
    key: "arrowdown",
  },
  // --- Phase 6: centre-column view switcher ---------------------------
  // The centre column is view-switchable (Terminals/Editor/Preview, see
  // App.tsx's `centerView` state) — these three pick which one shows.
  // Deliberately NOT Cmd+1/2/3: those nine combos already mean "focus pane
  // N" (see the `focus-pane-*` block above), and Shift+digit is unreliable
  // across keyboard layouts (Shift+1 reports as "!" in `event.key` on a US
  // layout, not "1" — see matchShortcut's key comparison, which is literal).
  // Plain, unmodified-by-shift letters avoid that AND read as mnemonics —
  // G(rid)/E(ditor)/B(rowser preview). "v" was deliberately avoided for
  // preview despite being the obvious mnemonic: Cmd+V is paste, and
  // useKeyboardShortcuts calls preventDefault() on every match, which would
  // silently break pasting into the terminal, the editor, and every text
  // field in the app.
  {
    id: "view-terminals",
    label: "View: Terminals",
    description: "Show the terminal grid in the centre column.",
    key: "g",
  },
  {
    id: "view-editor",
    label: "View: Editor",
    description: "Show the file editor in the centre column.",
    key: "e",
  },
  {
    id: "view-preview",
    label: "View: Preview",
    description: "Show the browser preview in the centre column.",
    key: "b",
  },
  // Phase 7: the board joins the same centre-column switcher. "b" (the
  // obvious mnemonic) is already Preview and "k" is the command palette.
  //
  // This was originally Cmd+J, which failed exactly the way Cmd+N/W/T do:
  // Chrome claims Cmd+J for itself, so pressing it opened a browser panel
  // and the board never appeared. Found by hand-testing, not assumed.
  // Cmd+Shift+K sits beside the palette's Cmd+K, is not a Chrome binding,
  // and — unlike the plain-letter view keys above — takes Shift precisely
  // because the free unshifted letters here are spoken for by the browser.
  {
    id: "view-board",
    label: "View: Board",
    description: "Show the task board in the centre column.",
    key: "k",
    shift: true,
  },
  {
    id: "quick-open",
    label: "Quick open file",
    description: "Fuzzy-find and open a file from the active workspace.",
    key: "p",
  },
  // Phase 8: the memory Graph joins the same centre-column switcher. "g" is
  // already Terminals (see the view-terminals comment above) — same
  // "unshifted letter already spoken for, so its Shift sibling is free"
  // move Phase 7 made for the board (Cmd+K -> Cmd+Shift+K). Verified by
  // hand in Chrome (not assumed, per this phase's own instruction, after
  // Cmd+J burned an earlier phase): Cmd+Shift+G is Chrome's "Find Previous"
  // binding, but that combo is a no-op with no find session active and
  // does not swallow the keydown before it reaches the page.
  {
    id: "view-graph",
    label: "View: Memory graph",
    description: "Show the memory note graph in the centre column.",
    key: "g",
    shift: true,
  },
  // Phase 9b: the swarm mission canvas joins the same centre-column
  // switcher. "s" (the obvious Swarm mnemonic) is still free — none of the
  // shortcuts above claim it — so unlike Board/Graph (whose natural letters
  // were already taken and had to fall back to their Shift sibling), this
  // one gets the plain unshifted key, same as Terminals/Editor/Preview's
  // G/E/B. Verified by hand in Chrome, same "don't assume, check" discipline
  // as every other shortcut in this table after the Cmd+J trap below.
  {
    id: "view-swarm",
    label: "View: Swarm",
    description: "Show the mission canvas in the centre column.",
    key: "s",
  },
];

/**
 * Is `event` — under platform `isMac` — one of the shortcuts in `KEYMAP`?
 * Returns the matching shortcut's `id`, or `null` if it's not a shortcut
 * vibedeck recognises.
 *
 * The platform split: Mac's primary modifier is Cmd (`metaKey`); every
 * other platform's is Ctrl (`ctrlKey`). A combo only matches if the
 * *correct* primary modifier for the current platform is held AND the
 * *other* one is not — so on Mac, holding Ctrl instead of Cmd never
 * matches (it's a different, real terminal shortcut, e.g. Ctrl+D/EOF), and
 * on non-Mac, holding Cmd (e.g. the Windows key some keyboards map there)
 * never matches either.
 */
export function matchShortcut(event: KeyEventLike, isMac: boolean): string | null {
  if (event.altKey) return null; // none of our shortcuts use Alt — see the Shortcut doc comment

  const primaryHeld = isMac ? event.metaKey : event.ctrlKey;
  const otherModifierHeld = isMac ? event.ctrlKey : event.metaKey;
  if (!primaryHeld || otherModifierHeld) return null;

  const key = event.key.toLowerCase();
  for (const shortcut of KEYMAP) {
    if (shortcut.key.toLowerCase() !== key) continue;
    if (Boolean(shortcut.shift) !== event.shiftKey) continue;
    return shortcut.id;
  }
  return null;
}

/** Keys whose `KeyboardEvent.key` value isn't already the "nice" display form. */
const KEY_DISPLAY_OVERRIDES: Record<string, string> = {
  "[": "[",
  "]": "]",
  enter: "Return",
  arrowup: "↑",
  arrowdown: "↓",
};

/**
 * Renders a shortcut for display (button titles, the palette's right-hand
 * column, the cheat sheet) — e.g. `⌘⇧N` on Mac, `Ctrl+Shift+N` elsewhere.
 */
export function formatShortcut(shortcut: Shortcut, isMac: boolean): string {
  const mod = isMac ? "⌘" : "Ctrl+";
  const shift = shortcut.shift ? (isMac ? "⇧" : "Shift+") : "";
  const keyDisplay = KEY_DISPLAY_OVERRIDES[shortcut.key] ?? shortcut.key.toUpperCase();
  return `${mod}${shift}${keyDisplay}`;
}

/**
 * True on macOS. Reads `navigator` lazily (only when actually called, never
 * at module scope) so importing this file is safe in Node/vitest, where
 * `navigator` doesn't exist at all.
 */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  // `navigator.platform` is deprecated but still the most reliable signal
  // available without a permissions prompt; userAgent is the fallback for
  // browsers that have started blanking `platform`.
  const platform = navigator.platform || navigator.userAgent || "";
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}
