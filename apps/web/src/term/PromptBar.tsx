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
import { useState } from "react";
import { Pill } from "../shell/ui.js";
import type { AgentStatus } from "./promptQueue.js";

interface PromptBarProps {
  status: AgentStatus;
  /** How many prompts are currently queued, waiting for the agent to go idle. */
  queuedCount: number;
  /** Display name of the agent this bar talks to (e.g. "Shell", "Claude Code") — used in the placeholder copy. */
  agentDisplayName: string;
  /** Submits `text` — Terminal.tsx decides whether that means "send now" or "queue it". */
  onSubmit: (text: string) => void;
  /** Empties the queue (the Pill's own clear affordance). */
  onClearQueue: () => void;
  /** Escape was pressed while the bar had focus — Terminal.tsx uses this to
   * refocus the terminal itself, per the phase spec ("Escape in the bar
   * returns focus to the terminal"). */
  onEscape: () => void;
}

export default function PromptBar({
  status,
  queuedCount,
  agentDisplayName,
  onSubmit,
  onClearQueue,
  onEscape,
}: PromptBarProps) {
  const [value, setValue] = useState("");

  const submit = () => {
    const text = value.trim();
    if (!text) return;
    onSubmit(text);
    setValue("");
  };

  const placeholder =
    status === "working"
      ? `${agentDisplayName} is working — queue the next prompt…`
      : `Prompt ${agentDisplayName}…`;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        height: 28,
        flexShrink: 0,
        padding: "0 6px",
        borderTop: "1px solid var(--vd-border)",
        background: "var(--vd-surface)",
        boxSizing: "border-box",
      }}
    >
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          // Don't let Enter/Escape reach xterm or the global shortcut
          // handler — this bar owns both while it has focus.
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onEscape();
          }
        }}
        placeholder={placeholder}
        // The queue this bar feeds is client-side only and lost on reload
        // (see promptQueue.ts's top comment) — the working/idle placeholder
        // above is what tells the user WHY a submitted prompt might sit
        // unsent for a while, rather than claiming any durability it doesn't have.
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
        }}
      />
      {queuedCount > 0 && (
        <button
          type="button"
          onClick={onClearQueue}
          title="Clear queued prompts"
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
