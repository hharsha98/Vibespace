/**
 * Phase 7 §5: turning "dispatch this card to an agent" into an agent that
 * is actually running AND has been told what to work on.
 *
 * The tricky part isn't spawning the pty (`SessionManager.create` already
 * does that) — it's that a freshly-spawned process is not necessarily
 * ready to receive keystrokes the instant it exists. A CLI agent (or even
 * a plain login shell) typically prints a startup banner/prompt across one
 * or more output chunks before it's actually reading stdin; writing the
 * dispatch prompt too early risks it being dropped, or interleaved into
 * the middle of that banner and garbled. `writePromptWhenReady` below
 * waits for the session's FIRST output event as a proxy for "it has
 * started producing terminal output", then waits a further
 * `DISPATCH_SETTLE_DELAY_MS` before actually writing — see that constant's
 * comment for how reliable this heuristic is in practice.
 */
import type { AgentId, BoardCard } from "@vibedeck/shared";
import type { SessionManager } from "../pty/session-manager.js";

/**
 * How long to wait, AFTER a freshly-spawned session's first output chunk
 * arrives, before writing the dispatch prompt into its pty.
 *
 * This is a real empirical trade-off, not an arbitrary default: too short
 * and a fast-typing agent can have the prompt's first few characters
 * dropped or interleaved into its own still-printing startup banner; too
 * long and dispatch feels laggy for the common case. 400ms was reliable in
 * manual local testing against the `shell` agent (a login shell prints its
 * prompt almost immediately, so the first-output signal fires fast and
 * this delay is mostly headroom). It has NOT been exercised against a real
 * full-screen TUI coding agent (`claude`, `cursor-agent`, `codex`) — CI
 * runs on ubuntu-latest with none of those installed, and this repo's own
 * rules require dispatch tests to use `shell` only. A slower-starting TUI
 * agent may need a longer delay in practice; if dispatch to `claude` drops
 * or garbles the first few characters of the prompt, raising this constant
 * is the first thing to try.
 */
export const DISPATCH_SETTLE_DELAY_MS = 400;

/** Upper bound: if a session produces no output at all within this long
 * (unusual, but possible for a slow-starting process), write the prompt
 * anyway rather than waiting forever. */
export const DISPATCH_MAX_WAIT_MS = 3000;

/**
 * Writes `prompt` into `sessionId`'s pty once it looks ready for input, per
 * this module's top comment. Fire-and-forget from the caller's point of
 * view — there is no promise to await; the route that calls this returns
 * as soon as the session exists, not once the prompt has actually landed,
 * so a slow-starting agent never makes the dispatch HTTP request hang.
 */
export function writePromptWhenReady(sessionManager: SessionManager, sessionId: string, prompt: string): void {
  let settled = false;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe: (() => void) | null = null;

  const write = () => {
    if (settled) return;
    settled = true;
    if (settleTimer) clearTimeout(settleTimer);
    unsubscribe?.();
    try {
      sessionManager.write(sessionId, prompt);
    } catch {
      // Session may already have exited (e.g. a one-shot command that ran
      // and quit before we got to it) — nothing more to do.
    }
  };

  unsubscribe = sessionManager.attach(sessionId, (event) => {
    if (settled || event.type !== "output" || settleTimer) return;
    // First output chunk seen — start the settle-delay countdown. Later
    // output chunks (there will be more, e.g. the rest of a banner) don't
    // restart this timer; the FIRST chunk is what "has it started" means.
    settleTimer = setTimeout(write, DISPATCH_SETTLE_DELAY_MS);
  });

  // Fallback in case the session never produces any output before this
  // fires — write anyway rather than silently never dispatching.
  setTimeout(write, DISPATCH_MAX_WAIT_MS);
}

/**
 * Builds the text typed into a freshly-dispatched agent's pty: a short,
 * factual preamble telling the agent which card it's working on and the
 * exact `curl` call to move that card to In Review when it's done, followed
 * by the card's own title/description as the actual task. See
 * `docs/AGENT-API.md` for the full HTTP surface this curl call is drawn
 * from. Ends with a trailing newline so the pty actually "submits" it
 * (equivalent to the agent's user pressing Enter) rather than leaving it
 * sitting unsent in the input buffer.
 */
export function buildDispatchPrompt(
  card: BoardCard,
  serverPort: number,
  agent: AgentId
): string {
  const body = card.description ? `${card.title} — ${card.description}` : card.title;

  // A plain shell is not an agent: it cannot act on an instruction like
  // "move this card when you're done", it would just try to *execute* that
  // English as a command and spew errors. So for `shell` we type the card's
  // body verbatim and nothing else — for a shell, the card body IS the
  // command.
  if (agent === "shell") {
    return `${toSingleLine(body)}\n`;
  }

  const moveCommand =
    `curl -s -X PATCH http://localhost:${serverPort}/api/board/cards/${card.id} ` +
    `-H "Content-Type: application/json" -d '{"columnId":"in_review"}'`;
  const preamble =
    `[vibedeck] You are working on board card ${card.id} ("${card.title}"). ` +
    `When you are done, move it to In Review by running: ${moveCommand} — the task follows. `;

  return `${toSingleLine(preamble + body)}\n`;
}

/**
 * Collapses every internal newline into a single space.
 *
 * This matters more than it looks. Writing into an agent's pty is the same
 * as that agent's user typing — and in a TUI like Claude Code, a newline is
 * "submit". A prompt containing three newlines would therefore submit three
 * separate half-prompts instead of one whole one. Exactly one trailing
 * newline is added by the caller, and that one is the deliberate submit.
 */
export function toSingleLine(text: string): string {
  return text.replace(/\s*\n+\s*/g, " ").trim();
}
