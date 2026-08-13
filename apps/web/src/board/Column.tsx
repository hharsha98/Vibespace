/**
 * One board column (docs/DESIGN.md §5 "Column header"): icon · uppercase
 * 10px label · count badge, all tinted by the column's status meaning
 * (`--idle`/`--warn`/`--info`/`--ok` — see `COLUMNS` in
 * `@vibedeck/shared`'s protocol.ts), a scrollable card list (a dnd-kit
 * `SortableContext` so cards can reorder within it and a `useDroppable` so
 * an EMPTY column can still be dropped onto), and an inline "+ Add task"
 * form pinned to the bottom — never `window.prompt`, per DESIGN.md's own
 * ban on native dialogs.
 */
import { useState, type CSSProperties } from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { AgentId, BoardCard, CardPriority, ColumnId, SessionInfo } from "@vibedeck/shared";
import type { AgentOption } from "../grid/PaneView.js";
import { Pill, statusColorVar, type StatusKind } from "../shell/ui.js";
import Card from "./Card.js";

export interface ColumnProps {
  id: ColumnId;
  label: string;
  meaning: StatusKind;
  cards: BoardCard[];
  agents: AgentOption[];
  defaultAgent: AgentId | "";
  dispatchingId: string | null;
  sessionsById: Map<string, SessionInfo>;
  onAddCard: (columnId: ColumnId, title: string) => void;
  onDeleteCard: (id: string) => void;
  onDispatchCard: (card: BoardCard, agent: AgentId) => void;
  /** PATCHes a card's title/description/taskKnowledge/priority — see
   * Board.tsx's `updateCard` (this is that same function, threaded straight
   * through, same as every other card action here). */
  onUpdateCard: (
    id: string,
    patch: { title: string; description: string | null; taskKnowledge: string | null; priority: CardPriority }
  ) => Promise<BoardCard>;
  onFocusSession: (sessionId: string) => void;
}

export default function Column({
  id,
  label,
  meaning,
  cards,
  agents,
  defaultAgent,
  dispatchingId,
  sessionsById,
  onAddCard,
  onDeleteCard,
  onDispatchCard,
  onUpdateCard,
  onFocusSession,
}: ColumnProps) {
  // A droppable id distinct from any card id (`column:<id>`), so dropping
  // onto empty space below the last card — or into a wholly empty column,
  // which has no card to drop ONTO — still resolves to a valid drop target.
  // `data.columnId` is what Board.tsx's onDragEnd actually reads.
  const { setNodeRef } = useDroppable({ id: `column:${id}`, data: { type: "column", columnId: id } });

  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");

  const submit = () => {
    const trimmed = title.trim();
    setAdding(false);
    setTitle("");
    if (trimmed) onAddCard(id, trimmed);
  };

  const tint = statusColorVar(meaning);

  return (
    <div style={columnStyle}>
      <div style={headerStyle}>
        <ColumnIcon id={id} color={tint} />
        <span style={{ ...labelStyle, color: tint }}>{label}</span>
        <div style={{ flex: 1 }} />
        <Pill status={meaning}>{cards.length}</Pill>
      </div>

      <div ref={setNodeRef} style={listStyle}>
        <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
          {cards.length === 0 && <p style={emptyStyle}>No cards here yet.</p>}
          {cards.map((card) => (
            <Card
              key={card.id}
              card={card}
              columnId={id}
              agents={agents}
              defaultAgent={defaultAgent}
              dispatching={dispatchingId === card.id}
              session={card.sessionId ? (sessionsById.get(card.sessionId) ?? null) : null}
              onDelete={onDeleteCard}
              onDispatch={onDispatchCard}
              onUpdate={onUpdateCard}
              onFocusSession={onFocusSession}
            />
          ))}
        </SortableContext>
      </div>

      <div style={addFormWrapStyle}>
        {adding ? (
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              if (e.key === "Escape") {
                setAdding(false);
                setTitle("");
              }
            }}
            onBlur={submit}
            placeholder="Task title"
            style={inputStyle}
          />
        ) : (
          <button type="button" onClick={() => setAdding(true)} style={addButtonStyle}>
            + Add task
          </button>
        )}
      </div>
    </div>
  );
}

/** A small, per-column glyph — deliberately plain inline SVG (no icon
 * library), 12px, `stroke="currentColor"` so it inherits the header's tint
 * from its wrapping element's `color`. */
function ColumnIcon({ id, color }: { id: ColumnId; color: string }) {
  const common = { width: 12, height: 12, viewBox: "0 0 12 12", fill: "none", "aria-hidden": true, style: { color } };
  switch (id) {
    case "todo":
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      );
    case "in_progress":
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.2" />
          <path d="M6 6 L6 2.5 A3.5 3.5 0 0 1 9 7.5 Z" fill="currentColor" />
        </svg>
      );
    case "in_review":
      return (
        <svg {...common}>
          <path
            d="M1 6 C2.5 3 4.2 2 6 2 C7.8 2 9.5 3 11 6 C9.5 9 7.8 10 6 10 C4.2 10 2.5 9 1 6 Z"
            stroke="currentColor"
            strokeWidth="1.1"
          />
          <circle cx="6" cy="6" r="1.6" fill="currentColor" />
        </svg>
      );
    case "complete":
      return (
        <svg {...common}>
          <path d="M2 6.2 L4.8 9 L10 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "cancelled":
      // A plain X in a circle — reads as "stopped/abandoned" (docs/DESIGN.md
      // §2's `--danger` meaning, already applied via `color` from the
      // header's own tint) without borrowing the visual weight of a real
      // error glyph like a triangle-bang, which this isn't: a cancelled
      // card isn't broken, it's just not being worked on any more.
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.2" />
          <path d="M4.2 4.2 L7.8 7.8 M7.8 4.2 L4.2 7.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      );
  }
}

const columnStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
  height: "100%",
  flex: 1,
  minWidth: 220,
  background: "var(--vd-surface)",
  border: "1px solid var(--vd-border)",
  borderRadius: 6,
  overflow: "hidden",
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  height: 30,
  padding: "0 8px",
  flexShrink: 0,
  borderBottom: "1px solid var(--vd-border)",
};

const labelStyle: CSSProperties = {
  fontSize: 10,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  fontWeight: 600,
};

const listStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  padding: 8,
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const emptyStyle: CSSProperties = {
  margin: 0,
  fontSize: 11,
  color: "var(--vd-text-faint)",
  textAlign: "center",
  padding: "8px 4px",
};

const addFormWrapStyle: CSSProperties = {
  flexShrink: 0,
  padding: 8,
  borderTop: "1px solid var(--vd-border)",
};

const addButtonStyle: CSSProperties = {
  width: "100%",
  textAlign: "left",
  background: "transparent",
  border: "none",
  color: "var(--vd-text-faint)",
  fontSize: 12,
  padding: "4px 2px",
  cursor: "pointer",
};

const inputStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "var(--vd-bg)",
  color: "var(--vd-text)",
  border: "1px solid var(--vd-border)",
  borderRadius: 4,
  padding: "5px 8px",
  fontSize: 12,
};
