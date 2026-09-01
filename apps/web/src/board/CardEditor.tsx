/**
 * The board card detail editor (Phase 9.5b, PARITY #27b) — an overlay panel
 * (docs/DESIGN.md §6 rule 5 bans native dialogs; this follows the same
 * fixed-backdrop + centred-panel shell as KeyboardCheatSheet.tsx/
 * ThemePicker.tsx) opened from a card's new "Edit" (✎) action in Card.tsx.
 *
 * Before this phase, the web board had NO way to set a card's
 * `description`/`taskKnowledge`/`priority` at all — Column.tsx's "+ Add
 * task" form only ever sends a `title` (see Board.tsx's `addCard`), and
 * PATCHing the other fields was only reachable via the REST API directly
 * (an agent updating its own card, per docs/AGENT-API.md) or MCP. This is
 * therefore the first real "edit a card" surface, not an addition to an
 * existing one — see this phase's own report for why.
 *
 * `description` ("what to do") and `taskKnowledge` ("reference context the
 * agent gets" — architecture notes, file paths, API specs) are kept in
 * clearly separate, clearly labelled fields per the phase spec, each with
 * its own live character counter against the shared
 * `CARD_DESCRIPTION_MAX_LENGTH`/`CARD_TASK_KNOWLEDGE_MAX_LENGTH` caps
 * (`@vibespace/shared` — never hard-coded here) — same
 * `textLimits.ts`/`AGENT_PROFILE_SYSTEM_PROMPT_MAX_LENGTH` counter pattern
 * Agents.tsx uses for its system prompt.
 */
import { useEffect, useState, type CSSProperties } from "react";
import {
  CARD_DESCRIPTION_MAX_LENGTH,
  CARD_PRIORITIES,
  CARD_TASK_KNOWLEDGE_MAX_LENGTH,
  type BoardCard,
  type CardPriority,
} from "@vibespace/shared";
import { charCountColor, charCountStatus } from "../shell/textLimits.js";
import { SHADOW_VAR } from "../shell/tokens.js";

export interface CardEditorProps {
  card: BoardCard;
  saving: boolean;
  /** Server-side error (validation, 404) surfaced by the caller — same
   * "readable message, not a raw JSON blob" rule as Agents.tsx/Prompts.tsx. */
  error: string | null;
  onSave: (patch: {
    title: string;
    description: string | null;
    taskKnowledge: string | null;
    priority: CardPriority;
  }) => void;
  onClose: () => void;
}

export default function CardEditor({ card, saving, error, onClose, onSave }: CardEditorProps) {
  const [title, setTitle] = useState(card.title);
  const [description, setDescription] = useState(card.description ?? "");
  const [taskKnowledge, setTaskKnowledge] = useState(card.taskKnowledge ?? "");
  const [priority, setPriority] = useState<CardPriority>(card.priority);

  // Restore whatever had focus before this overlay opened, same as every
  // other overlay in the app (KeyboardCheatSheet.tsx, ThemePicker.tsx,
  // OverlayPalette.tsx) — but unlike those, this one does NOT focus its own
  // panel on mount: the title `<input>` below has its own `autoFocus`, and
  // stealing focus onto the panel div here (after that input already took
  // it) would just knock the cursor back out of the field the user's about
  // to type into.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    return () => {
      previouslyFocused?.focus();
    };
  }, []);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  const descriptionStatus = charCountStatus(description.length, CARD_DESCRIPTION_MAX_LENGTH);
  const taskKnowledgeStatus = charCountStatus(taskKnowledge.length, CARD_TASK_KNOWLEDGE_MAX_LENGTH);

  const trimmedTitle = title.trim();
  const canSave =
    trimmedTitle.length > 0 &&
    description.length <= CARD_DESCRIPTION_MAX_LENGTH &&
    taskKnowledge.length <= CARD_TASK_KNOWLEDGE_MAX_LENGTH;

  const submit = () => {
    if (!canSave || saving) return;
    onSave({
      title: trimmedTitle,
      description: description.trim() ? description : null,
      taskKnowledge: taskKnowledge.trim() ? taskKnowledge : null,
      priority,
    });
  };

  return (
    <div
      onClick={onClose}
      // Card.tsx renders this overlay as a DOM child of the card's own root
      // element, which has dnd-kit's drag `listeners` (pointerdown-based)
      // spread onto it for the whole-card-is-the-drag-handle behaviour (see
      // Card.tsx's top comment). Without stopping propagation here, any
      // pointerdown inside this overlay — including just clicking into a
      // textarea to select text — would bubble up to that handle and could
      // start "dragging" the card underneath the modal. Same reasoning
      // Card.tsx's own `agentPickerStyle` wrapper already applies to its
      // pointerdown handler.
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        className="vd-scale-in"
        style={{
          width: "min(560px, 92vw)",
          maxHeight: "85vh",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          background: "var(--vd-surface-raised)",
          border: "1px solid var(--vd-border)",
          borderRadius: 10,
          boxShadow: SHADOW_VAR.lg,
          padding: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <strong style={{ color: "var(--vd-text)", fontSize: 13 }}>Edit card</strong>
          <button type="button" onClick={onClose} style={closeButtonStyle} title="Close (Esc)">
            ✕
          </button>
        </div>

        <label style={labelStyle}>
          <span style={labelTextStyle}>Title</span>
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} style={inputStyle} />
        </label>

        <label style={labelStyle}>
          <span style={labelTextStyle}>Priority</span>
          <select value={priority} onChange={(e) => setPriority(e.target.value as CardPriority)} style={inputStyle}>
            {CARD_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>

        <label style={labelStyle}>
          <div style={counterRowStyle}>
            <span style={labelTextStyle}>Description — what to do</span>
            <span style={{ fontSize: 11, color: charCountColor(descriptionStatus) }}>
              {description.length.toLocaleString()} / {CARD_DESCRIPTION_MAX_LENGTH.toLocaleString()}
            </span>
          </div>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={CARD_DESCRIPTION_MAX_LENGTH}
            placeholder="A short instruction — what should get done."
            rows={4}
            style={textareaStyle}
          />
        </label>

        <label style={labelStyle}>
          <div style={counterRowStyle}>
            <span style={labelTextStyle}>Task knowledge — reference context the agent gets</span>
            <span style={{ fontSize: 11, color: charCountColor(taskKnowledgeStatus) }}>
              {taskKnowledge.length.toLocaleString()} / {CARD_TASK_KNOWLEDGE_MAX_LENGTH.toLocaleString()}
            </span>
          </div>
          <textarea
            value={taskKnowledge}
            onChange={(e) => setTaskKnowledge(e.target.value)}
            maxLength={CARD_TASK_KNOWLEDGE_MAX_LENGTH}
            placeholder="Architecture notes, file paths, API specs, links — background the agent should read alongside the description, not part of the instruction itself."
            rows={10}
            style={{ ...textareaStyle, fontFamily: "monospace", fontSize: 11 }}
          />
        </label>

        {error && <p style={errorStyle}>{error}</p>}

        <div style={{ display: "flex", gap: 6 }}>
          <button type="button" onClick={submit} disabled={!canSave || saving} style={primaryButtonStyle}>
            {saving ? "Saving…" : "Save"}
          </button>
          <button type="button" onClick={onClose} style={secondaryButtonStyle}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

const counterRowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
  gap: 8,
};

const labelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 12,
};

const labelTextStyle: CSSProperties = {
  fontSize: 11,
  color: "var(--vd-text-muted)",
};

const inputStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "var(--vd-bg)",
  color: "var(--vd-text)",
  border: "1px solid var(--vd-border)",
  borderRadius: 4,
  padding: "6px 8px",
  fontSize: 12,
};

const textareaStyle: CSSProperties = {
  ...inputStyle,
  lineHeight: 1.5,
  resize: "vertical",
};

const errorStyle: CSSProperties = {
  fontSize: 11,
  color: "var(--vd-danger)",
  margin: 0,
};

const primaryButtonStyle: CSSProperties = {
  background: "var(--vd-accent)",
  color: "var(--vd-accent-text)",
  border: "none",
  borderRadius: 4,
  padding: "5px 14px",
  fontSize: 12,
  cursor: "pointer",
};

const secondaryButtonStyle: CSSProperties = {
  background: "transparent",
  color: "var(--vd-text-muted)",
  border: "1px solid var(--vd-border)",
  borderRadius: 4,
  padding: "5px 14px",
  fontSize: 12,
  cursor: "pointer",
};

const closeButtonStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--vd-text-muted)",
  cursor: "pointer",
  fontSize: 12,
};
