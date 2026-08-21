/**
 * Parses Codex CLI's OWN "NN% context left" footer indicator out of the raw
 * pty byte stream, for the pane header's context-meter pill (BridgeSpace
 * v3.4.17 parity).
 *
 * --- Why this exists only for Codex, and what it does NOT do ------------
 * vibedeck has no API access to any provider and keeps no token accounting
 * of its own — every agent CLI runs as a real process inside a pty (see
 * `apps/server/src/pty/agents.ts`), and the ONLY signal available is
 * whatever that CLI prints to its own terminal. Before writing this file,
 * each of the three CLIs vibedeck ships today (`claude`, `codex`,
 * `cursor-agent`) was checked for a genuine, default, on-screen
 * context/token indicator:
 *
 *  - Codex: YES. Confirmed two ways — (1) the compiled `codex` binary's own
 *    string table contains the literal template text "100% context left" /
 *    "Context 0% left" / "Context 0% used", and (2) a live capture of a
 *    real `codex` pty session (node-pty, same spawn path this app uses)
 *    showed the EXACT raw bytes:
 *      \x1b[24;102H100% context left\x1b[39m\x1b[49m\x1b[0m
 *    — a cursor-position escape, then the percentage + label as one
 *    contiguous plain-text run, then SGR resets. This is Codex's own
 *    always-on composer footer, not something behind a flag or a config
 *    the user has to opt into.
 *  - Claude Code: NO default on-screen indicator. Its context/token data
 *    (`context_window.used_percentage` etc.) exists internally and CAN be
 *    exposed via a user-configured `statusLine` command, but that's opt-in
 *    (most installs have none configured) and, when present, the rendered
 *    text is an arbitrary user-authored command's output — not a fixed
 *    string vibedeck could safely regex for. Confirmed by reading the
 *    installed `claude` binary's own source strings, which gate that
 *    render path behind `settings?.statusLine` being configured at all.
 *  - Cursor Agent: NO default on-screen indicator. It has a `/context`
 *    slash-command panel (percentFullLabel, totalTokensLabel, etc.), but
 *    that's an on-demand view the user has to manually invoke, not
 *    anything printed passively during normal use.
 *
 * So: this module parses a REAL measurement Codex itself computes and
 * prints — not an estimate vibedeck invents. It is deliberately Codex-only
 * (Option A: "parse a real indicator a specific CLI genuinely prints" —
 * see the phase notes). `Terminal.tsx` only ever feeds this tracker pty
 * output for `agentId === "codex"` panes; every other pane simply never
 * gets one, and `ContextMeterTracker.current()` starts (and stays) `null`
 * until Codex prints its own value — the caller renders NOTHING for a
 * `null` reading rather than a fake/zeroed pill.
 *
 * --- Why this needs to be resilient, not a simple substring search ------
 * A full-screen TUI like Codex's redraws its ENTIRE footer on every frame,
 * using ANSI cursor-positioning + SGR escapes around (and, in principle,
 * potentially within) the literal text. pty data also arrives across the
 * WebSocket in arbitrary chunks — nothing guarantees "100% context left"
 * lands in one `message.data` string; it can just as easily split as
 * "...10" + "0% context left...". `ContextMeterTracker` handles both: it
 * keeps a small rolling buffer of raw (unstripped) text across `feed()`
 * calls so a split signal completes once the rest arrives, strips ANSI
 * escapes fresh from that buffer on every call (so stray escapes anywhere
 * in or around the match never break it), and always keeps the LAST valid
 * match found — later matches are later redraws, i.e. newer values.
 */

/** How much raw (unstripped) pty text `ContextMeterTracker` keeps around
 * across `feed()` calls. Generous relative to the ~20-char pattern itself
 * (so a signal split across two small chunks, or padded by a wide-terminal
 * redraw's worth of surrounding escape codes, never falls out of the
 * window before it can complete) while still cheap to re-scan on every
 * chunk of a full-screen TUI's redraw traffic. */
const BUFFER_CHARS = 4096;

/** Matches Codex's literal footer text, e.g. "100% context left" or
 * "7% context left" — 1 to 3 digits, a bare `%`, then the label. Applied
 * only AFTER ANSI stripping (see `stripAnsiEscapes` below), so this never
 * has to account for escape codes itself. */
const CONTEXT_LEFT_PATTERN = /(\d{1,3})%\s*context left/gi;

/**
 * Strips ANSI/VT escape sequences from `text` so the plain text runs
 * underneath can be matched directly. Not a full terminal parser (it
 * doesn't track cursor position or resolve overlapping writes into a
 * screen model) — just enough to turn "text with escape codes woven
 * through it" into "the same text, concatenated" for the narrow purpose of
 * finding one literal phrase. Handles:
 *  - CSI sequences (cursor moves, SGR colour/style, etc.): `ESC [ ... final`
 *  - OSC sequences (window title, etc.): `ESC ] ... (BEL | ESC \)`
 *  - Charset-select two-byte sequences: `ESC ( X` / `ESC ) X`
 *  - Any other stray `ESC <char>` pair, as a defensive fallback so a lone
 *    unrecognized escape can never leave a literal ESC byte sitting in the
 *    "clean" text (worst case, it swallows one adjacent character — which
 *    only matters if that character happened to be part of THIS pattern,
 *    and self-heals on the very next redraw).
 * A CSI/OSC sequence truncated mid-way at the buffer's tail (a realistic
 * chunk-boundary case) is simply left as-is by this pass — it doesn't
 * match any of the three specific patterns (no final byte yet), so it's
 * skipped rather than mangled, and gets stripped correctly next call once
 * the rest of the buffer arrives.
 *
 * The ESC (0x1B) and BEL (0x07) bytes below are built via
 * `String.fromCharCode` rather than written as `\x1b`/`\x07` literals
 * inside a regex — deliberately, not for obfuscation: eslint's
 * `no-control-regex` rule (for good reason, elsewhere — an unexplained raw
 * control byte in a regex is a classic bug/injection smell) refuses a
 * literal control-character escape in regex source. Here it's neither
 * unexplained nor accidental: matching real terminal escape sequences
 * requires matching this exact byte, so the patterns are assembled at
 * runtime instead of written as regex literals.
 */
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CSI_PATTERN = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");
const OSC_PATTERN = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g");
const CHARSET_SELECT_PATTERN = new RegExp(`${ESC}[()][A-Za-z0-9]`, "g");
const STRAY_ESCAPE_PATTERN = new RegExp(`${ESC}.`, "g");

function stripAnsiEscapes(text: string): string {
  return text
    .replace(CSI_PATTERN, "")
    .replace(OSC_PATTERN, "")
    .replace(CHARSET_SELECT_PATTERN, "")
    .replace(STRAY_ESCAPE_PATTERN, "");
}

/**
 * Pure extraction: given a (possibly ANSI-laden) chunk of terminal text,
 * returns the LAST valid "NN% context left" reading found in it, or `null`
 * if none is present. "Last" matters for the redraw case — a full-screen
 * TUI's footer gets rewritten on every frame, so if a buffer happens to
 * contain more than one occurrence (e.g. a resize repainted the screen
 * mid-buffer), the most recently WRITTEN one is the current value, not the
 * first one seen.
 *
 * Out-of-range digits (defensively; Codex's own range is 0-100, but this
 * never trusts that blindly) are ignored rather than clamped or reported —
 * an unparseable/impossible reading is exactly the kind of thing that
 * should fall back to "no signal" rather than show a wrong number.
 */
export function extractContextLeftPercent(rawChunk: string): number | null {
  const clean = stripAnsiEscapes(rawChunk);
  let lastValid: number | null = null;
  for (const match of clean.matchAll(CONTEXT_LEFT_PATTERN)) {
    const n = Number.parseInt(match[1], 10);
    if (Number.isFinite(n) && n >= 0 && n <= 100) lastValid = n;
  }
  return lastValid;
}

/**
 * Stateful, per-pane tracker: feed it raw pty output chunks as they arrive
 * (in whatever order/size the WebSocket delivers them — see this file's
 * top comment on why that can't be assumed to align with the pattern's
 * boundaries), read the current reading any time via `current()`.
 *
 * Mirrors `blocks.ts`'s `BlockTracker` shape (a small stateful class fed
 * incrementally, read via a getter) and the same "never throw, degrade to
 * the honest unknown state" spirit — a chunk that contains no valid
 * reading, or a malformed one, just leaves `current()` wherever it already
 * was (or `null`, if nothing valid has ever arrived yet).
 */
export class ContextMeterTracker {
  private buffer = "";
  private percentLeft: number | null = null;

  /** Feed the next raw chunk of this pane's pty output (exactly the string
   * `Terminal.tsx` receives in a `{ type: "output" }` message, BEFORE it's
   * handed to xterm.js — ANSI escapes and all). */
  feed(chunk: string): void {
    // Keep only the tail: old content this far back can never combine with
    // new content to form a signal we haven't already resolved.
    this.buffer = (this.buffer + chunk).slice(-BUFFER_CHARS);
    const found = extractContextLeftPercent(this.buffer);
    if (found !== null) this.percentLeft = found;
  }

  /** The most recent valid "% context left" reading seen so far, or `null`
   * if none has arrived yet this tracker's lifetime (a fresh session, an
   * agent that hasn't reached its composer yet, or simply no data — all
   * read the same honest way: nothing to show). */
  current(): number | null {
    return this.percentLeft;
  }

  /** Resets to the fresh state — a new pty session's output has nothing to
   * do with a previous one's context usage, so `Terminal.tsx` creates a
   * brand new tracker per session mount rather than reusing one, but this
   * is exposed too in case a caller ever needs to reset one in place. */
  clear(): void {
    this.buffer = "";
    this.percentLeft = null;
  }
}
