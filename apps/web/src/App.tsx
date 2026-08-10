import { useCallback, useEffect, useState } from "react";
import type { AgentId, SessionInfo } from "@vibedeck/shared";
import Grid from "./grid/Grid.js";
import type { AgentOption } from "./grid/PaneView.js";
import {
  attachSession,
  buildTemplate,
  closePane,
  createLeaf,
  findPane,
  listPanes,
  splitPane,
  type Direction,
  type GridNode,
  type PaneId,
} from "./grid/tree.js";

interface HealthResponse {
  status: string;
  version: string;
}

type HealthState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; health: HealthResponse };

/** Every grid size the template picker offers — must match tree.ts's supported set. */
const TEMPLATE_SIZES = [1, 2, 4, 6, 8, 10, 12, 14, 16];

/**
 * Builds the tree the app should start with: one leaf per session that's
 * already running on the server (e.g. left over from before a page
 * refresh), each pane attached to its session. This is Phase 2's
 * replacement for a sidebar of "reattach to an old session" links — every
 * already-running session lands in its own pane automatically, so nothing
 * the server still has running becomes invisible/unreachable just because
 * this page reloaded.
 */
function buildInitialRoot(sessions: SessionInfo[]): GridNode {
  if (sessions.length === 0) return createLeaf(null);

  let root: GridNode = createLeaf(sessions[0].id);
  for (let i = 1; i < sessions.length; i++) {
    const panes = listPanes(root);
    const lastPaneId = panes[panes.length - 1].id;
    // Alternate split direction so many leftover sessions form a grid-ish
    // shape rather than one long line in a single direction.
    const direction: Direction = i % 2 === 0 ? "row" : "column";
    root = splitPane(root, lastPaneId, direction);
    const newLeafId = listPanes(root).at(-1)!.id;
    root = attachSession(root, newLeafId, sessions[i].id);
  }
  return root;
}

export default function App() {
  const [health, setHealth] = useState<HealthState>({ kind: "loading" });
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [defaultAgent, setDefaultAgent] = useState<AgentId | "">("");
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [root, setRoot] = useState<GridNode | null>(null);
  const [focusedPaneId, setFocusedPaneId] = useState<PaneId | null>(null);
  // `allotment` (the resizable-split library Grid.tsx uses) keeps its own
  // internal, non-React layout state tied to the DOM nodes it mounted into.
  // That's fine when the tree changes incrementally (splitPane/closePane
  // just add or remove one branch) — React's normal reconciliation and
  // Allotment's own resize handling cope fine. But swapping in a wholesale
  // *different* tree (the template picker replacing the whole layout) was
  // found, by hand-testing in a real browser, to leave Allotment's internal
  // state stale: panes collapsed to zero width instead of laying out fresh.
  // Bumping this key forces React to fully unmount and remount `<Grid>` —
  // and therefore every `<Allotment>` inside it — only on those wholesale
  // swaps, so Allotment always initializes against the tree it's actually
  // showing.
  const [gridEpoch, setGridEpoch] = useState(0);
  // Set to a template size while we're waiting for the user to confirm
  // discarding panes that still have sessions running. `window.confirm`
  // would work here but is deliberately avoided — a native modal freezes
  // the page for browser-automation tools (and tests), so we use this
  // small piece of state to drive an inline confirmation banner instead.
  const [pendingTemplate, setPendingTemplate] = useState<number | null>(null);

  // Load server health, the agent menu, and any sessions already running on
  // the server once on mount.
  useEffect(() => {
    fetch("/api/health")
      .then((res) => {
        if (!res.ok) throw new Error(`Server responded with ${res.status}`);
        return res.json() as Promise<HealthResponse>;
      })
      .then((h) => setHealth({ kind: "loaded", health: h }))
      .catch((err: unknown) => {
        setHealth({
          kind: "error",
          message: err instanceof Error ? err.message : "Unknown error",
        });
      });

    fetch("/api/agents")
      .then((res) => res.json() as Promise<{ agents: AgentOption[] }>)
      .then((body) => {
        setAgents(body.agents);
        const firstAvailable = body.agents.find((a) => a.available);
        if (firstAvailable) setDefaultAgent(firstAvailable.id);
      })
      .catch((err: unknown) => {
        console.warn("vibedeck: failed to load agents", err);
      });

    fetch("/api/sessions")
      .then((res) => res.json() as Promise<{ sessions: SessionInfo[] }>)
      .then((body) => {
        setSessions(body.sessions);
        // Guard against a real (if narrow) race: this fetch can resolve
        // *after* the user has already interacted with the grid (clicked
        // "New pane" or a template size while this request was still in
        // flight). `root` only starts out `null` and is never set back to
        // it afterwards, so checking `prev === null` here means "only seed
        // the initial layout if nothing has claimed `root` yet" — a late
        // response can no longer clobber a layout the user already chose.
        // (This was found the hard way: an unguarded `setRoot` here could
        // replace an existing Allotment-backed tree with an unrelated one
        // under the same React key, which left `allotment`'s internal
        // layout state stale and every pane rendered at zero width.)
        setRoot((prev) => (prev === null ? buildInitialRoot(body.sessions) : prev));
      })
      .catch((err: unknown) => {
        console.warn("vibedeck: failed to load sessions", err);
        setRoot((prev) => (prev === null ? createLeaf(null) : prev)); // still give the user a pane to work with
      });
  }, []);

  const handleFocus = useCallback((paneId: PaneId) => {
    setFocusedPaneId(paneId);
  }, []);

  // A pane's agent picker just created a session — attach it to that pane
  // and add it to the session list so the header/other lookups see it.
  const handleSessionStarted = useCallback((paneId: PaneId, session: SessionInfo) => {
    setSessions((prev) => [...prev, session]);
    setRoot((prev) => (prev ? attachSession(prev, paneId, session.id) : prev));
    setFocusedPaneId(paneId);
  }, []);

  const handleSplit = useCallback((paneId: PaneId, direction: Direction) => {
    setRoot((prev) => (prev ? splitPane(prev, paneId, direction) : prev));
  }, []);

  // A pane's session (if it had one) has already been DELETEd server-side
  // by the time this fires — see PaneView.tsx and Terminal.tsx's own
  // "Close" menu item. This just needs to drop the pane from the tree and
  // forget its session locally.
  const handleClosePane = useCallback(
    (paneId: PaneId) => {
      if (!root) return;
      const pane = findPane(root, paneId);
      if (pane?.kind === "leaf" && pane.sessionId) {
        const sessionId = pane.sessionId;
        setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      }
      setRoot(closePane(root, paneId));
      setFocusedPaneId((prev) => (prev === paneId ? null : prev));
    },
    [root]
  );

  // "New pane" splits whatever's focused; if nothing's focused (or there's
  // no grid at all yet, e.g. every pane was just closed) it falls back to
  // seeding/splitting the first pane instead.
  const addPane = useCallback(() => {
    setRoot((prev) => {
      if (!prev) return createLeaf(null);
      const panes = listPanes(prev);
      const target = panes.find((p) => p.id === focusedPaneId) ?? panes[0];
      return splitPane(prev, target.id, "row");
    });
  }, [focusedPaneId]);

  const applyTemplate = useCallback(
    (n: number) => {
      const hasRunningPanes = root ? listPanes(root).some((p) => p.sessionId) : false;
      if (hasRunningPanes) {
        setPendingTemplate(n); // ask first — see the confirmation banner below
        return;
      }
      setRoot(buildTemplate(n));
      setFocusedPaneId(null);
      setGridEpoch((e) => e + 1); // wholesale swap — force Grid/Allotment to remount fresh
    },
    [root]
  );

  const confirmTemplate = useCallback(() => {
    if (pendingTemplate === null || !root) return;
    // Discarding these panes from the grid would otherwise leave their
    // sessions running forever, invisible (there's no sidebar to find them
    // again) — so an explicit confirm here also kills them server-side.
    for (const pane of listPanes(root)) {
      if (pane.sessionId) {
        fetch(`/api/sessions/${pane.sessionId}`, { method: "DELETE" }).catch((err: unknown) => {
          console.warn("vibedeck: failed to close session while applying a new template", err);
        });
      }
    }
    setSessions([]);
    setRoot(buildTemplate(pendingTemplate));
    setFocusedPaneId(null);
    setPendingTemplate(null);
    setGridEpoch((e) => e + 1); // wholesale swap — force Grid/Allotment to remount fresh
  }, [pendingTemplate, root]);

  const cancelTemplate = useCallback(() => setPendingTemplate(null), []);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        background: "#0f1115",
        color: "#e6e6e6",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: "1rem",
          padding: "0.75rem 1rem",
          borderBottom: "1px solid #2a2e37",
          flexShrink: 0,
          flexWrap: "wrap",
        }}
      >
        <strong style={{ fontSize: "1.1rem" }}>vibedeck</strong>

        <span style={{ fontSize: "0.85rem", color: "#9aa0a6" }}>
          {health.kind === "loading" && "checking server…"}
          {health.kind === "error" && (
            <span style={{ color: "#f28b82" }}>server unreachable: {health.message}</span>
          )}
          {health.kind === "loaded" && (
            <span>
              <span style={{ color: "#81c995" }}>●</span> server ok (v{health.health.version})
            </span>
          )}
        </span>

        <div style={{ flex: 1 }} />

        <span style={{ fontSize: "0.8rem", color: "#6b7280" }}>Default agent for new panes:</span>
        <select
          value={defaultAgent}
          onChange={(e) => setDefaultAgent(e.target.value as AgentId)}
          style={{
            background: "#1a1d24",
            color: "#e6e6e6",
            border: "1px solid #2a2e37",
            borderRadius: 4,
            padding: "0.4rem 0.6rem",
          }}
        >
          <option value="" disabled>
            Choose an agent…
          </option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id} disabled={!agent.available}>
              {agent.displayName}
              {!agent.available ? " (not installed)" : ""}
            </option>
          ))}
        </select>

        <button onClick={addPane} style={primaryButtonStyle}>
          New pane
        </button>

        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ fontSize: "0.8rem", color: "#6b7280" }}>Layout:</span>
          {TEMPLATE_SIZES.map((n) => (
            <button key={n} onClick={() => applyTemplate(n)} style={templateButtonStyle} title={`${n} panes`}>
              {n}
            </button>
          ))}
        </div>
      </header>

      {pendingTemplate !== null && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "0.5rem 1rem",
            background: "#3a2a1f",
            borderBottom: "1px solid #5a3f2a",
            fontSize: "0.85rem",
          }}
        >
          <span>
            Switching to a {pendingTemplate}-pane layout will close panes that still have running
            sessions. Continue?
          </span>
          <button onClick={confirmTemplate} style={primaryButtonStyle}>
            Discard and switch
          </button>
          <button onClick={cancelTemplate} style={templateButtonStyle}>
            Cancel
          </button>
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0 }}>
        {root ? (
          <Grid
            key={gridEpoch}
            root={root}
            sessions={sessions}
            agents={agents}
            defaultAgent={defaultAgent}
            focusedPaneId={focusedPaneId}
            onFocus={handleFocus}
            onSessionStarted={handleSessionStarted}
            onSplit={handleSplit}
            onClosePane={handleClosePane}
          />
        ) : (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              color: "#6b7280",
            }}
          >
            Loading…
          </div>
        )}
      </div>
    </div>
  );
}

const primaryButtonStyle: React.CSSProperties = {
  background: "#2a6df4",
  color: "white",
  border: "none",
  borderRadius: 4,
  padding: "0.4rem 0.9rem",
  cursor: "pointer",
};

const templateButtonStyle: React.CSSProperties = {
  background: "#1a1d24",
  color: "#e6e6e6",
  border: "1px solid #2a2e37",
  borderRadius: 4,
  padding: "0.3rem 0.6rem",
  cursor: "pointer",
  fontSize: "0.8rem",
};
