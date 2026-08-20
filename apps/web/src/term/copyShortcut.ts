/**
 * Pure decision logic for Terminal.tsx's Cmd/Ctrl+C handling — BridgeSpace
 * parity item 3: "copyable drag-selection inside mouse-tracking TUIs"
 * (claude, htop, etc).
 *
 * The actual selection trick lives entirely in xterm.js itself, not here:
 * when a full-screen app (claude, htop, vim...) turns on mouse tracking,
 * xterm forwards mouse events to that app's pty instead of running its own
 * text selection, so there's normally nothing for "Copy" to read. xterm.js
 * already ships a documented bypass for exactly this — its
 * `SelectionService.shouldForceSelection` treats a mousedown/drag as a
 * request for a REAL xterm selection (never forwarded to the app) whenever
 * a modifier is held: Option/Alt on Mac (once `macOptionClickForcesSelection`
 * is turned on — see the `new XTerm({...})` options in Terminal.tsx's main
 * effect) or Shift everywhere else (xterm's own unconditional default,
 * nothing to opt into). Once that selection exists, `term.getSelection()`
 * — already used by the right-click "Copy" menu item (`handleCopy`) — just
 * works, because it's a completely ordinary xterm selection, not a special
 * case.
 *
 * What WAS missing: a keyboard shortcut. This app never bound Cmd/Ctrl+C to
 * anything before this — the right-click menu was the only way to copy.
 * That's what this module decides: whether a given keydown should copy the
 * current selection instead of being left to reach the pty as a literal
 * Ctrl+C (the interrupt signal every shell/CLI expects). Extracted as a
 * pure function of plain booleans (not a raw `KeyboardEvent`, and not
 * reading `term.hasSelection()` itself) purely so `copyShortcut.test.ts`
 * can exercise every combination — mac vs. non-mac, held vs. not, selection
 * vs. none — without a browser or an xterm.js instance.
 */
export interface CopyShortcutInput {
  /** `KeyboardEvent.key`, as-is (case is normalized inside this function). */
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** `term.hasSelection()` at the moment the key was pressed. */
  hasSelection: boolean;
  /** Whether this is running on a Mac (`isMacPlatform()`) — decides which
   * modifier counts as "the" copy modifier: Cmd on Mac, Ctrl elsewhere. */
  isMac: boolean;
}

/**
 * True if this keydown should copy the terminal's current selection to the
 * clipboard (and be swallowed — never reach the pty as a literal Ctrl+C).
 *
 * Deliberately gated on `hasSelection`: with NO selection, Ctrl+C must keep
 * behaving exactly as it always has (the interrupt signal) — this function
 * only ever claims the "copy" meaning of the chord, never the "interrupt"
 * one, so a shell mid-command is never left with no way to Ctrl-C out of it.
 * On Mac this also means Cmd+C is simply a no-op with no selection, same as
 * it was before this feature existed (Cmd+C was never wired to anything).
 */
export function isCopyShortcut(input: CopyShortcutInput): boolean {
  if (input.key.toLowerCase() !== "c") return false;
  // Shift/Alt-C are reserved for other things (and Alt is the very modifier
  // Item 3 above uses to force a selection in the first place) — only the
  // bare platform-copy modifier counts.
  if (input.shiftKey || input.altKey) return false;
  const modifierHeld = input.isMac ? input.metaKey : input.ctrlKey;
  if (!modifierHeld) return false;
  return input.hasSelection;
}
