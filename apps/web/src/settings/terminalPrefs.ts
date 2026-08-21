/**
 * Terminal display preferences (font size, cursor style/blink, scrollback
 * line count) — genuinely new settings, not a move of something that
 * already existed. Persisted the same try/catch-around-localStorage way as
 * every other preference in this app (themes.ts's loadStoredThemeId/
 * saveThemeId is the canonical pattern).
 *
 * Why this is its own tiny store instead of a prop threaded down App.tsx ->
 * Grid.tsx -> PaneView.tsx -> Terminal.tsx: App.tsx has no state for these
 * today, and there can be many live `<Terminal>` instances at once (one per
 * pane) that all need to hear about a change the instant Settings.tsx saves
 * one — the exact "many independent instances react to one shared change,
 * without prop-drilling through three intermediate components" problem
 * `blockStore.ts` already solved for command blocks (see that file's own
 * top comment). This follows the same shape: a module-level value, a
 * `useSyncExternalStore`-backed hook for reading it reactively, and a save
 * function that updates the value and notifies every subscriber — which is
 * what makes changing font size apply LIVE to panes that are already open,
 * not just to ones created after the change (see Terminal.tsx's own
 * `useTerminalPrefs()` call and the effect that pushes `term.options.*`
 * whenever it changes, the same "push xterm options live, on every change,
 * not just at creation" idiom that file's theme-sync effect already uses).
 */
import { useSyncExternalStore } from "react";

export type CursorStyle = "block" | "underline" | "bar";

export interface TerminalPrefs {
  fontSize: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  scrollback: number;
}

/** Matches the hardcoded values Terminal.tsx used before this preference
 * existed (`cursorBlink: true, scrollback: 10000, fontSize: 13`, plus
 * xterm's own default cursor style) — so turning this file on doesn't
 * silently re-colour or resize any existing terminal until someone
 * actually opens Settings and changes something. */
export const DEFAULT_TERMINAL_PREFS: TerminalPrefs = {
  fontSize: 13,
  cursorStyle: "block",
  cursorBlink: true,
  scrollback: 10000,
};

const MIN_FONT_SIZE = 9;
const MAX_FONT_SIZE = 24;
const MIN_SCROLLBACK = 500;
const MAX_SCROLLBACK = 100_000;

/** Clamps a loaded/edited value back into a sane range — guards against a
 * corrupt localStorage blob (hand-edited, or left over from a future
 * version with a wider range) producing an unusable or runaway terminal. */
export function clampFontSize(value: number): number {
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(value)));
}

export function clampScrollback(value: number): number {
  return Math.min(MAX_SCROLLBACK, Math.max(MIN_SCROLLBACK, Math.round(value)));
}

const CURSOR_STYLES: readonly CursorStyle[] = ["block", "underline", "bar"];

function isCursorStyle(value: unknown): value is CursorStyle {
  return typeof value === "string" && (CURSOR_STYLES as readonly string[]).includes(value);
}

const TERMINAL_PREFS_KEY = "vibedeck.terminalPrefs";

/** Parses a stored blob defensively, field by field — a shallow-merge onto
 * `DEFAULT_TERMINAL_PREFS` so a blob saved by an OLDER build (missing a
 * field this version added) still loads with sane defaults for the new
 * ones, instead of the whole preference set silently reverting because one
 * field was absent. */
function parseStoredPrefs(raw: string): TerminalPrefs {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) return DEFAULT_TERMINAL_PREFS;
  const p = parsed as Partial<Record<keyof TerminalPrefs, unknown>>;
  return {
    fontSize: typeof p.fontSize === "number" ? clampFontSize(p.fontSize) : DEFAULT_TERMINAL_PREFS.fontSize,
    cursorStyle: isCursorStyle(p.cursorStyle) ? p.cursorStyle : DEFAULT_TERMINAL_PREFS.cursorStyle,
    cursorBlink: typeof p.cursorBlink === "boolean" ? p.cursorBlink : DEFAULT_TERMINAL_PREFS.cursorBlink,
    scrollback: typeof p.scrollback === "number" ? clampScrollback(p.scrollback) : DEFAULT_TERMINAL_PREFS.scrollback,
  };
}

/** Reads the persisted preferences, or the defaults if none are stored, the
 * blob is corrupt, or localStorage isn't available at all (SSR/Node, or
 * private-browsing Safari, which throws on ANY access, not just writes). */
export function loadTerminalPrefs(): TerminalPrefs {
  if (typeof window === "undefined") return DEFAULT_TERMINAL_PREFS;
  try {
    const raw = window.localStorage.getItem(TERMINAL_PREFS_KEY);
    if (raw === null) return DEFAULT_TERMINAL_PREFS;
    return parseStoredPrefs(raw);
  } catch {
    return DEFAULT_TERMINAL_PREFS;
  }
}

let current: TerminalPrefs = loadTerminalPrefs();
const listeners = new Set<() => void>();

/** The `getSnapshot` `useTerminalPrefs` (below) reads — also exported
 * directly for a non-React caller that needs the current value
 * synchronously, mirroring `blockStore.ts`'s `getBlocksSnapshot`. */
export function getTerminalPrefsSnapshot(): TerminalPrefs {
  return current;
}

/** Settings.tsx's Terminal section calls this on every control change.
 * Updates the in-memory value, persists it, and notifies every subscribed
 * `<Terminal>` instance so already-open panes pick the change up live. */
export function saveTerminalPrefs(prefs: TerminalPrefs): void {
  current = prefs;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(TERMINAL_PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // Storage full or disabled — the change still applies live for this
      // session (listeners are still notified below), it just won't be
      // remembered next time. Not worth surfacing to the user.
    }
  }
  for (const listener of listeners) listener();
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => listeners.delete(onStoreChange);
}

/** Reactive read of the current terminal preferences — re-renders whenever
 * Settings.tsx saves a change, in every component that calls this, not
 * just the one that made the change. Terminal.tsx uses this (rather than a
 * one-time `loadTerminalPrefs()` read) specifically so an already-open pane
 * reacts live; see this file's own top comment for why a shared store
 * rather than a prop. */
export function useTerminalPrefs(): TerminalPrefs {
  return useSyncExternalStore(subscribe, getTerminalPrefsSnapshot);
}
