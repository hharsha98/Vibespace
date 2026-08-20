/**
 * The per-pane prompt bar (Phase 9.5a, part 1 — docs/PARITY.md #13a): a
 * ~28px input strip under every pane with a live session. Typing here and
 * pressing Enter writes the text into THAT pane's pty — the same input path
 * as typing directly into the terminal (see Terminal.tsx's `sendToSocket`)
 * — except that submitting while the agent looks busy queues the prompt
 * instead of sending it immediately (Terminal.tsx owns that decision via
 * `promptQueue.ts`; this component is deliberately dumb about WHY it's
 * showing "queued" — it just renders whatever state it's handed).
 *
 * Pure presentation + one local text-input value; all the actual queueing
 * logic lives in `promptQueue.ts` and is driven by `Terminal.tsx`, so this
 * component has no state machine of its own to get wrong.
 */
import { useMemo, useState } from "react";
import { Pill } from "../shell/ui.js";
import { MOTION, RADIUS, SHADOW_VAR } from "../shell/tokens.js";
import type { AgentStatus } from "./promptQueue.js";
import { matchCommandHistory } from "./commandHistory.js";

interface PromptBarProps {
  status: AgentStatus;
  /** How many prompts are currently queued, waiting for the agent to go idle. */
  queuedCount: number;
  /** Display name of the agent this bar talks to (e.g. "Shell", "Claude Code") — used in the placeholder copy. */
  agentDisplayName: string;
  /** Whether this bar's own pane is the focused one — dims the whole bar
   * slightly when it isn't (terminal-chrome pass), the same treatment
   * Terminal.tsx's own Live/Blocks toggle gets; see that prop's doc comment
   * on `TerminalProps` for the full "why opacity, not a glow" reasoning. */
  isFocused: boolean;
  /** This pane's workspace's command history, newest-first — BridgeSpace
   * parity item 4. Fetched/maintained by Terminal.tsx (one GET per
   * workspace, plus an optimistic local prepend on every submit — see that
   * file's "Command history" comment); this component only ever reads it,
   * via `matchCommandHistory` (commandHistory.ts), never fetches or writes
   * it itself. Empty array (not undefined) for the common "no workspace"/
   * "nothing recorded yet" case, so this component never needs a separate
   * "history not loaded" branch. */
  history: string[];
  /** Submits `text` — Terminal.tsx decides whether that means "send now" or "queue it". */
  onSubmit: (text: string) => void;
  /** Empties the queue (the Pill's own clear affordance). */
  onClearQueue: () => void;
  /** Escape was pressed while the bar had focus — Terminal.tsx uses this to
   * refocus the terminal itself, per the phase spec ("Escape in the bar
   * returns focus to the terminal"). Also what the history dropdown's
   * SECOND Escape (after the first one just dismisses the dropdown) falls
   * through to — see the `onKeyDown` handler below. */
  onEscape: () => void;
}

export default function PromptBar({
  status,
  queuedCount,
  agentDisplayName,
  isFocused,
  history,
  onSubmit,
  onClearQueue,
  onEscape,
}: PromptBarProps) {
  const [value, setValue] = useState("");
  // BridgeSpace parity item 4 — command-history autocomplete. Three bits of
  // local state, deliberately simple (per the phase's own "keep it simple
  // and predictable" instruction — no fuzzy ranking, no persisted UI state):
  //   - `suggestions` is DERIVED (useMemo), not stored — it's always exactly
  //     `matchCommandHistory(history, value)`, so it can never drift out of
  //     sync with what's actually typed.
  //   - `highlightedIndex` is which suggestion Up/Down/Tab/Enter currently
  //     act on; clamped (not reset via an effect) so a stale index left
  //     over from a longer list never points past the end of a shorter one.
  //   - `dismissed` is the "dismissible" requirement: Escape hides the
  //     dropdown for the CURRENT value without clearing the input; typing
  //     further (a new `value`) clears it again, since a changed value means
  //     a genuinely different set of suggestions to (re-)offer.
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const suggestions = useMemo(() => matchCommandHistory(history, value), [history, value]);
  const suggestionsVisible = !dismissed && suggestions.length > 0;
  const clampedIndex = Math.min(highlightedIndex, Math.max(suggestions.length - 1, 0));

  const submit = () => {
    const text = value.trim();
    if (!text) return;
    onSubmit(text);
    setValue("");
  };

  /** Fills the input with `command` (Tab, or Enter while a suggestion is
   * highlighted) — does NOT submit. A second Enter then runs it, same "you
   * see exactly what you're about to run before it runs" idiom a shell's
   * own history search (Ctrl+R) uses. Note this doesn't need to also hide
   * the dropdown by hand: once `value` becomes `command` exactly,
   * `matchCommandHistory` itself excludes an entry equal to the current
   * input (see that function's own doc comment), so `suggestions` becomes
   * empty on the very next render — no separate "dismiss after accept"
   * bookkeeping required. */
  const acceptSuggestion = (command: string) => {
    setValue(command);
    setHighlightedIndex(0);
  };

  const placeholder =
    status === "working"
      ? `${agentDisplayName} is working — queue the next prompt…`
      : `Prompt ${agentDisplayName}…`;

  return (
    <div
      // Terminal-chrome pass: this bar now dims (opacity only, no glow —
      // same reasoning as Terminal.tsx's Live/Blocks toggle) when its pane
      // isn't the focused one, so the whole pane's own chrome recedes
      // together instead of only the outer 1px border reacting to focus.
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        gap: 6,
        height: 28,
        flexShrink: 0,
        padding: "0 6px",
        borderTop: "1px solid var(--vd-border)",
        background: "var(--vd-surface)",
        boxSizing: "border-box",
        opacity: isFocused ? 1 : 0.7,
        transition: `opacity ${MOTION.fast} ${MOTION.easing}`,
      }}
    >
      {/* History-autocomplete dropdown (BridgeSpace parity item 4). Opens
          UPWARD (bottom: "100%", not top) — this bar sits at the very
          bottom of its pane, so a downward dropdown would render outside
          the pane entirely. Styled like Terminal.tsx's own floating chrome
          (context menu / search box): `--vd-surface-raised` + RADIUS.sm +
          SHADOW_VAR, never a hardcoded colour. */}
      {suggestionsVisible && (
        <ul
          className="vd-fade-in"
          role="listbox"
          style={{
            position: "absolute",
            bottom: "100%",
            left: 6,
            right: 6,
            marginBottom: 4,
            background: "var(--vd-surface-raised)",
            border: "1px solid var(--vd-border)",
            borderRadius: RADIUS.sm,
            boxShadow: SHADOW_VAR.md,
            padding: "4px 0",
            margin: "0 6px 4px",
            listStyle: "none",
            maxHeight: 160,
            overflowY: "auto",
            zIndex: 10,
          }}
        >
          {suggestions.map((command, index) => (
            <li
              key={command}
              role="option"
              aria-selected={index === clampedIndex}
              // Mouse users get the same accept behaviour keyboard users
              // do — but Tab/Enter (below) is what satisfies the phase's
              // "keyboard-driven" requirement; this just doesn't make the
              // mouse path worse.
              onMouseDown={(e) => {
                // mousedown (not click) so this fires BEFORE the input's
                // own blur — a click alone would blur the input first,
                // which unmounts this dropdown before the click can land.
                e.preventDefault();
                acceptSuggestion(command);
              }}
              onMouseEnter={() => setHighlightedIndex(index)}
              style={{
                padding: "5px 10px",
                cursor: "pointer",
                fontSize: 12,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                color: index === clampedIndex ? "var(--vd-accent-text)" : "var(--vd-text)",
                background: index === clampedIndex ? "var(--vd-accent)" : "transparent",
              }}
            >
              {command}
            </li>
          ))}
        </ul>
      )}
      <input
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setHighlightedIndex(0);
          setDismissed(false); // Typing further re-offers suggestions for the NEW value.
        }}
        onKeyDown={(e) => {
          // Don't let Enter/Escape/Arrows/Tab reach xterm or the global
          // shortcut handler — this bar owns all of them while it has
          // focus.
          if (e.key === "ArrowDown" && suggestionsVisible) {
            e.preventDefault();
            setHighlightedIndex((i) => Math.min(i + 1, suggestions.length - 1));
            return;
          }
          if (e.key === "ArrowUp" && suggestionsVisible) {
            e.preventDefault();
            setHighlightedIndex((i) => Math.max(i - 1, 0));
            return;
          }
          if (e.key === "Tab" && suggestionsVisible) {
            // Tab always ACCEPTS, never submits — the standard shell-
            // autocomplete convention. Unhandled (dropdown not visible),
            // Tab still moves focus normally.
            e.preventDefault();
            acceptSuggestion(suggestions[clampedIndex]);
            return;
          }
          if (e.key === "Enter") {
            e.preventDefault();
            if (suggestionsVisible) {
              // First Enter accepts the highlighted suggestion (fills the
              // input); a second Enter — now with no matching suggestion
              // left, see `acceptSuggestion`'s doc comment — runs it. This
              // never runs something the user didn't see filled in first.
              acceptSuggestion(suggestions[clampedIndex]);
            } else {
              submit();
            }
            return;
          }
          if (e.key === "Escape") {
            e.preventDefault();
            if (suggestionsVisible) {
              // First Escape only dismisses the dropdown (the
              // "dismissible" requirement) — the SECOND Escape (dropdown
              // already hidden) is what falls through to the pre-existing
              // "return focus to the terminal" behaviour, unchanged from
              // before this feature existed.
              setDismissed(true);
            } else {
              onEscape();
            }
          }
        }}
        placeholder={placeholder}
        // The queue this bar feeds is client-side only and lost on reload
        // (see promptQueue.ts's top comment) — the working/idle placeholder
        // above is what tells the user WHY a submitted prompt might sit
        // unsent for a while, rather than claiming any durability it doesn't have.
        // "vd-prompt-input" (GlobalShellStyles) is what gives this input its
        // OWN :focus border-color response — a real form-control focus
        // ring, unrelated to (and not a substitute for) the pane-level
        // focus border docs/DESIGN.md §5 owns; this is standard input
        // affordance, not a second pane-focus cue.
        className="vd-prompt-input"
        style={{
          flex: 1,
          minWidth: 0,
          background: "var(--vd-bg)",
          color: "var(--vd-text)",
          border: "1px solid var(--vd-border)",
          borderRadius: 4,
          padding: "3px 8px",
          fontSize: 12,
          height: 20,
          boxSizing: "border-box",
          transition: `border-color ${MOTION.fast} ${MOTION.easing}`,
        }}
      />
      {queuedCount > 0 && (
        <button
          type="button"
          onClick={onClearQueue}
          title="Clear queued prompts"
          className="vd-fade-in"
          style={{
            background: "transparent",
            border: "none",
            cursor: "pointer",
            padding: 0,
            flexShrink: 0,
          }}
        >
          <Pill status="warn">{queuedCount} queued ✕</Pill>
        </button>
      )}
    </div>
  );
}
