import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentId, SessionInfo, Workspace } from "@vibedeck/shared";
import Grid from "./grid/Grid.js";
import type { AgentOption } from "./grid/PaneView.js";
import {
  attachSession,
  buildTemplate,
  closePane,
  createLeaf,
  findPane,
  listPanes,
  pruneDeadSessions,
  splitPane,
  type Direction,
  type GridNode,
  type PaneId,
} from "./grid/tree.js";

interface HealthResponse {
  status: string;
  version: string;
  /** The server's own working directory — only used to pre-fill the
   * first-run "create a workspace" form with a sensible default path. */
  cwd?: string;
}

type HealthState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; health: HealthResponse };

/** Every grid size the template picker offers — must match tree.ts's supported set. */
const TEMPLATE_SIZES = [1, 2, 4, 6, 8, 10, 12, 14, 16];

/**
 * Turns a workspace's saved `layout` (JSON string, or null if it's never
 * had one saved) into a GridNode tree ready to render. Two honesty rules,
 * per Phase 3's design: a workspace with no saved layout starts as a single
 * empty pane (never auto-fills from whatever happens to be running), and
 * any sessionId the saved layout mentions that isn't in the live `sessions`
 * list gets cleared rather than shown as a fake "running" pane — pty
 * processes don't survive a server restart, only the pane *shape* does.
 */
function layoutToTree(layout: string | null, sessions: SessionInfo[]): GridNode {
  if (!layout) return createLeaf(null);
  try {
    const parsed = JSON.parse(layout) as GridNode;
    return pruneDeadSessions(parsed, new Set(sessions.map((s) => s.id)));
  } catch (err) {
    console.warn(
      "vibedeck: failed to parse a saved workspace layout, starting with an empty pane instead",
      err
    );
    return createLeaf(null);
  }
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
  // *different* tree (the template picker, or switching workspaces,
  // replacing the whole layout) was found, by hand-testing in a real
  // browser, to leave Allotment's internal state stale: panes collapsed to
  // zero width instead of laying out fresh. Bumping this key forces React
  // to fully unmount and remount `<Grid>` — and therefore every
  // `<Allotment>` inside it — only on those wholesale swaps, so Allotment
  // always initializes against the tree it's actually showing.
  const [gridEpoch, setGridEpoch] = useState(0);
  // Set to a template size while we're waiting for the user to confirm
  // discarding panes that still have sessions running. `window.confirm`
  // would work here but is deliberately avoided — a native modal freezes
  // the page for browser-automation tools (and tests), so we use this
  // small piece of state to drive an inline confirmation banner instead.
  const [pendingTemplate, setPendingTemplate] = useState<number | null>(null);

  // --- Workspaces ---------------------------------------------------------
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  // Distinguishes "still loading" from "loaded, and there are zero
  // workspaces" — the latter is what triggers the first-run prompt below.
  const [workspacesLoaded, setWorkspacesLoaded] = useState(false);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [serverCwd, setServerCwd] = useState("");

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [newWorkspacePath, setNewWorkspacePath] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);

  const [pendingDeleteWorkspaceId, setPendingDeleteWorkspaceId] = useState<string | null>(null);

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;

  // Load server health, the agent menu, and (once both resolve) the
  // sessions + workspaces needed to build the initial grid, once on mount.
  useEffect(() => {
    fetch("/api/health")
      .then((res) => {
        if (!res.ok) throw new Error(`Server responded with ${res.status}`);
        return res.json() as Promise<HealthResponse>;
      })
      .then((h) => {
        setHealth({ kind: "loaded", health: h });
        if (h.cwd) setServerCwd(h.cwd);
      })
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

    // Sessions and workspaces load independently, but building the initial
    // grid needs BOTH at once: the active workspace's saved layout, and the
    // live session list to know which of that layout's sessionIds (if any)
    // are still actually running. `tryInitRoot` fires once both have
    // resolved, in whichever order they actually come back.
    let loadedSessions: SessionInfo[] | null = null;
    let loadedWorkspaces: Workspace[] | null = null;

    const tryInitRoot = () => {
      if (loadedSessions === null || loadedWorkspaces === null) return;
      setSessions(loadedSessions);
      setWorkspaces(loadedWorkspaces);
      setWorkspacesLoaded(true);
      if (loadedWorkspaces.length > 0) {
        const first = loadedWorkspaces[0];
        setActiveWorkspaceId(first.id);
        setRoot(layoutToTree(first.layout, loadedSessions));
      }
      // If there are zero workspaces, `root` stays null and `workspacesLoaded`
      // (now true) drives the first-run prompt instead of "Loading…".
    };

    fetch("/api/sessions")
      .then((res) => res.json() as Promise<{ sessions: SessionInfo[] }>)
      .then((body) => {
        loadedSessions = body.sessions;
        tryInitRoot();
      })
      .catch((err: unknown) => {
        console.warn("vibedeck: failed to load sessions", err);
        loadedSessions = []; // still let workspace/root init proceed
        tryInitRoot();
      });

    fetch("/api/workspaces")
      .then((res) => res.json() as Promise<{ workspaces: Workspace[] }>)
      .then((body) => {
        loadedWorkspaces = body.workspaces;
        tryInitRoot();
      })
      .catch((err: unknown) => {
        console.warn("vibedeck: failed to load workspaces", err);
        loadedWorkspaces = [];
        tryInitRoot();
      });
  }, []);

  // Pre-fill the first-run "create a workspace" form's directory field with
  // the server's own cwd, as soon as we know both things: that this really
  // is a first run (zero workspaces) and what that cwd is. Only fires once
  // in practice, since setting newWorkspacePath makes its own condition
  // false on the next run.
  useEffect(() => {
    if (workspacesLoaded && workspaces.length === 0 && serverCwd && newWorkspacePath === "") {
      setNewWorkspacePath(serverCwd);
    }
  }, [workspacesLoaded, workspaces.length, serverCwd, newWorkspacePath]);

  // Auto-save the active workspace's layout whenever the grid tree changes
  // (split, close, session attach, template swap, workspace switch...),
  // debounced so rapid-fire changes (or a future divider-drag that ends up
  // touching the tree) don't spam the server with a PATCH per frame.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (!activeWorkspaceId || !root) return;
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      fetch(`/api/workspaces/${activeWorkspaceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ layout: JSON.stringify(root) }),
      }).catch((err: unknown) => {
        console.warn("vibedeck: failed to autosave workspace layout", err);
      });
    }, 500);
    return () => clearTimeout(saveTimerRef.current);
  }, [root, activeWorkspaceId]);

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

  // --- Workspace actions ---------------------------------------------------

  const switchWorkspace = useCallback(
    (targetId: string) => {
      if (targetId === activeWorkspaceId) return;
      const target = workspaces.find((w) => w.id === targetId);
      if (!target) return;

      // Flush the outgoing workspace's layout right now (not debounced) so
      // switching away never loses the last few edits to a pending timer
      // that's about to get cancelled anyway.
      if (activeWorkspaceId && root) {
        clearTimeout(saveTimerRef.current);
        fetch(`/api/workspaces/${activeWorkspaceId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ layout: JSON.stringify(root) }),
        }).catch((err: unknown) => {
          console.warn("vibedeck: failed to save the outgoing workspace's layout", err);
        });
      }

      setActiveWorkspaceId(targetId);
      setRoot(layoutToTree(target.layout, sessions));
      setFocusedPaneId(null);
      setGridEpoch((e) => e + 1); // wholesale swap — same reasoning as applyTemplate above
    },
    [activeWorkspaceId, root, workspaces, sessions]
  );

  const openCreateForm = useCallback(() => {
    setNewWorkspaceName("");
    setNewWorkspacePath(serverCwd);
    setCreateError(null);
    setShowCreateForm(true);
  }, [serverCwd]);

  const createWorkspace = useCallback(async () => {
    setCreateError(null);
    setCreating(true);
    try {
      const res = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newWorkspaceName, rootPath: newWorkspacePath }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<Workspace> & { error?: string };
      if (!res.ok) {
        throw new Error(body.error ?? `Server responded with ${res.status}`);
      }
      const workspace = body as Workspace;
      setWorkspaces((prev) => [...prev, workspace]);
      setActiveWorkspaceId(workspace.id);
      setRoot(createLeaf(null));
      setFocusedPaneId(null);
      setGridEpoch((e) => e + 1);
      setShowCreateForm(false);
      setNewWorkspaceName("");
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setCreating(false);
    }
  }, [newWorkspaceName, newWorkspacePath]);

  const startRename = useCallback((workspace: Workspace) => {
    setRenamingId(workspace.id);
    setRenameValue(workspace.name);
    setRenameError(null);
  }, []);

  const cancelRename = useCallback(() => {
    setRenamingId(null);
    setRenameError(null);
  }, []);

  const commitRename = useCallback(async () => {
    if (!renamingId) return;
    try {
      const res = await fetch(`/api/workspaces/${renamingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: renameValue }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<Workspace> & { error?: string };
      if (!res.ok) {
        throw new Error(body.error ?? `Server responded with ${res.status}`);
      }
      const updated = body as Workspace;
      setWorkspaces((prev) => prev.map((w) => (w.id === updated.id ? updated : w)));
      setRenamingId(null);
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : "Unknown error");
    }
  }, [renamingId, renameValue]);

  const requestDeleteWorkspace = useCallback((id: string) => {
    setPendingDeleteWorkspaceId(id);
  }, []);

  const cancelDeleteWorkspace = useCallback(() => setPendingDeleteWorkspaceId(null), []);

  const confirmDeleteWorkspace = useCallback(async () => {
    const id = pendingDeleteWorkspaceId;
    if (!id) return;
    try {
      await fetch(`/api/workspaces/${id}`, { method: "DELETE" });
    } catch (err) {
      console.warn("vibedeck: failed to delete workspace", err);
    }
    const remaining = workspaces.filter((w) => w.id !== id);
    setWorkspaces(remaining);
    if (activeWorkspaceId === id) {
      if (remaining.length > 0) {
        setActiveWorkspaceId(remaining[0].id);
        setRoot(layoutToTree(remaining[0].layout, sessions));
      } else {
        setActiveWorkspaceId(null);
        setRoot(null);
      }
      setFocusedPaneId(null);
      setGridEpoch((e) => e + 1);
    }
    setPendingDeleteWorkspaceId(null);
  }, [pendingDeleteWorkspaceId, workspaces, activeWorkspaceId, sessions]);

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

        {activeWorkspace && (
          <span style={{ fontSize: "0.8rem", color: "#6b7280" }}>
            Directory:{" "}
            <code style={{ color: "#e6e6e6" }} title={activeWorkspace.rootPath}>
              {activeWorkspace.rootPath}
            </code>
          </span>
        )}

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

      {workspacesLoaded && workspaces.length > 0 && (
        <div style={tabStripStyle}>
          {workspaces.map((workspace) => (
            <div key={workspace.id} style={workspace.id === activeWorkspaceId ? activeTabStyle : tabStyle}>
              {renamingId === workspace.id ? (
                <>
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void commitRename();
                      if (e.key === "Escape") cancelRename();
                    }}
                    style={{ ...formInputStyle, padding: "1px 4px", fontSize: "0.8rem", width: 120 }}
                  />
                  <button onClick={() => void commitRename()} style={tabIconButtonStyle} title="Save name">
                    ✓
                  </button>
                  <button onClick={cancelRename} style={tabIconButtonStyle} title="Cancel rename">
                    ✕
                  </button>
                </>
              ) : (
                <>
                  <span onClick={() => switchWorkspace(workspace.id)} title={workspace.rootPath}>
                    {workspace.name}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      startRename(workspace);
                    }}
                    style={tabIconButtonStyle}
                    title="Rename workspace"
                  >
                    ✎
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      requestDeleteWorkspace(workspace.id);
                    }}
                    style={tabIconButtonStyle}
                    title="Delete workspace"
                  >
                    ✕
                  </button>
                </>
              )}
            </div>
          ))}
          <button onClick={openCreateForm} style={templateButtonStyle} title="New workspace">
            +
          </button>
          {renameError && <span style={{ color: "#f28b82", fontSize: "0.8rem" }}>{renameError}</span>}
        </div>
      )}

      {showCreateForm && (
        <div style={confirmBannerStyle}>
          <span>New workspace:</span>
          <input
            placeholder="Name"
            value={newWorkspaceName}
            onChange={(e) => setNewWorkspaceName(e.target.value)}
            style={formInputStyle}
          />
          <input
            placeholder="Directory (e.g. ~/projects/foo)"
            value={newWorkspacePath}
            onChange={(e) => setNewWorkspacePath(e.target.value)}
            style={{ ...formInputStyle, minWidth: 260 }}
          />
          <button onClick={() => void createWorkspace()} disabled={creating} style={primaryButtonStyle}>
            Create
          </button>
          <button onClick={() => setShowCreateForm(false)} style={templateButtonStyle}>
            Cancel
          </button>
          {createError && <span style={{ color: "#f28b82", fontSize: "0.8rem" }}>{createError}</span>}
        </div>
      )}

      {pendingDeleteWorkspaceId && (
        <div style={confirmBannerStyle}>
          <span>
            Delete workspace "
            {workspaces.find((w) => w.id === pendingDeleteWorkspaceId)?.name ?? pendingDeleteWorkspaceId}
            "? This won't stop any sessions still running in it — only the workspace entry and its
            saved layout are removed.
          </span>
          <button onClick={() => void confirmDeleteWorkspace()} style={primaryButtonStyle}>
            Delete
          </button>
          <button onClick={cancelDeleteWorkspace} style={templateButtonStyle}>
            Cancel
          </button>
        </div>
      )}

      {pendingTemplate !== null && (
        <div style={confirmBannerStyle}>
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
        {!workspacesLoaded ? (
          <div style={centeredStyle}>Loading…</div>
        ) : workspaces.length === 0 ? (
          <div style={centeredStyle}>
            <div style={{ textAlign: "center", maxWidth: 420 }}>
              <p style={{ color: "#9aa0a6", marginBottom: 12 }}>
                No workspaces yet. A workspace is a project directory — panes you start spawn
                there instead of vibedeck's own install folder.
              </p>
              <input
                placeholder="Name (e.g. my-project)"
                value={newWorkspaceName}
                onChange={(e) => setNewWorkspaceName(e.target.value)}
                style={{ ...formInputStyle, marginBottom: 8, width: "100%", boxSizing: "border-box" }}
              />
              <input
                placeholder="Directory (e.g. ~/projects/my-project)"
                value={newWorkspacePath}
                onChange={(e) => setNewWorkspacePath(e.target.value)}
                style={{ ...formInputStyle, marginBottom: 12, width: "100%", boxSizing: "border-box" }}
              />
              <button onClick={() => void createWorkspace()} disabled={creating} style={primaryButtonStyle}>
                Create workspace
              </button>
              {createError && (
                <p style={{ color: "#f28b82", fontSize: "0.8rem", marginTop: 8 }}>{createError}</p>
              )}
            </div>
          </div>
        ) : root ? (
          <Grid
            key={gridEpoch}
            root={root}
            sessions={sessions}
            agents={agents}
            defaultAgent={defaultAgent}
            workspaceId={activeWorkspaceId}
            focusedPaneId={focusedPaneId}
            onFocus={handleFocus}
            onSessionStarted={handleSessionStarted}
            onSplit={handleSplit}
            onClosePane={handleClosePane}
          />
        ) : (
          <div style={centeredStyle}>Loading…</div>
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

const formInputStyle: React.CSSProperties = {
  background: "#0f1115",
  color: "#e6e6e6",
  border: "1px solid #2a2e37",
  borderRadius: 4,
  padding: "0.3rem 0.5rem",
  fontSize: "0.85rem",
};

const confirmBannerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "0.5rem 1rem",
  background: "#3a2a1f",
  borderBottom: "1px solid #5a3f2a",
  fontSize: "0.85rem",
  flexWrap: "wrap",
};

const centeredStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: "100%",
  color: "#6b7280",
};

const tabStripStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "0.4rem 1rem",
  borderBottom: "1px solid #2a2e37",
  flexShrink: 0,
  flexWrap: "wrap",
  background: "#14161c",
};

const tabStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  background: "#1a1d24",
  border: "1px solid #2a2e37",
  borderRadius: 4,
  padding: "0.3rem 0.5rem",
  fontSize: "0.8rem",
  cursor: "pointer",
};

const activeTabStyle: React.CSSProperties = {
  ...tabStyle,
  background: "#2a6df4",
  borderColor: "#2a6df4",
  color: "white",
};

const tabIconButtonStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "inherit",
  cursor: "pointer",
  fontSize: "0.75rem",
  padding: "0 2px",
  lineHeight: 1,
  opacity: 0.85,
};
