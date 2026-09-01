/**
 * Phase 7: the board — a 4th centre view (Terminals | Editor | Preview |
 * Board, see App.tsx's `CenterView`) showing tasks in four columns
 * (docs/DESIGN.md §5), backed by `GET/POST/PATCH/DELETE /api/board/cards`.
 *
 * State ownership follows the same pattern as Editor.tsx/Preview.tsx (the
 * other centre views): this component fetches and owns its own data given
 * just a `workspaceId`, rather than having App.tsx lift board state the way
 * WorkspaceRail's create-workspace form is lifted — there's no OTHER
 * consumer of "the current list of board cards" the way the grid and the
 * command palette both need workspace state, so there's nothing to share it
 * with.
 *
 * Drag-and-drop (reorder within a column, move between columns) persists via
 * PATCH with a client-computed fractional position (`midpointPosition`
 * below) — see apps/server/src/db/board.ts's top comment for why positions
 * are fractional rather than integer row numbers, and why a value that
 * doesn't exactly match the server's own spacing is fine (BoardStore
 * renormalizes a column's positions itself if a gap ever gets too small).
 *
 * Dropping an un-dispatched card into In Progress — or clicking its
 * "Dispatch" control — spawns an agent session for it via
 * `POST /api/board/cards/:id/dispatch`. This file only owns the UI/HTTP
 * side of that; the actual "wait for the pty to be ready, then type the
 * prompt in" race is handled server-side, see
 * apps/server/src/board/dispatch.ts.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import {
  COLUMNS,
  type AgentId,
  type BoardCard,
  type CardPriority,
  type ColumnId,
  type SessionInfo,
} from "@vibespace/shared";
import type { AgentOption } from "../grid/PaneView.js";
import { FONT, SPACE } from "../shell/tokens.js";
import { StatusDot } from "../shell/ui.js";
import Column from "./Column.js";

export interface BoardProps {
  workspaceId: string | null;
  agents: AgentOption[];
  defaultAgent: AgentId | "";
  /** The app's live session list — used only to look up a dispatched
   * card's current running/exited status for its `StatusDot` (see
   * Card.tsx); Board.tsx never mutates this itself. */
  sessions: SessionInfo[];
  /** Fired once a dispatch actually created a session, so App.tsx can fold
   * it into the terminal grid (an existing empty pane, or a fresh one) the
   * same way starting an agent from an empty pane already does. */
  onSessionDispatched: (session: SessionInfo) => void;
  /** Fired when the user clicks a dispatched card's session indicator —
   * App.tsx switches to the Terminals view and focuses that pane. */
  onFocusSession: (sessionId: string) => void;
}

/** Spacing for a client-computed fractional position, mirroring the
 * server's own POSITION_GAP (apps/server/src/db/board.ts). Doesn't need to
 * match exactly — it only needs to be "a reasonably large gap"; the server
 * renormalizes a column if repeated inserts ever shrink a gap too far. */
const POSITION_GAP = 1000;

function midpointPosition(before: number | undefined, after: number | undefined): number {
  if (before === undefined && after === undefined) return POSITION_GAP;
  if (before === undefined) return after! - POSITION_GAP;
  if (after === undefined) return before + POSITION_GAP;
  return (before + after) / 2;
}

type LoadState = "loading" | "loaded" | "error";

export default function Board({
  workspaceId,
  agents,
  defaultAgent,
  sessions,
  onSessionDispatched,
  onFocusSession,
}: BoardProps) {
  const [cards, setCards] = useState<BoardCard[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dispatchingId, setDispatchingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) {
      setCards([]);
      setLoadState("loaded");
      return;
    }
    let cancelled = false;
    setLoadState("loading");
    setLoadError(null);
    fetch(`/api/board/cards?workspaceId=${encodeURIComponent(workspaceId)}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Server responded with ${res.status}`);
        }
        return (await res.json()) as { cards: BoardCard[] };
      })
      .then((body) => {
        if (cancelled) return;
        setCards(body.cards);
        setLoadState("loaded");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "Failed to load the board");
        setLoadState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const cardsByColumn = useMemo(() => {
    const map = new Map<ColumnId, BoardCard[]>();
    for (const column of COLUMNS) map.set(column.id, []);
    for (const card of cards) map.get(card.columnId)?.push(card);
    for (const list of map.values()) list.sort((a, b) => a.position - b.position);
    return map;
  }, [cards]);

  const sessionsById = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const addCard = useCallback(
    (columnId: ColumnId, title: string) => {
      if (!workspaceId) return;
      setActionError(null);
      fetch("/api/board/cards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, title, columnId }),
      })
        .then(async (res) => {
          if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as { error?: string };
            throw new Error(body.error ?? `Server responded with ${res.status}`);
          }
          return (await res.json()) as BoardCard;
        })
        .then((card) => setCards((prev) => [...prev, card]))
        .catch((err: unknown) => {
          setActionError(err instanceof Error ? err.message : "Failed to add card");
        });
    },
    [workspaceId]
  );

  const deleteCard = useCallback((id: string) => {
    setActionError(null);
    // Optimistic: the card leaves the board immediately, because deleting
    // should feel instant. But it comes BACK if the server refused, and
    // the reason is shown.
    //
    // Two things were wrong before. `.catch()` alone only fires on a
    // NETWORK failure — an HTTP 404 or 500 resolves normally, so a
    // server-side refusal was reported nowhere at all. And the card was
    // dropped from the UI either way, on the reasoning that un-deleting it
    // would be "more surprising" than leaving it gone. It isn't: the card
    // still exists on the server, so it reappears on the next load anyway.
    // Putting it back immediately, with an explanation, is the smaller
    // surprise — and the same fix the workspace delete needed.
    let removed: BoardCard | undefined;
    setCards((prev) => {
      removed = prev.find((c) => c.id === id);
      return prev.filter((c) => c.id !== id);
    });
    void (async () => {
      try {
        const res = await fetch(`/api/board/cards/${id}`, { method: "DELETE" });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Server responded with ${res.status}`);
        }
      } catch (err) {
        if (removed) {
          const card = removed;
          setCards((prev) => (prev.some((c) => c.id === card.id) ? prev : [...prev, card]));
        }
        setActionError(err instanceof Error ? err.message : "Failed to delete card");
      }
    })();
  }, []);

  // Phase 9.5b (PARITY #27b): PATCHes a card's title/description/
  // taskKnowledge/priority — see CardEditor.tsx, opened from Card.tsx's
  // "Edit" action. Unlike addCard/deleteCard/dispatchCard above, this
  // deliberately returns the fetch's Promise (and does NOT catch it) rather
  // than tracking its own saving/error state here — CardEditor is a modal
  // overlay with exactly one edit in flight at a time, so it's simpler for
  // Card.tsx to own that attempt's saving/error state locally (the same way
  // Card.tsx already owns `pickingAgent` locally) than to thread a
  // card-keyed "which id is updating" id through Board -> Column -> Card
  // the way `dispatchingId` has to (dispatch can be triggered from
  // anywhere: a card button OR a drag-into-In-Progress).
  const updateCard = useCallback(
    (
      id: string,
      patch: { title: string; description: string | null; taskKnowledge: string | null; priority: CardPriority }
    ): Promise<BoardCard> => {
      return fetch(`/api/board/cards/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }).then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Server responded with ${res.status}`);
        }
        const updated = (await res.json()) as BoardCard;
        setCards((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
        return updated;
      });
    },
    []
  );

  const dispatchCard = useCallback(
    (card: BoardCard, agent: AgentId) => {
      setDispatchingId(card.id);
      setActionError(null);
      fetch(`/api/board/cards/${card.id}/dispatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent }),
      })
        .then(async (res) => {
          if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as { error?: string };
            throw new Error(body.error ?? `Server responded with ${res.status}`);
          }
          return (await res.json()) as BoardCard;
        })
        .then(async (updated) => {
          setCards((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
          if (!updated.sessionId) return;
          // Look up the freshly-created session's REST info so the
          // terminal pane it gets folded into shows a real title/status
          // immediately, instead of "empty pane" until something unrelated
          // happens to refresh App.tsx's session list.
          try {
            const sessionsRes = await fetch("/api/sessions");
            const body = (await sessionsRes.json()) as { sessions: SessionInfo[] };
            const session = body.sessions.find((s) => s.id === updated.sessionId);
            if (session) onSessionDispatched(session);
          } catch {
            // Non-fatal — the card still shows as dispatched (StatusDot +
            // agent name) either way; only the grid-attachment convenience
            // is lost.
          }
        })
        .catch((err: unknown) => {
          setActionError(err instanceof Error ? err.message : "Failed to dispatch");
        })
        .finally(() => setDispatchingId(null));
    },
    [onSessionDispatched]
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const activeCard = cards.find((c) => c.id === active.id);
      if (!activeCard) return;

      const overData = over.data.current as { type: "card" | "column"; columnId: ColumnId } | undefined;
      const targetColumnId = overData?.columnId ?? activeCard.columnId;
      // Neighbours are computed from the CURRENT column's cards, minus the
      // card being moved (it may already be in this column, elsewhere in
      // the array) — this is what lets `midpointPosition` insert it at the
      // exact drop slot regardless of where it started.
      const targetCards = (cardsByColumn.get(targetColumnId) ?? []).filter((c) => c.id !== activeCard.id);

      const overIndex =
        overData?.type === "card" ? targetCards.findIndex((c) => c.id === over.id) : targetCards.length;
      const insertAt = overIndex === -1 ? targetCards.length : overIndex;

      const before = targetCards[insertAt - 1];
      const after = targetCards[insertAt];
      const position = midpointPosition(before?.position, after?.position);

      if (targetColumnId === activeCard.columnId && position === activeCard.position) return;

      const wasUndispatched = !activeCard.sessionId;

      // Optimistic local update so the drop feels instant; reconciled with
      // the server's response (which also carries any renormalized
      // positions, see BoardStore.renormalizeIfNeeded) once it arrives.
      setCards((prev) =>
        prev.map((c) => (c.id === activeCard.id ? { ...c, columnId: targetColumnId, position } : c))
      );

      fetch(`/api/board/cards/${activeCard.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ columnId: targetColumnId, position }),
      })
        .then(async (res) => {
          if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as { error?: string };
            throw new Error(body.error ?? `Server responded with ${res.status}`);
          }
          return (await res.json()) as BoardCard;
        })
        .then((updated) => {
          setCards((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
          // Phase 7 §5: dropping an un-dispatched card into In Progress
          // dispatches it automatically, using the app's current default
          // agent — the "ask which agent, default = the current default"
          // rule, applied without a blocking prompt (dragging has no room
          // for one). The explicit "Dispatch" control on the card is where
          // a user picks a DIFFERENT agent instead of the default.
          if (targetColumnId === "in_progress" && wasUndispatched && defaultAgent) {
            dispatchCard(updated, defaultAgent);
          }
        })
        .catch((err: unknown) => {
          setActionError(err instanceof Error ? err.message : "Failed to move card");
        });
    },
    [cards, cardsByColumn, defaultAgent, dispatchCard]
  );

  if (!workspaceId) {
    return <div style={emptyStateStyle}>No workspace open.</div>;
  }
  if (loadState === "loading") {
    return <div style={emptyStateStyle}>Loading board…</div>;
  }
  if (loadState === "error") {
    return <div style={emptyStateStyle}>{loadError ?? "Failed to load the board."}</div>;
  }

  // Round 2's board-level empty state: true only when EVERY column has zero
  // cards, not just the one a caller happens to be looking at — this is
  // what tells the whole-board "first run" feeling (below, and in each
  // Column's own `boardEmpty` prop, see emptyState.ts) apart from "one
  // column is just quiet right now because everything moved past it".
  const boardEmpty = cards.length === 0;

  return (
    <div style={boardStyle}>
      {actionError && <div style={errorBarStyle}>{actionError}</div>}
      {boardEmpty && loadState === "loaded" && <BoardIntroBanner />}
      <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={handleDragEnd}>
        <div style={columnsRowStyle}>
          {COLUMNS.map((column) => (
            <Column
              key={column.id}
              id={column.id}
              label={column.label}
              meaning={column.meaning}
              cards={cardsByColumn.get(column.id) ?? []}
              boardEmpty={boardEmpty}
              agents={agents}
              defaultAgent={defaultAgent}
              dispatchingId={dispatchingId}
              sessionsById={sessionsById}
              onAddCard={addCard}
              onDeleteCard={deleteCard}
              onDispatchCard={dispatchCard}
              onUpdateCard={updateCard}
              onFocusSession={onFocusSession}
            />
          ))}
        </div>
      </DndContext>
    </div>
  );
}

/**
 * The board-level "how this works" strip shown above the columns only while
 * `cards.length === 0` everywhere (round 2: "an explanation of what the
 * columns mean and how dispatch works, rather than five identical 'nothing
 * here' labels"). It's self-clearing rather than dismissible: the moment a
 * card exists anywhere, `boardEmpty` flips false and this simply stops
 * rendering — no separate "don't show this again" state to track. The
 * per-column legend reuses `StatusDot` + each column's own label/meaning
 * from `COLUMNS` (the same source of truth Column.tsx's header reads), so
 * it can never drift out of sync with the columns actually shown below it.
 */
function BoardIntroBanner() {
  return (
    <div style={introBannerStyle}>
      <p style={introTitleStyle}>Add a task, then drag it into In progress to hand it to an agent</p>
      <p style={introBodyStyle}>Cards move left to right as work happens:</p>
      <div style={introLegendStyle}>
        {COLUMNS.map((column) => (
          <span key={column.id} style={introLegendItemStyle}>
            <StatusDot status={column.meaning} />
            {column.label}
          </span>
        ))}
      </div>
    </div>
  );
}

const boardStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  minHeight: 0,
  background: "var(--vd-bg)",
};

const columnsRowStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  gap: 8,
  padding: 8,
  overflowX: "auto",
};

const emptyStateStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: "100%",
  color: "var(--vd-text-muted)",
  fontSize: 12,
  background: "var(--vd-bg)",
};

const introBannerStyle: React.CSSProperties = {
  flexShrink: 0,
  padding: `${SPACE.md}px ${SPACE.lg}px`,
  background: "var(--vd-surface)",
  borderBottom: "1px solid var(--vd-border)",
};

const introTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: FONT.title,
  fontWeight: 600,
  color: "var(--vd-text)",
};

const introBodyStyle: React.CSSProperties = {
  margin: `${SPACE.xs}px 0 ${SPACE.sm}px`,
  fontSize: FONT.body,
  color: "var(--vd-text-muted)",
};

const introLegendStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: SPACE.lg,
};

const introLegendItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: SPACE.xs,
  fontSize: FONT.meta,
  color: "var(--vd-text-faint)",
};

const errorBarStyle: React.CSSProperties = {
  padding: "6px 12px",
  background: "color-mix(in srgb, var(--vd-danger) 18%, var(--vd-bg))",
  borderBottom: "1px solid var(--vd-danger)",
  fontSize: 12,
  color: "var(--vd-text)",
  flexShrink: 0,
};
