/**
 * Pure logic behind the character-count indicators Phase 9.5b's new forms
 * use (the Agents page's system prompt, the board card editor's
 * description/taskKnowledge fields) — no DOM, so it's unit-testable under
 * plain Node/vitest, same constraint every other pure-logic module in this
 * app lives under (see keymap.ts's top comment for why: CI runs on
 * ubuntu-latest with no browser).
 */

export type CharCountStatus = "idle" | "warn" | "danger";

/** How close to a hard cap a counter should start reading as a warning
 * (docs/DESIGN.md's `--warn` token) rather than plain muted text — 90% was
 * picked so the counter stays quiet for the vast majority of typing and
 * only changes colour once running out really is a near-term concern. */
const WARN_THRESHOLD_RATIO = 0.9;

/**
 * What state a "N / MAX" counter is in: `idle` (quiet, muted text) below
 * 90% of the cap, `warn` from 90% up to the cap, `danger` once text is
 * actually over it. `danger` should rarely be reachable in practice — every
 * caller also sets the textarea's `maxLength` to the same cap, which
 * already stops typing (and most paste-driven) input past the limit — but
 * this stays honest about the over-cap case anyway rather than assuming
 * `maxLength` is airtight (it isn't, for e.g. programmatic value changes).
 */
export function charCountStatus(length: number, max: number): CharCountStatus {
  if (length > max) return "danger";
  if (length >= max * WARN_THRESHOLD_RATIO) return "warn";
  return "idle";
}

/** Maps a `CharCountStatus` to the CSS colour a counter's text should
 * render as. Kept separate from `charCountStatus` itself so the pure
 * length-vs-max decision stays testable without also asserting on colour
 * strings. */
export function charCountColor(status: CharCountStatus): string {
  switch (status) {
    case "danger":
      return "var(--vd-danger)";
    case "warn":
      return "var(--vd-warn)";
    case "idle":
      return "var(--vd-text-faint)";
  }
}
