/**
 * Pure data model for "command blocks" — Phase 5's grouping of a shell
 * pane's history into per-command chunks, driven by the OSC 133 markers a
 * shell pane's pty emits (see
 * `apps/server/src/pty/shell-integration/vibespace-integration.zsh` for what
 * sends them, and `Terminal.tsx` for where they're parsed off the wire and
 * fed into a `BlockTracker`).
 *
 * This file is deliberately pure — no xterm.js, no DOM, no `Date.now()`
 * calls anywhere in it — so `blocks.test.ts` can exercise every code path,
 * including the malformed-sequence ones a REAL terminal will produce
 * (Ctrl-C mid-command, a resize, a shell that only half-implements the
 * protocol), under plain Node/vitest with fully deterministic timestamps.
 */

/** One command's worth of terminal history, as tracked by `BlockTracker`. */
export interface CommandBlock {
  /** Stable id, unique within one `BlockTracker` instance (i.e. one pane's
   * lifetime — resets on `clear()`). Not a UUID; just a counter, since
   * nothing outside this pane's own UI ever needs to compare ids across
   * panes. */
  id: string;
  /** The text typed at the prompt, if Terminal.tsx managed to capture it
   * from the buffer between the "B" and "C" markers — null if it couldn't
   * (see Terminal.tsx's own comment on why that capture is best-effort). */
  command: string | null;
  /** Absolute buffer line (baseY + cursorY, not just the visible row) where
   * the command's OWN output starts — i.e. the "C" marker's line. */
  startLine: number;
  /** Absolute buffer line of the "D" (finished) marker, or null while the
   * command is still running. */
  endLine: number | null;
  /** The command's exit code, or null if it hasn't finished yet, OR if it
   * finished in a way we couldn't get a real code for (see `onCommandStart`
   * and `onCommandEnd`'s doc comments for when that happens). */
  exitCode: number | null;
  /** Epoch ms when the command started, as given to `onCommandStart` — this
   * class never reads the clock itself, see the top-of-file comment. */
  startedAt: number | null;
  /** How long the command ran, in ms, or null while still running. */
  durationMs: number | null;
  state: "running" | "ok" | "failed";
}

/** `exitCode === 0` is the only thing that ever counts as "ok" — anything
 * else (a real non-zero code, OR `null` because we never actually saw a
 * clean finish) reads as "failed". That's the honest call: a block we lost
 * track of is not the same as a block we know succeeded. */
function stateFor(exitCode: number | null): "ok" | "failed" {
  return exitCode === 0 ? "ok" : "failed";
}

/**
 * A per-pane state machine that turns a stream of OSC 133 marker events
 * into a list of `CommandBlock`s. Feed it events as they arrive (in
 * whatever order the real terminal produces — including "wrong" orders,
 * see below); read the result any time via `list()`.
 *
 * Robustness is the whole point of this class's shape: real shells and
 * real terminals do NOT always emit a perfectly nested A→B→C→D→A→B→C→D...
 * sequence. Window resizes, Ctrl-C, subshells that re-source the
 * integration script, and shells that only half-implement OSC 133 all
 * produce "malformed" sequences — a bare D with no preceding C, two Cs in a
 * row, etc. None of that may ever throw or leave `list()` in a corrupted
 * state (duplicate/dangling entries, blocks stuck "running" forever with no
 * way to close them, ...).
 */
export class BlockTracker {
  private blocks: CommandBlock[] = [];
  private nextId = 1;
  /** Index into `blocks` of the currently-running block, or null if no
   * command is currently executing (i.e. we're sitting at a prompt). An
   * index (not a separate id-keyed map) is enough because there is at most
   * ONE open block at a time — see `onCommandStart`. */
  private openIndex: number | null = null;

  /**
   * OSC 133 "A" — a new prompt is about to be drawn. Currently a no-op: no
   * `CommandBlock` field depends on it. Kept as a real method (matching the
   * OSC 133 marker it corresponds to) rather than silently dropped, so
   * `Terminal.tsx` has one call per marker type and this class's public
   * shape won't need to change if a future feature wants prompt-start
   * line info.
   */
  onPromptStart(_line: number): void {
    // Intentionally empty — see doc comment above.
  }

  /**
   * OSC 133 "B" — the prompt just finished drawing; the user's typed input
   * starts here. Also currently a no-op ON THIS CLASS: `Terminal.tsx` is
   * the one that actually uses the B line (to know where in the xterm
   * buffer to start reading for command-text capture) — this class doesn't
   * need to remember it for anything in `CommandBlock` itself.
   */
  onPromptEnd(_line: number): void {
    // Intentionally empty — see doc comment above.
  }

  /**
   * OSC 133 "C" — a command just started executing. Opens a new "running"
   * block.
   *
   * If a block is ALREADY open (two Cs with no D between them — e.g.
   * Ctrl-C during a long-running command, or a shell/subshell quirk that
   * re-emits C), the earlier block is closed right here, at the new
   * command's start line, as an interrupted/unknown result (`exitCode:
   * null`, which reads as "failed" — see `stateFor`) rather than left open
   * forever with no way to ever close it.
   *
   * @param command The typed command text, if the caller captured it —
   *   pass `null` (the default) if it couldn't be captured.
   */
  onCommandStart(line: number, now: number, command: string | null = null): void {
    if (this.openIndex !== null) {
      this.closeBlock(this.openIndex, null, line, now);
    }

    const block: CommandBlock = {
      id: `block-${this.nextId++}`,
      command,
      startLine: line,
      endLine: null,
      exitCode: null,
      startedAt: now,
      durationMs: null,
      state: "running",
    };
    this.blocks.push(block);
    this.openIndex = this.blocks.length - 1;
  }

  /**
   * OSC 133 "D;<exitcode>" — a command just finished.
   *
   * If there's no currently-open block — a bare D with no preceding C, e.g.
   * the very first prompt of a session before anything has run, or a shell
   * that emits D defensively on every precmd — this is simply ignored:
   * there is nothing to close, and fabricating a zero-duration block out of
   * nowhere would be worse than showing nothing.
   */
  onCommandEnd(exitCode: number | null, line: number, now: number): void {
    if (this.openIndex === null) return;
    this.closeBlock(this.openIndex, exitCode, line, now);
    this.openIndex = null;
  }

  private closeBlock(index: number, exitCode: number | null, line: number, now: number): void {
    const block = this.blocks[index];
    block.endLine = line;
    block.exitCode = exitCode;
    block.state = stateFor(exitCode);
    block.durationMs = block.startedAt !== null ? Math.max(0, now - block.startedAt) : null;
  }

  /** Every block tracked so far, oldest first (the order their "C" markers
   * arrived in). A fresh array each call — callers that want "newest
   * first" (the Blocks tab) reverse it themselves; this class doesn't bake
   * in a display order. */
  list(): CommandBlock[] {
    return [...this.blocks];
  }

  /** Forgets every block and closes out any currently-running one. Called
   * when the terminal itself is cleared (Terminal.tsx's "Clear" context
   * menu item / `term.clear()`) — every block's line numbers refer to
   * buffer positions that no longer mean anything after a clear, so keeping
   * stale blocks around would make "jump to block" scroll to the wrong
   * place (or nowhere). */
  clear(): void {
    this.blocks = [];
    this.openIndex = null;
  }
}

/** One parsed OSC 133 payload — the string xterm.js's OSC-133 handler
 * receives is everything after `\x1b]133;` and before the terminator, e.g.
 * `"A"`, `"B"`, `"C"`, `"D;0"`, `"D;127"`, or (from a shell that only
 * half-implements the protocol) just `"D"` with no code at all. */
export type Osc133Event =
  | { marker: "A" }
  | { marker: "B" }
  | { marker: "C" }
  | { marker: "D"; exitCode: number | null }
  /** Not one of A/B/C/D at all — some other OSC 133 sub-command vibespace
   * doesn't (yet) understand, or plain garbage. Callers should treat this
   * the same as "ignore," not as an error. */
  | null;

/** Turns a "D;<exitcode>" payload's code half into a number, or `null` if
 * it's missing (bare "D") or not a valid integer (a corrupted escape
 * sequence, or a shell that sends something non-numeric) — never throws,
 * never produces `NaN`. */
function parseExitCode(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/** Parses one OSC 133 payload string into an `Osc133Event`. Exported as its
 * own pure function (not inlined into Terminal.tsx's OSC handler) so the
 * parsing of malformed/edge-case payloads — exactly the kind of thing worth
 * pinning down with a test — is covered by `blocks.test.ts` under plain
 * Node, with no xterm.js instance needed. */
export function parseOsc133(payload: string): Osc133Event {
  const [marker, ...rest] = payload.split(";");
  switch (marker) {
    case "A":
      return { marker: "A" };
    case "B":
      return { marker: "B" };
    case "C":
      return { marker: "C" };
    case "D":
      return { marker: "D", exitCode: parseExitCode(rest[0]) };
    default:
      return null;
  }
}

/** Formats a duration in milliseconds the way the Blocks tab shows it:
 * sub-second as whole milliseconds ("340ms"), otherwise seconds to one
 * decimal place ("2.3s"). Pure/tiny enough to unit test directly rather
 * than only ever exercising it through a rendered component. */
export function formatBlockDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}
