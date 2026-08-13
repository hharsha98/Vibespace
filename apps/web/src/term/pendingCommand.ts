/**
 * A tiny "write-once, read-once" box for the prompt bar's submitted text
 * (Phase 9.5a — see Terminal.tsx's "Per-pane prompt bar"
 * module comment). `captureCommandText()` in Terminal.tsx is a genuinely
 * best-effort scrape of the prompt line, and it fails whenever the shell's
 * echo doesn't land where expected — which happens routinely for
 * prompt-bar submissions (the bar writes straight to the pty; there's no
 * guarantee the echoed text ends up back on the same buffer line/column
 * `captureCommandText()` assumes). The prompt bar, unlike the buffer scrape,
 * KNOWS exactly what it sent — this module is how that known-good text gets
 * from "just wrote it to the socket" (a component-level handler, outside
 * Terminal.tsx's main mount effect) to "the next OSC 133 'C' that opens a
 * block" (inside that effect), without either side needing a reference to
 * the other's closure.
 *
 * Deliberately pure — no xterm.js, no sockets, nothing beyond a single
 * string slot — so `pendingCommand.test.ts` can pin down the one property
 * that actually matters here under plain Node/vitest: `consume()` returns
 * the pending text exactly once, and null thereafter, until `set()` is
 * called again. That "consume once" behaviour is what stops a later,
 * DIRECTLY-typed command (no prompt-bar submission involved at all) from
 * silently inheriting a stale prompt-bar string left over from an earlier
 * command.
 */
export interface PendingCommand {
  /** Records `text` as the command that should be attributed to the next
   * block that opens. Overwrites whatever was pending before — only the
   * most recent submission ahead of the next OSC 133 "C" is ever
   * meaningful, since at most one block can be opening at a time. */
  set(text: string): void;
  /** Returns the currently pending text and clears it in the same call. A
   * later call — with no `set()` in between — returns `null`, never a
   * stale value from an earlier submission. */
  consume(): string | null;
}

/** Creates a fresh, empty `PendingCommand` box — one per Terminal.tsx mount
 * (see that file's main effect), the same lifetime as its `BlockTracker`. */
export function createPendingCommand(): PendingCommand {
  let value: string | null = null;
  return {
    set(text: string): void {
      value = text;
    },
    consume(): string | null {
      const current = value;
      value = null;
      return current;
    },
  };
}
