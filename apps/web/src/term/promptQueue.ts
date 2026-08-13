/**
 * Pure state machine behind the per-pane prompt bar (Phase 9.5a, part 1 —
 * docs/PARITY.md #13a): a small input strip under every pane with a live
 * session that lets you "queue the next prompt" while the agent is still
 * busy, instead of typing directly into the terminal.
 *
 * Deliberately pure — no xterm.js, no WebSocket, no `Date.now()` anywhere in
 * this file — so `promptQueue.test.ts` can exercise every transition
 * deterministically under plain Node/vitest, per the phase spec's own
 * instruction ("taking timestamps as parameters rather than calling
 * `Date.now()` internally"). This module also has no idea WHY the caller
 * thinks the pane is busy or idle — that decision (exact, from OSC 133, for
 * shell panes; a heuristic based on output timing for agent TUI panes) is
 * made by `Terminal.tsx` and handed in as a plain status change via
 * `setAgentStatus`. See `isRecentActivityBusy` below for the one piece of
 * the heuristic that IS pure/testable — the "is this timestamp recent
 * enough to still count as busy" check itself.
 *
 * The queue this module manages lives only in this browser tab's memory. It
 * is NOT persisted to the server or to localStorage, so a page reload loses
 * any still-queued (not yet sent) prompts. That is an accepted trade-off,
 * not an oversight — see Terminal.tsx's prompt-bar integration comment and
 * the placeholder copy in PromptBar.tsx, both of which say so.
 */

/** Whether the agent this prompt bar is queueing for currently looks busy
 * or idle, from whichever detection Terminal.tsx used (see that file's
 * "Command blocks" / prompt-bar comments for shell-exact vs. heuristic). */
export type AgentStatus = "working" | "idle";

export interface PromptQueueState {
  status: AgentStatus;
  /** Prompts waiting to be sent, oldest first. */
  queue: string[];
}

/** A fresh, empty, idle queue — what every pane's prompt bar starts with. */
export function createPromptQueueState(): PromptQueueState {
  return { status: "idle", queue: [] };
}

/** The result of any state transition below: the new state, plus (if
 * non-null) text the caller should actually write into the pane's pty right
 * now, the same way direct typing would (see Terminal.tsx's `sendToSocket`
 * helper) — this module only ever decides WHETHER and WHAT to send, never
 * how to send it. */
export interface QueueEffect {
  state: PromptQueueState;
  send: string | null;
}

/**
 * A prompt was submitted from the bar (Enter, or the bar's submit button).
 * Idle -> sent immediately, queue untouched. Working -> appended to the
 * queue, nothing sent yet.
 */
export function submitPrompt(state: PromptQueueState, text: string): QueueEffect {
  if (state.status === "idle") {
    return { state, send: text };
  }
  return { state: { ...state, queue: [...state.queue, text] }, send: null };
}

/**
 * The caller just decided (exactly, or heuristically — this module doesn't
 * know or care which) that the pane's status is now `status`. Re-reporting
 * the SAME status (idle->idle, working->working) is always a no-op, so a
 * chatty caller — e.g. an agent TUI pane's output handler, which may call
 * this on every chunk of output — can call it freely without side effects
 * or accidentally re-flushing the queue on every call.
 *
 * Only a working -> idle transition can ever send anything, and it sends AT
 * MOST ONE prompt — the oldest queued one — never the whole queue at once.
 * That's deliberate: submitting a prompt is expected to make the pane busy
 * again almost immediately (the next OSC 133 "C", or the next burst of
 * output), which naturally holds any REMAINING queued prompts until the
 * NEXT idle transition, one at a time, in order.
 */
export function setAgentStatus(state: PromptQueueState, status: AgentStatus): QueueEffect {
  if (status === state.status) return { state, send: null };

  if (status === "working") {
    return { state: { ...state, status }, send: null };
  }

  // working -> idle
  if (state.queue.length === 0) {
    return { state: { status: "idle", queue: state.queue }, send: null };
  }
  const [next, ...rest] = state.queue;
  return { state: { status: "idle", queue: rest }, send: next };
}

/** Empties the queue (the bar's "clear queue" affordance) without touching
 * `status` — clearing a busy pane's queue just means "don't send those
 * anymore," it doesn't change whether the agent itself is still busy. */
export function clearQueue(state: PromptQueueState): PromptQueueState {
  return state.queue.length === 0 ? state : { ...state, queue: [] };
}

// --- Agent TUI busy heuristic --------------------------------------------
//
// Shell panes get an EXACT busy signal from OSC 133 (see blocks.ts's
// `BlockTracker` — an open "C" block with no "D" yet means a command is
// running). Agent TUI panes (claude, cursor-agent, codex) are full-screen
// programs that emit no such markers at all, so Terminal.tsx falls back to
// a heuristic: output seen "recently" counts as busy, quiet for longer
// counts as idle.
//
// Be honest about what this is: a HEURISTIC, and it WILL sometimes be
// wrong. An agent that is silently "thinking" for longer than the threshold
// with no stdout looks idle when it is not — a queued prompt could then get
// sent into the middle of its next burst of output instead of waiting for
// it to truly finish. There is no general fix for this without a real
// "done" signal from the agent itself, which none of these three CLIs
// currently emit. Naming and documenting the constant, rather than burying
// a magic number, is the honest version of this trade-off.

/** How recent output has to be (in ms) to still count as "busy" for an
 * agent TUI pane. Chosen empirically: long enough that word-by-word token
 * streaming doesn't read as idle between chunks, short enough that a pane
 * that's actually gone quiet reads as idle within well under a second. */
export const AGENT_ACTIVITY_IDLE_MS = 750;

/** The pure predicate behind the heuristic above: given when output was
 * last seen (`lastOutputAt`) and the current time (`now`) — both passed in,
 * never read from `Date.now()` here — is the pane still "busy"?
 * `lastOutputAt: null` (no output observed yet this pane's lifetime) always
 * reads as NOT busy. */
export function isRecentActivityBusy(
  lastOutputAt: number | null,
  now: number,
  thresholdMs: number = AGENT_ACTIVITY_IDLE_MS
): boolean {
  if (lastOutputAt === null) return false;
  return now - lastOutputAt < thresholdMs;
}
