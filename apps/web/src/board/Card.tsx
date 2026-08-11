/**
 * One board card (docs/DESIGN.md §5 "Board card"): `--surface-raised`
 * background, 6px radius, 8px padding, a 2-line-clamped title, an optional
 * 2-line-clamped muted description, and a priority `Pill` bottom-left.
 * Delete and Dispatch are secondary/destructive controls, so — same rule as
 * a pane's title-bar icon row — they only show on hover (`.vd-board-card`/
 * `.vd-board-card-actions` in shell/ui.tsx's `GlobalShellStyles`), not
 * permanently.
 *
 * Drag-and-drop is wired directly onto the card's root element via dnd-kit's
 * `useSortable` (the whole card is the drag handle, matching how a real
 * kanban board works), with `data: { type: "card", columnId }` so
 * `Board.tsx`'s `onDragEnd` can tell which column a drop target belongs to
 * without a separate lookup. Interactive children (the delete/dispatch
 * buttons, the agent picker, the session indicator) stop pointerdown
 * propagation so clicking them doesn't get hijacked as a drag start.
 */
import { useState, type CSSProperties } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { AgentId, BoardCard, ColumnId, SessionInfo } from "@vibedeck/shared";
import type { AgentOption } from "../grid/PaneView.js";
import { Pill, StatusDot, sessionStatusKind, type StatusKind } from "../shell/ui.js";

const PRIORITY_STATUS: Record<BoardCard["priority"], StatusKind> = {
  critical: "danger",
  high: "warn",
  medium: "info",
  low: "idle",
};

export interface CardProps {
  card: BoardCard;
  columnId: ColumnId;
  agents: AgentOption[];
  defaultAgent: AgentId | "";
  dispatching: boolean;
  /** Looked up by Board.tsx from the app's live `sessions` list, or null if
   * this card isn't dispatched yet (or the session hasn't loaded locally
   * yet — see Board.tsx's dispatch flow for why that lookup can briefly
   * miss). */
  session: SessionInfo | null;
  onDelete: (id: string) => void;
  onDispatch: (card: BoardCard, agent: AgentId) => void;
  onFocusSession: (sessionId: string) => void;
}

export default function Card({
  card,
  columnId,
  agents,
  defaultAgent,
  dispatching,
  session,
  onDelete,
  onDispatch,
  onFocusSession,
}: CardProps) {
  const [pickingAgent, setPickingAgent] = useState(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
    data: { type: "card", columnId },
  });

  const style: CSSProperties = {
    ...cardStyle,
    transform: CSS.Transform.toString(transform),
    transition: transition ?? undefined,
    opacity: isDragging ? 0.5 : 1,
  };

  const availableAgents = agents.filter((a) => a.available);
  // A card that's already dispatched is assumed running unless the app's
  // own session list says otherwise — it was just spawned server-side, so
  // there's usually a brief window before that list catches up.
  const statusKind = session ? sessionStatusKind(session.status) : "ok";

  return (
    <div ref={setNodeRef} style={style} className="vd-board-card" {...attributes} {...listeners}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
        <p style={titleStyle}>{card.title}</p>
        <div
          className="vd-board-card-actions"
          style={{ display: "flex", gap: 2, flexShrink: 0 }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {!card.sessionId && (
            <button
              type="button"
              title="Dispatch to an agent"
              onClick={() => setPickingAgent((v) => !v)}
              style={miniIconButtonStyle}
            >
              ▶
            </button>
          )}
          <button type="button" title="Delete card" onClick={() => onDelete(card.id)} style={miniIconButtonStyle}>
            ✕
          </button>
        </div>
      </div>

      {card.description && <p style={descriptionStyle}>{card.description}</p>}

      {pickingAgent && !card.sessionId && (
        <div style={agentPickerStyle} onPointerDown={(e) => e.stopPropagation()}>
          {availableAgents.length === 0 && (
            <span style={{ fontSize: 11, color: "var(--vd-text-faint)" }}>No agents installed</span>
          )}
          {availableAgents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              disabled={dispatching}
              onClick={() => {
                setPickingAgent(false);
                onDispatch(card, agent.id);
              }}
              style={agentButtonStyle(agent.id === defaultAgent)}
            >
              {agent.displayName}
            </button>
          ))}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 6, gap: 6 }}>
        <Pill status={PRIORITY_STATUS[card.priority]}>{card.priority}</Pill>
        {card.sessionId && card.agent && (
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onFocusSession(card.sessionId!)}
            title="Jump to this session's terminal"
            style={sessionIndicatorStyle}
          >
            <StatusDot status={statusKind} />
            <span>{card.agent}</span>
          </button>
        )}
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = {
  background: "var(--vd-surface-raised)",
  border: "1px solid var(--vd-border)",
  borderRadius: 6,
  padding: 8,
  cursor: "grab",
  userSelect: "none",
};

const titleStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  margin: 0,
  fontSize: 12,
  color: "var(--vd-text)",
  lineHeight: 1.35,
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
};

const descriptionStyle: CSSProperties = {
  margin: "4px 0 0",
  fontSize: 11,
  color: "var(--vd-text-muted)",
  lineHeight: 1.4,
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
};

const miniIconButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 18,
  height: 18,
  padding: 0,
  background: "transparent",
  border: "none",
  borderRadius: 3,
  color: "var(--vd-text-faint)",
  fontSize: 10,
  cursor: "pointer",
};

const agentPickerStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 4,
  marginTop: 6,
  padding: 6,
  background: "var(--vd-bg)",
  border: "1px solid var(--vd-border)",
  borderRadius: 4,
};

function agentButtonStyle(isDefault: boolean): CSSProperties {
  return {
    fontSize: 11,
    padding: "2px 8px",
    borderRadius: 4,
    background: isDefault ? "var(--vd-accent)" : "transparent",
    color: isDefault ? "var(--vd-accent-text)" : "var(--vd-text)",
    border: isDefault ? "1px solid var(--vd-accent)" : "1px solid var(--vd-border)",
    cursor: "pointer",
  };
}

const sessionIndicatorStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: 0,
  background: "transparent",
  border: "none",
  color: "var(--vd-text-muted)",
  fontSize: 11,
  cursor: "pointer",
  flexShrink: 0,
};
