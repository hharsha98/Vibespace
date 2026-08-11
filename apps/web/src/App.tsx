import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { KEYMAP, formatShortcut, isMacPlatform } from "./keys/keymap.js";
import { useKeyboardShortcuts, type ShortcutHandlers } from "./keys/useKeyboardShortcuts.js";
import {
  DEFAULT_THEME_ID,
  THEMES,
  applyThemeCssVars,
  getThemeById,
  loadStoredThemeId,
  saveThemeId,
} from "./themes/themes.js";
import ThemePicker from "./themes/ThemePicker.js";
import CommandPalette, { type PaletteCommand } from "./CommandPalette.js";
import KeyboardCheatSheet from "./KeyboardCheatSheet.js";
import WorkspaceRail from "./shell/WorkspaceRail.js";
import RightDock from "./shell/RightDock.js";
import { GlobalShellStyles, IconButton, StatusDot } from "./shell/ui.js";

/** Which full-screen overlay (if any) is currently open. Only one at a
 * time — opening a new one implicitly replaces whichever was open, and
 * `useKeyboardShortcuts` is disabled entirely while any of them is open, so
 * e.g. Cmd+D can't accidentally split a pane while the user is browsing the
 * theme picker. */
type OverlayKind = "palette" | "theme" | "help" | null;

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

// --- Rail/dock collapsed-state persistence ---------------------------------
// Same try/catch-around-localStorage pattern as themes.ts's loadStoredThemeId
// / saveThemeId — private-browsing Safari throws on ANY localStorage access,
// not just writes, so both directions need a guard. Falling back silently
// (rather than surfacing an error) is the right call here: "the rail
// forgets it was collapsed" is not worth interrupting anyone over.

function loadBoolPref(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : raw === "true";
  } catch {
    return fallback;
  }
}

function saveBoolPref(key: string, value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Storage full or disabled — same reasoning as saveThemeId in themes.ts.
  }
}

const RAIL_COLLAPSED_KEY = "vibedeck.rail.collapsed";
// The right dock ships with only one tab (Info) — DESIGN.md is explicit
// that it should be "collapsed/hidden by default" until Phases 7/8/10 give
// it real content, hence `true` as the fallback (vs. the rail's `false`).
const DOCK_COLLAPSED_KEY = "vibedeck.dock.collapsed";

export default function App() {
  const [health, setHealth] = useState<HealthState>({ kind: "loading" });
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [defaultAgent, setDefaultAgent] = useState<AgentId | "">("");
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [root, setRoot] = useState<GridNode | null>(null);
  const [focusedPaneId, setFocusedPaneId] = useState<PaneId | null>(null);
  // The pane currently filling the whole grid (docs/DESIGN.md §5
  // "maximise"), or null. See Grid.tsx's top comment for how this is
  // rendered without duplicating a session's live Terminal/WebSocket.
  const [maximizedPaneId, setMaximizedPaneId] = useState<PaneId | null>(null);
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

  // --- Left rail / right dock collapsed state -------------------------------
  const [railCollapsed, setRailCollapsedState] = useState(() => loadBoolPref(RAIL_COLLAPSED_KEY, false));
  const [dockCollapsed, setDockCollapsedState] = useState(() => loadBoolPref(DOCK_COLLAPSED_KEY, true));

  const toggleRailCollapsed = useCallback(() => {
    setRailCollapsedState((prev) => {
      const next = !prev;
      saveBoolPref(RAIL_COLLAPSED_KEY, next);
      return next;
    });
  }, []);

  const toggleDockCollapsed = useCallback(() => {
    setDockCollapsedState((prev) => {
      const next = !prev;
      saveBoolPref(DOCK_COLLAPSED_KEY, next);
      return next;
    });
  }, []);

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

  // A workspace's "running-pane count" (shown as the rail row's trailing
  // badge, and the dock's session count) has no direct server-side field to
  // read — `SessionInfo` doesn't carry a workspaceId (see
  // packages/shared/src/protocol.ts). What it DOES carry is `cwd`, and every
  // session's cwd is set, once, at creation time, to the workspace's own
  // rootPath (see PaneView.tsx's startSession / App.tsx's
  // startAgentInFocusedPane, both of which send `workspaceId` and let the
  // server resolve it to that path). So "sessions whose cwd matches this
  // workspace's rootPath" is an honest, frontend-only way to answer "which
  // sessions belong to this workspace" without a server change.
  const sessionsForWorkspace = useCallback(
    (workspace: Workspace) => sessions.filter((s) => s.cwd === workspace.rootPath),
    [sessions]
  );
  const workspacePaneCount = useCallback(
    (workspace: Workspace) =>
      sessions.filter((s) => s.status === "running" && s.cwd === workspace.rootPath).length,
    [sessions]
  );

  // --- Theme ---------------------------------------------------------------

  const [themeId, setThemeIdState] = useState<string>(() => {
    const id = loadStoredThemeId() ?? DEFAULT_THEME_ID;
    // Applying the CSS custom properties here — inside the lazy `useState`
    // initializer, which runs during the very first render, before
    // anything paints — avoids a flash of the wrong (or unstyled) colours
    // that a `useEffect` doing the same thing would cause: effects only run
    // AFTER the first paint. Touching the DOM during render is normally
    // avoided, but a one-time startup colour application like this is a
    // common, deliberate exception to that rule.
    applyThemeCssVars(getThemeById(id));
    return id;
  });
  const theme = getThemeById(themeId);

  // Keep :root's CSS variables and localStorage in sync with `themeId` on
  // every change (the initial application above already covers first
  // render, so this mostly matters for the picker actually switching
  // themes later).
  useEffect(() => {
    applyThemeCssVars(theme);
    saveThemeId(themeId);
  }, [themeId, theme]);

  const setTheme = useCallback((id: string) => setThemeIdState(id), []);

  // --- Overlays (command palette, theme picker, keyboard cheat sheet) ------

  const [activeOverlay, setActiveOverlay] = useState<OverlayKind>(null);
  const closeOverlay = useCallback(() => setActiveOverlay(null), []);

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
      setMaximizedPaneId((prev) => (prev === paneId ? null : prev));
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

  // Cmd+Shift+Return / the pane's own maximise icon: toggle whether `paneId`
  // fills the whole grid. Toggling the SAME pane again (or Escape, see the
  // effect below) restores the normal tree.
  const toggleMaximize = useCallback((paneId: PaneId) => {
    setMaximizedPaneId((prev) => (prev === paneId ? null : paneId));
  }, []);

  // Escape restores a maximized pane — handled here (a dedicated window
  // listener), not through `useKeyboardShortcuts`, because maximize isn't
  // one of the mutually-exclusive `OverlayKind`s that hook already guards
  // against (the palette/theme-picker/cheat-sheet), and `matchShortcut`
  // only ever matches combos that hold a modifier key (see keymap.ts), so a
  // bare Escape could never be added to KEYMAP without loosening that rule
  // for everything else too.
  //
  // MUST be capture-phase, not bubble — same reasoning as
  // `useKeyboardShortcuts`'s own top comment: a maximized pane is almost
  // always the one the user just clicked into, so the DOM focus target is
  // typically xterm.js's hidden textarea. xterm handles Escape itself (it's
  // a real terminal key, e.g. for vim) and stops it from bubbling back up
  // to a plain `window.addEventListener("keydown", ...)`, so a bubble-phase
  // listener here would silently never fire while a terminal has focus —
  // exactly the moment this shortcut most needs to work. Capture runs
  // top-down, before the event ever reaches the textarea, so it always
  // sees the key regardless of what xterm does with it afterward.
  useEffect(() => {
    if (!maximizedPaneId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMaximizedPaneId(null);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [maximizedPaneId]);

  // --- Keyboard-shortcut action handlers ------------------------------------
  // Every one of these reuses the same tree functions the mouse-driven UI
  // already calls (splitPane/closePane/listPanes from grid/tree.ts) — the
  // keyboard layer never reimplements grid surgery, it just figures out
  // WHICH pane to operate on and then calls the same code path.

  // Cmd+D / Cmd+Shift+D: split whichever pane is focused. Same "fall back to
  // the first pane if nothing's focused" rule as `addPane` above, so the
  // shortcut still does something sensible right after all panes closed.
  const splitFocused = useCallback(
    (direction: Direction) => {
      setRoot((prev) => {
        if (!prev) return prev;
        const panes = listPanes(prev);
        const target = panes.find((p) => p.id === focusedPaneId) ?? panes[0];
        if (!target) return prev;
        return splitPane(prev, target.id, direction);
      });
    },
    [focusedPaneId]
  );

  // Cmd+Shift+W: close the focused pane. Mirrors PaneView's own header
  // "close" button (closeFromHeader) — DELETE the session server-side
  // first, if this pane has one, then drop it from the tree. There's
  // nothing to do if no pane is focused.
  const closeFocusedPane = useCallback(() => {
    if (!root || !focusedPaneId) return;
    const pane = findPane(root, focusedPaneId);
    if (pane?.kind === "leaf" && pane.sessionId) {
      fetch(`/api/sessions/${pane.sessionId}`, { method: "DELETE" }).catch((err: unknown) => {
        console.warn("vibedeck: failed to close session via keyboard shortcut", err);
      });
    }
    handleClosePane(focusedPaneId);
  }, [root, focusedPaneId, handleClosePane]);

  // Cmd+1..Cmd+9: jump focus straight to the Nth pane, left-to-right /
  // top-to-bottom (the same order `listPanes` already returns them in).
  const focusPaneByIndex = useCallback(
    (index: number) => {
      if (!root) return;
      const panes = listPanes(root);
      const target = panes[index];
      if (target) setFocusedPaneId(target.id);
    },
    [root]
  );

  // Cmd+] / Cmd+[: move focus to the next/previous pane, wrapping around.
  // If nothing's focused yet, both directions just land on the first pane.
  const cycleFocus = useCallback(
    (delta: 1 | -1) => {
      if (!root) return;
      const panes = listPanes(root);
      if (panes.length === 0) return;
      const currentIndex = panes.findIndex((p) => p.id === focusedPaneId);
      const nextIndex = currentIndex === -1 ? 0 : (currentIndex + delta + panes.length) % panes.length;
      setFocusedPaneId(panes[nextIndex].id);
    },
    [root, focusedPaneId]
  );

  // Used by the command palette's "Start <agent> in this pane" commands.
  // Deliberately only acts when the focused pane is currently EMPTY — there's
  // no sensible meaning for "start an agent" in a pane that already has one
  // running, and PaneView's own agent picker only exists on empty panes for
  // the same reason.
  const startAgentInFocusedPane = useCallback(
    async (agent: AgentId) => {
      if (!root || !focusedPaneId) return;
      const pane = findPane(root, focusedPaneId);
      if (!pane || pane.kind !== "leaf" || pane.sessionId) return;
      try {
        const res = await fetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            activeWorkspaceId ? { agent, workspaceId: activeWorkspaceId } : { agent }
          ),
        });
        if (!res.ok) return;
        const info = (await res.json()) as SessionInfo;
        handleSessionStarted(focusedPaneId, info);
      } catch (err) {
        console.warn("vibedeck: failed to start an agent from the command palette", err);
      }
    },
    [root, focusedPaneId, activeWorkspaceId, handleSessionStarted]
  );

  const applyTemplate = useCallback(
    (n: number) => {
      const hasRunningPanes = root ? listPanes(root).some((p) => p.sessionId) : false;
      if (hasRunningPanes) {
        setPendingTemplate(n); // ask first — see the confirmation banner below
        return;
      }
      setRoot(buildTemplate(n));
      setFocusedPaneId(null);
      setMaximizedPaneId(null);
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
    setMaximizedPaneId(null);
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
      setMaximizedPaneId(null);
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
      setMaximizedPaneId(null);
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
      setMaximizedPaneId(null);
      setGridEpoch((e) => e + 1);
    }
    setPendingDeleteWorkspaceId(null);
  }, [pendingDeleteWorkspaceId, workspaces, activeWorkspaceId, sessions]);

  // --- Keyboard shortcuts ----------------------------------------------------

  const isMac = useMemo(() => isMacPlatform(), []);

  const shortcutHandlers = useMemo(() => {
    const handlers: ShortcutHandlers = {
      "command-palette": () => setActiveOverlay("palette"),
      "split-row": () => splitFocused("row"),
      "split-column": () => splitFocused("column"),
      "new-pane": () => addPane(),
      "close-pane": () => closeFocusedPane(),
      "cycle-focus-next": () => cycleFocus(1),
      "cycle-focus-prev": () => cycleFocus(-1),
      "theme-picker": () => setActiveOverlay("theme"),
      "maximize-pane": () => {
        if (focusedPaneId) toggleMaximize(focusedPaneId);
      },
    };
    // The nine "focus pane N" shortcuts all share one handler shape, keyed
    // off `paneIndex` (see keymap.ts) instead of writing out
    // "focus-pane-1".."focus-pane-9" by hand nine times.
    for (const shortcut of KEYMAP) {
      if (shortcut.paneIndex !== undefined) {
        const index = shortcut.paneIndex;
        handlers[shortcut.id] = () => focusPaneByIndex(index);
      }
    }
    return handlers;
  }, [splitFocused, addPane, closeFocusedPane, cycleFocus, focusPaneByIndex, focusedPaneId, toggleMaximize]);

  // Disabled entirely while any overlay is open — otherwise e.g. Cmd+D would
  // both split a pane in the background AND leave the theme picker open,
  // which is surprising. Each overlay's own Escape handler (and, for the
  // palette, its own arrow-key/Enter navigation) covers in-overlay input;
  // this hook only needs to own the "nothing's open" case.
  useKeyboardShortcuts(shortcutHandlers, activeOverlay === null);

  // --- Command palette contents ----------------------------------------------
  // Every keyboard action, plus "Switch to workspace: X", "New workspace",
  // "Layout: N panes", "Theme: X", and (when the focused pane is empty)
  // "Start <agent> in this pane" — built fresh whenever anything it reads
  // from changes, so e.g. renaming a workspace updates its palette entry too.

  const focusedEmptyPane = useMemo(() => {
    if (!root || !focusedPaneId) return null;
    const pane = findPane(root, focusedPaneId);
    return pane?.kind === "leaf" && !pane.sessionId ? pane : null;
  }, [root, focusedPaneId]);

  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    const commands: PaletteCommand[] = [];

    for (const shortcut of KEYMAP) {
      const handler = shortcutHandlers[shortcut.id];
      if (!handler) continue;
      commands.push({
        id: `action-${shortcut.id}`,
        label: shortcut.label,
        category: "Action",
        shortcut: formatShortcut(shortcut, isMac),
        // The palette runs these as plain clicks/Enter presses, not real
        // key combos — every handler here ignores its `event` argument
        // (it only exists so `useKeyboardShortcuts` can pass the real one
        // through when a shortcut fires normally), so an empty stand-in
        // object is enough.
        run: () => handler({} as KeyboardEvent),
      });
    }

    for (const workspace of workspaces) {
      commands.push({
        id: `workspace-${workspace.id}`,
        label: `Switch to workspace: ${workspace.name}`,
        category: "Workspace",
        run: () => switchWorkspace(workspace.id),
      });
    }
    commands.push({
      id: "new-workspace",
      label: "New workspace",
      category: "Workspace",
      run: () => openCreateForm(),
    });

    for (const n of TEMPLATE_SIZES) {
      commands.push({
        id: `layout-${n}`,
        label: `Layout: ${n} pane${n === 1 ? "" : "s"}`,
        category: "Layout",
        run: () => applyTemplate(n),
      });
    }

    for (const t of THEMES) {
      commands.push({
        id: `theme-${t.id}`,
        label: `Theme: ${t.name}`,
        category: "Theme",
        run: () => setTheme(t.id),
      });
    }

    if (focusedEmptyPane) {
      for (const agent of agents) {
        if (!agent.available) continue;
        commands.push({
          id: `start-agent-${agent.id}`,
          label: `Start ${agent.displayName} in this pane`,
          category: "Agent",
          run: () => void startAgentInFocusedPane(agent.id),
        });
      }
    }

    return commands;
  }, [
    shortcutHandlers,
    isMac,
    workspaces,
    switchWorkspace,
    openCreateForm,
    applyTemplate,
    setTheme,
    focusedEmptyPane,
    agents,
    startAgentInFocusedPane,
  ]);

  const healthStatusKind = health.kind === "loaded" ? "ok" : health.kind === "error" ? "danger" : "idle";
  const healthTitle =
    health.kind === "loaded"
      ? `Server ok (v${health.health.version})`
      : health.kind === "error"
        ? `Server unreachable: ${health.message}`
        : "Checking server…";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        background: "var(--vd-bg)",
        color: "var(--vd-text)",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        fontSize: 12,
      }}
    >
      <GlobalShellStyles />

      {/* Top bar — 36px, per docs/DESIGN.md §1: mark, breadcrumb, and
          exactly the three right-aligned icon buttons the spec calls for
          (theme picker, help, right-dock toggle). Deliberately short —
          vertical space belongs to the terminal grid below it. */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          height: 36,
          minHeight: 36,
          padding: "0 10px",
          borderBottom: "1px solid var(--vd-border)",
          background: "var(--vd-surface)",
          flexShrink: 0,
        }}
      >
        <span
          aria-hidden
          style={{ width: 8, height: 8, borderRadius: 2, background: "var(--vd-accent)", flexShrink: 0 }}
        />
        <strong style={{ fontSize: 13, fontWeight: 600, letterSpacing: "-0.01em", flexShrink: 0 }}>
          vibedeck
        </strong>

        <StatusDot status={healthStatusKind} title={healthTitle} />

        <span
          style={{
            fontSize: 11,
            color: "var(--vd-text-muted)",
            display: "flex",
            alignItems: "center",
            gap: 4,
            overflow: "hidden",
            minWidth: 0,
          }}
        >
          {activeWorkspace ? (
            <>
              <span style={{ color: "var(--vd-text)" }}>{activeWorkspace.name}</span>
              <span style={{ color: "var(--vd-text-faint)" }}>›</span>
              <span
                style={{
                  color: "var(--vd-text-faint)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={activeWorkspace.rootPath}
              >
                {activeWorkspace.rootPath}
              </span>
            </>
          ) : (
            "No workspace"
          )}
        </span>

        <div style={{ flex: 1 }} />

        <select
          value={defaultAgent}
          onChange={(e) => setDefaultAgent(e.target.value as AgentId)}
          title="Default agent for new panes"
          style={{
            background: "var(--vd-surface)",
            color: "var(--vd-text)",
            border: "1px solid var(--vd-border)",
            borderRadius: 4,
            padding: "2px 6px",
            fontSize: 11,
          }}
        >
          <option value="" disabled>
            Default agent…
          </option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id} disabled={!agent.available}>
              {agent.displayName}
              {!agent.available ? " (not installed)" : ""}
            </option>
          ))}
        </select>

        <IconButton
          title={`Theme: ${theme.name} (${formatShortcut(KEYMAP.find((s) => s.id === "theme-picker")!, isMac)})`}
          onClick={() => setActiveOverlay("theme")}
        >
          <span
            aria-hidden
            style={{
              width: 12,
              height: 12,
              borderRadius: "50%",
              background: theme.ui.accent,
              border: "1px solid var(--vd-border)",
            }}
          />
        </IconButton>
        <IconButton title="Keyboard shortcuts" onClick={() => setActiveOverlay("help")}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>?</span>
        </IconButton>
        <IconButton
          title={dockCollapsed ? "Show right dock" : "Hide right dock"}
          onClick={toggleDockCollapsed}
          active={!dockCollapsed}
        >
          <DockToggleIcon open={!dockCollapsed} />
        </IconButton>
      </header>

      {/* The three-column body: left rail, centre grid, right dock. */}
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        {workspacesLoaded && workspaces.length > 0 && (
          <WorkspaceRail
            workspaces={workspaces}
            activeWorkspaceId={activeWorkspaceId}
            collapsed={railCollapsed}
            onToggleCollapsed={toggleRailCollapsed}
            runningCount={workspacePaneCount}
            onSwitch={switchWorkspace}
            showCreateForm={showCreateForm}
            onOpenCreateForm={openCreateForm}
            newWorkspaceName={newWorkspaceName}
            onNewWorkspaceNameChange={setNewWorkspaceName}
            newWorkspacePath={newWorkspacePath}
            onNewWorkspacePathChange={setNewWorkspacePath}
            onCreateWorkspace={() => void createWorkspace()}
            onCancelCreate={() => setShowCreateForm(false)}
            creating={creating}
            createError={createError}
            renamingId={renamingId}
            renameValue={renameValue}
            onRenameValueChange={setRenameValue}
            onStartRename={startRename}
            onCommitRename={() => void commitRename()}
            onCancelRename={cancelRename}
            renameError={renameError}
            pendingDeleteWorkspaceId={pendingDeleteWorkspaceId}
            onRequestDelete={requestDeleteWorkspace}
            onConfirmDelete={() => void confirmDeleteWorkspace()}
            onCancelDelete={cancelDeleteWorkspace}
          />
        )}

        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          {pendingTemplate !== null && (
            <div style={confirmBannerStyle}>
              <span>
                Switching to a {pendingTemplate}-pane layout will close panes that still have running
                sessions. Continue?
              </span>
              <button onClick={confirmTemplate} style={primaryButtonStyle}>
                Discard and switch
              </button>
              <button onClick={cancelTemplate} style={secondaryButtonStyle}>
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
                  <p style={{ color: "var(--vd-text-muted)", marginBottom: 12, fontSize: 12 }}>
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
                    <p style={{ color: "var(--vd-danger)", fontSize: 11, marginTop: 8 }}>{createError}</p>
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
                theme={theme}
                focusedPaneId={focusedPaneId}
                onFocus={handleFocus}
                onSessionStarted={handleSessionStarted}
                onSplit={handleSplit}
                onClosePane={handleClosePane}
                maximizedPaneId={maximizedPaneId}
                onToggleMaximize={toggleMaximize}
              />
            ) : (
              <div style={centeredStyle}>Loading…</div>
            )}
          </div>
        </div>

        {!dockCollapsed && (
          <RightDock
            activeWorkspace={activeWorkspace}
            agents={agents}
            workspaceSessions={activeWorkspace ? sessionsForWorkspace(activeWorkspace) : []}
          />
        )}
      </div>

      {activeOverlay === "palette" && (
        <CommandPalette commands={paletteCommands} onClose={closeOverlay} />
      )}
      {activeOverlay === "theme" && (
        <ThemePicker
          currentThemeId={themeId}
          onSelect={(id) => {
            setTheme(id);
            closeOverlay();
          }}
          onClose={closeOverlay}
        />
      )}
      {activeOverlay === "help" && <KeyboardCheatSheet onClose={closeOverlay} />}
    </div>
  );
}

/** A small "panel" glyph for the right-dock toggle — filled when the dock
 * is open, outline-only when it's closed. Inline SVG, no icon library. */
function DockToggleIcon({ open }: { open: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <rect x="1.5" y="2.5" width="11" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.1" />
      <rect
        x="8.5"
        y="2.5"
        width="4"
        height="9"
        rx="0.5"
        fill={open ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.1"
      />
    </svg>
  );
}

const primaryButtonStyle: React.CSSProperties = {
  background: "var(--vd-accent)",
  color: "var(--vd-accent-text)",
  border: "none",
  borderRadius: 4,
  padding: "4px 12px",
  fontSize: 12,
  cursor: "pointer",
};

const secondaryButtonStyle: React.CSSProperties = {
  background: "transparent",
  color: "var(--vd-text-muted)",
  border: "1px solid var(--vd-border)",
  borderRadius: 4,
  padding: "4px 12px",
  fontSize: 12,
  cursor: "pointer",
};

const formInputStyle: React.CSSProperties = {
  background: "var(--vd-bg)",
  color: "var(--vd-text)",
  border: "1px solid var(--vd-border)",
  borderRadius: 4,
  padding: "5px 8px",
  fontSize: 12,
};

// A destructive-confirmation banner ("this will close running sessions") is
// exactly what docs/DESIGN.md §2's `--warn` status colour means — "working /
// attention" — so deriving its background/border from that token (via
// `color-mix`, not a hard-coded hex) both satisfies "every colour carries
// meaning, never decoration" (DESIGN.md §6 rule 2) AND keeps this banner
// visually consistent with whichever theme is active, the same way the
// original fixed-amber version stayed consistent across themes.
const confirmBannerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "6px 12px",
  background: "color-mix(in srgb, var(--vd-warn) 18%, var(--vd-bg))",
  borderBottom: "1px solid var(--vd-warn)",
  fontSize: 12,
  flexWrap: "wrap",
  flexShrink: 0,
};

const centeredStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: "100%",
  color: "var(--vd-text-muted)",
};
