/**
 * A tiny in-memory registry mapping `sessionId -> that pane's live block
 * data (+ a way to scroll its terminal)`, plus a subscribe/notify
 * mechanism so components elsewhere in the tree can reactively read a
 * session's blocks without prop-drilling a `BlockTracker` instance all the
 * way through App -> Grid -> PaneView -> Terminal and back out again.
 *
 * Why this needs to exist at all: the "Blocks" tab lives in `RightDock`,
 * which shows whichever pane is currently FOCUSED — but focus can change to
 * any pane at any time, and `RightDock` has no direct reference to any
 * particular `<Terminal>` instance (there can be many, one per pane, deep
 * inside `Grid`). `Terminal.tsx` registers/updates this session's data as
 * OSC 133 markers arrive; `useSessionBlocks` (built on React's
 * `useSyncExternalStore`, the standard tool for "subscribe to something
 * outside React's own state") is how `RightDock` reads it back.
 */
import { useSyncExternalStore } from "react";
import type { BlockTracker, CommandBlock } from "./blocks.js";

type Listener = () => void;

const EMPTY_BLOCKS: CommandBlock[] = [];

const trackers = new Map<string, BlockTracker>();
// A cached snapshot per session, refreshed only when `notify()` runs.
// `useSyncExternalStore` requires `getSnapshot()` to return the SAME
// reference across calls when nothing changed (React compares it with
// `Object.is` to decide whether to re-render) — `BlockTracker.list()`
// itself returns a brand-new array every call, so calling it directly from
// `getSnapshot` would violate that and risk an infinite render loop. This
// cache is what keeps the reference stable in between real changes.
const snapshots = new Map<string, CommandBlock[]>();
const listeners = new Map<string, Set<Listener>>();

function refreshSnapshot(sessionId: string): void {
  const tracker = trackers.get(sessionId);
  snapshots.set(sessionId, tracker ? tracker.list() : EMPTY_BLOCKS);
}

function notify(sessionId: string): void {
  refreshSnapshot(sessionId);
  for (const listener of listeners.get(sessionId) ?? []) listener();
}

/** Terminal.tsx calls this once, when it creates a session's `BlockTracker`
 * (on mount / session-id change). */
export function registerBlockTracker(sessionId: string, tracker: BlockTracker): void {
  trackers.set(sessionId, tracker);
  notify(sessionId);
}

/** Terminal.tsx calls this on unmount, so a closed pane's stale tracker
 * doesn't keep answering for a sessionId that no longer has a live view. */
export function unregisterBlockTracker(sessionId: string): void {
  trackers.delete(sessionId);
  snapshots.delete(sessionId);
  notify(sessionId);
}

/** Terminal.tsx calls this after every mutation to a session's tracker
 * (onCommandStart/onCommandEnd/clear) so any subscribed component
 * re-renders with the fresh list. */
export function notifyBlocksChanged(sessionId: string): void {
  notify(sessionId);
}

/** The cached snapshot for a session — the actual `getSnapshot` used by
 * `useSessionBlocks` below, but also exported directly for non-React
 * callers (App.tsx's block-navigation shortcut handlers, which need the
 * current list synchronously, not via a hook). */
export function getBlocksSnapshot(sessionId: string | null): CommandBlock[] {
  if (!sessionId) return EMPTY_BLOCKS;
  return snapshots.get(sessionId) ?? EMPTY_BLOCKS;
}

function subscribe(sessionId: string | null, onStoreChange: Listener): () => void {
  if (!sessionId) return () => {};
  let set = listeners.get(sessionId);
  if (!set) {
    set = new Set();
    listeners.set(sessionId, set);
  }
  set.add(onStoreChange);
  return () => {
    set.delete(onStoreChange);
    if (set.size === 0) listeners.delete(sessionId);
  };
}

/** React hook: the live, newest-mutation-aware block list for `sessionId`
 * — re-renders whenever Terminal.tsx reports marker activity for that
 * session. Returns an empty array for `null`, or for a session that has
 * never registered a tracker (not a shell pane, or shell integration
 * produced no markers yet). */
export function useSessionBlocks(sessionId: string | null): CommandBlock[] {
  return useSyncExternalStore(
    (onChange) => subscribe(sessionId, onChange),
    () => getBlocksSnapshot(sessionId)
  );
}

// --- Scroll-to-line ----------------------------------------------------
// A second tiny registry, alongside the block data above, for the other
// half of "click a block, jump the terminal there": Terminal.tsx registers
// a small function that knows how to scroll ITS xterm instance to an
// absolute buffer line; RightDock (and App.tsx's prev/next-block keyboard
// shortcuts) call `scrollSessionToLine` without needing to reach into the
// terminal's internals themselves.

const scrollHandlers = new Map<string, (line: number) => void>();

/** Terminal.tsx calls this once, on mount, with a function that scrolls
 * (and refocuses) its own xterm instance. */
export function registerScrollHandler(sessionId: string, handler: (line: number) => void): void {
  scrollHandlers.set(sessionId, handler);
}

/** Terminal.tsx calls this on unmount. */
export function unregisterScrollHandler(sessionId: string): void {
  scrollHandlers.delete(sessionId);
}

/** Scrolls `sessionId`'s terminal (if it currently has a live view
 * registered) to `line`. A no-op if that session has no registered
 * terminal right now — e.g. it was closed, or was never a shell pane. */
export function scrollSessionToLine(sessionId: string, line: number): void {
  scrollHandlers.get(sessionId)?.(line);
}
