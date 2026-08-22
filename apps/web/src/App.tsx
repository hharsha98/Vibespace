import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentId,
  SessionInfo,
  SshProfile,
  SshProfilesResponse,
  Workspace,
  WorkspaceRestoreResponse,
} from "@vibedeck/shared";
import Grid from "./grid/Grid.js";
import type { AgentOption } from "./grid/PaneView.js";
import {
  attachSession,
  buildTemplate,
  clearDeferredPane,
  closePaneOrEmpty,
  createLeaf,
  findPane,
  listPanes,
  markPaneDeferred,
  pruneDeadSessions,
  splitPane,
  type Direction,
  type GridNode,
  type PaneId,
} from "./grid/tree.js";
import { KEYMAP, formatShortcut, isMacPlatform } from "./keys/keymap.js";
import { useKeyboardShortcuts, type ShortcutHandlers } from "./keys/useKeyboardShortcuts.js";
import { getBlocksSnapshot, scrollSessionToLine } from "./term/blockStore.js";
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
import WorkspaceTabStrip from "./shell/WorkspaceTabStrip.js";
import { templateLabel } from "./grid/templateNames.js";
import { workspaceIdForTabIndex } from "./shell/workspaceTabs.js";
import RightDock from "./shell/RightDock.js";
import Logo from "./shell/Logo.js";
import { GlobalShellStyles, IconButton, StatusDot } from "./shell/ui.js";
import UpdateBanner from "./shell/UpdateBanner.js";
import Editor, { type OpenFileRequest } from "./files/Editor.js";
import Preview from "./files/Preview.js";
import QuickOpen from "./files/QuickOpen.js";
import Board from "./board/Board.js";
import Graph from "./memory/Graph.js";
import type { OpenNoteRequest } from "./memory/MemoryPanel.js";
import Swarm from "./swarm/Swarm.js";
import Agents from "./agents/Agents.js";
import Prompts from "./prompts/Prompts.js";
import SshProfiles from "./ssh/SshProfiles.js";
import Skills from "./skills/Skills.js";
import type { PaneRef } from "./skills/logic.js";
import Settings from "./settings/Settings.js";
import type { CenterView } from "./viewTypes.js";
import { ViewIcon } from "./shell/viewIcons.js";
import { FONT, MOTION, RADIUS, SHADOW_VAR } from "./shell/tokens.js";

/** Which full-screen overlay (if any) is currently open. Only one at a
 * time — opening a new one implicitly replaces whichever was open, and
 * `useKeyboardShortcuts` is disabled entirely while any of them is open, so
 * e.g. Cmd+D can't accidentally split a pane while the user is browsing the
 * theme picker. */
type OverlayKind = "palette" | "theme" | "help" | "quickOpen" | null;

// `CenterView` (which view the centre column is showing, Phase 6's view
// switcher — see docs/DESIGN.md's centre-column note; Phase 7 added
// "board", Phase 9.5b added "agents"/"prompts") now lives in viewTypes.ts,
// shared with shell/viewIcons.tsx's icon lookup — see that file's top
// comment for why. All views are kept MOUNTED at all times once a
// workspace is active (see the render below) — only CSS `display` toggles
// which one is visible — so switching views never disconnects a running
// terminal's WebSocket, never discards an editor tab's unsaved buffer, and
// never re-fetches the board's card list on every switch either.

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
 * GET a JSON endpoint, refusing to treat an error response as data.
 *
 * `fetch` resolves for 4xx/5xx, so `.then(res => res.json())` happily
 * parses the server's `{error: "..."}` body and hands back an object whose
 * expected field is `undefined`. The startup loads below then did things
 * like `setAgents(undefined)`, which does not fail where it happens — it
 * fails later, at the first `agents.map(...)`, a long way from the cause.
 * A `.catch()` does not save it either: a 500 is not a rejection, so the
 * existing fallbacks never ran.
 */
async function loadJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Server responded with ${res.status}`);
  }
  return (await res.json()) as T;
}

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

/**
 * Session recovery, deferred cold-start restore (BridgeSpace v3.4.13
 * parity): asks the server to eagerly resume up to its bounded budget of
 * `workspaceId`'s recoverable sessions (`POST
 * /api/workspaces/:id/restore-sessions` — see `apps/server/src/pty/
 * restore.ts`), then folds the result into whatever tree is currently
 * showing: restored panes get their fresh session attached (via
 * `attachSession`, same as the ordinary picker path), everything past the
 * budget (or dropped by the circuit breaker) gets marked `deferred` so
 * `PaneView.tsx` can offer its "restore this pane" affordance.
 *
 * Deliberately fire-and-forget from the CALLER's point of view — it never
 * blocks the tree `layoutToTree` already built and `setRoot` already
 * applied on the network round trip; this only patches that tree once the
 * server responds, via `setRoot`'s functional-updater form so it composes
 * safely with whatever the user did in the meantime.
 */
function restoreWorkspaceSessions(
  workspaceId: string,
  setRoot: (updater: (prev: GridNode | null) => GridNode | null) => void,
  setSessions: (updater: (prev: SessionInfo[]) => SessionInfo[]) => void
): void {
  fetch(`/api/workspaces/${workspaceId}/restore-sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  })
    .then((res) => {
      if (!res.ok) throw new Error(`Server responded with ${res.status}`);
      return res.json() as Promise<WorkspaceRestoreResponse>;
    })
    .then((body) => {
      if (body.restored.length === 0 && body.deferred.length === 0) return;
      setSessions((prev) => [...prev, ...body.restored.map((r) => r.session)]);
      setRoot((prev) => {
        if (!prev) return prev;
        let next = prev;
        for (const restored of body.restored) {
          next = attachSession(next, restored.paneId, restored.session.id);
        }
        for (const deferred of body.deferred) {
          next = markPaneDeferred(next, deferred.paneId, deferred);
        }
        return next;
      });
    })
    .catch((err: unknown) => {
      console.warn("vibedeck: failed to restore workspace sessions", err);
    });
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

// Phase 9.5c (PARITY #45, Settings screen): the default-agent picker existed
// in the nav bar since Phase 2 but was NEVER actually persisted — it reset
// to "first available agent" on every reload. Same try/catch-around-
// localStorage pattern as `loadBoolPref`/`saveBoolPref` above and
// `themes.ts`'s `loadStoredThemeId`/`saveThemeId`; this is the project's one
// established persistence mechanism (there is no other settings store), so
// Settings.tsx's new preferences follow it too rather than inventing a
// second one.
const DEFAULT_AGENT_KEY = "vibedeck.defaultAgent";

function loadStoredDefaultAgent(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(DEFAULT_AGENT_KEY);
  } catch {
    return null; // Private-browsing Safari throws on access, not just on write.
  }
}

function saveDefaultAgent(id: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DEFAULT_AGENT_KEY, id);
  } catch {
    // Storage full or disabled — the choice still applies for this session,
    // it just won't be remembered next time. Not worth surfacing to the user.
  }
}

// --- `?workspace=<id>` deep link (the `vibedeck` CLI, apps/server/src/cli) -
// `vibedeck [path]` ensures a workspace exists for that path, then opens the
// browser at `/?workspace=<id>` so the RIGHT workspace is selected instead
// of whichever one happens to be first (see `tryInitRoot` below) — without
// this, the CLI would open the app but the user would still have to click
// the right row in the rail by hand, defeating half the point of a
// `bridgespace .`-style entry point. Read once, on the initial mount only
// (not synced afterward — this is a one-shot "open at" hint, not a
// persistent URL<->state binding like some SPAs use); the param is stripped
// from the URL immediately after use via `history.replaceState` so
// reloading the page, or copying the URL to share it, doesn't keep forcing
// the same workspace.
function readAndConsumeWorkspaceIdFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const id = params.get("workspace");
  if (!id) return null;
  params.delete("workspace");
  const nextSearch = params.toString();
  const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}${window.location.hash}`;
  window.history.replaceState(null, "", nextUrl);
  return id;
}

export default function App() {
  const [health, setHealth] = useState<HealthState>({ kind: "loading" });
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [defaultAgent, setDefaultAgent] = useState<AgentId | "">("");

  // --- SSH connection profiles ---------------------------------------------
  // Owned HERE (not fetched independently by ssh/SshProfiles.tsx the way
  // agents/Agents.tsx owns its own agent-profile fetch) because TWO
  // different places read this same list: the SSH Profiles page itself and
  // PaneView.tsx's empty-pane picker (its "Remote (SSH)" group, threaded
  // through via <Grid sshProfiles={...}> below). A page-owned private copy
  // would mean a profile created on the SSH page doesn't show up in the
  // picker until some unrelated refetch happened to fire — see
  // ssh/SshProfiles.tsx's own top comment for the fuller version of this
  // reasoning.
  const [sshProfiles, setSshProfiles] = useState<SshProfile[]>([]);
  const [sshProfilesLoadState, setSshProfilesLoadState] = useState<"loading" | "loaded" | "error">(
    "loading"
  );
  const [sshProfilesLoadError, setSshProfilesLoadError] = useState<string | null>(null);

  const reloadSshProfiles = useCallback(() => {
    setSshProfilesLoadState("loading");
    setSshProfilesLoadError(null);
    fetch("/api/ssh-profiles")
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Server responded with ${res.status}`);
        }
        return (await res.json()) as SshProfilesResponse;
      })
      .then((body) => {
        setSshProfiles(body.profiles);
        setSshProfilesLoadState("loaded");
      })
      .catch((err: unknown) => {
        setSshProfilesLoadError(err instanceof Error ? err.message : "Failed to load SSH profiles");
        setSshProfilesLoadState("error");
      });
  }, []);

  // Fetch once on mount — `reloadSshProfiles` has a stable (empty-deps)
  // identity, so this effect only ever runs once, same as the big
  // health/agents/sessions/workspaces mount effect below.
  useEffect(() => {
    reloadSshProfiles();
  }, [reloadSshProfiles]);
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
  /** Which layout template a workspace being created should start with.
   * BridgeSpace asks this during setup ("Choose a workspace template — pick
   * a layout that matches your workflow"); we only ever made a single empty
   * pane and left you to build the grid afterwards. Defaults to 1, which is
   * exactly what creation did before, so the quick path is unchanged. */
  const [newWorkspaceTemplate, setNewWorkspaceTemplate] = useState<number>(1);
  /** Set when a delete actually failed, so the confirmation can say so
   * instead of the workspace silently staying put with no explanation. */
  const [deleteError, setDeleteError] = useState<string | null>(null);

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

  // Phase 9.5c: the one place `defaultAgent` is ever changed, so persistence
  // (see `saveDefaultAgent` above) can never be forgotten at a call site —
  // both the nav-bar `<select>` below and the new Settings page use this.
  const updateDefaultAgent = useCallback((id: AgentId) => {
    setDefaultAgent(id);
    saveDefaultAgent(id);
  }, []);

  // --- Overlays (command palette, theme picker, keyboard cheat sheet) ------

  const [activeOverlay, setActiveOverlay] = useState<OverlayKind>(null);
  const closeOverlay = useCallback(() => setActiveOverlay(null), []);

  // --- Phase 6: centre-column view + editor "open this file" requests -----
  const [centerView, setCenterView] = useState<CenterView>("terminals");
  // Bumped every time the file tree or quick-open asks to open a file —
  // Editor.tsx watches `requestId` (not just `path`) so re-clicking the
  // SAME file (e.g. after closing its tab) still re-opens it, which a
  // plain `path` prop's unchanged-value check would otherwise miss.
  const [editorOpenRequest, setEditorOpenRequest] = useState<OpenFileRequest | null>(null);
  const openFileInEditor = useCallback((path: string) => {
    setCenterView("editor");
    setEditorOpenRequest((prev) => ({ path, requestId: (prev?.requestId ?? 0) + 1 }));
  }, []);

  // --- Phase 8: memory Graph "click a node" -> Memory tab -------------------
  // Bumped whenever the Graph view wants the right dock's Memory tab to show
  // a specific note — RightDock.tsx forwards this to MemoryPanel.tsx, whose
  // own useEffect (same bumped-requestId pattern as editorOpenRequest above)
  // reacts by fetching and displaying that note.
  const [openNoteRequest, setOpenNoteRequest] = useState<OpenNoteRequest | null>(null);
  const openNoteInMemoryTab = useCallback((slug: string) => {
    // Switching tabs is useless if the dock itself is collapsed — force it
    // open the same way toggleDockCollapsed would, so clicking a graph node
    // always actually shows something rather than silently updating a
    // panel nobody can see.
    setDockCollapsedState(false);
    saveBoolPref(DOCK_COLLAPSED_KEY, false);
    setOpenNoteRequest((prev) => ({ slug, requestId: (prev?.requestId ?? 0) + 1 }));
  }, []);

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

    loadJson<{ agents: AgentOption[] }>("/api/agents")
      .then((body) => {
        setAgents(body.agents);
        // Phase 9.5c: honour a previously-saved default agent if it's still
        // installed and available; otherwise fall back to the original
        // "first available" behaviour (also what happens for a first-ever
        // run, with nothing saved yet).
        const stored = loadStoredDefaultAgent();
        const storedOption = body.agents.find((a) => a.id === stored && a.available);
        const firstAvailable = body.agents.find((a) => a.available);
        const initial = storedOption ?? firstAvailable;
        if (initial) setDefaultAgent(initial.id);
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
        // A `?workspace=<id>` param (see readAndConsumeWorkspaceIdFromUrl's
        // doc comment) wins over "first workspace" when it names one that
        // actually exists in what we just loaded — a stale/unknown id
        // (workspace deleted since the link was made, or just a typo) falls
        // back to the original "first" behaviour rather than showing
        // nothing.
        const deepLinkId = readAndConsumeWorkspaceIdFromUrl();
        const deepLinked = deepLinkId ? loadedWorkspaces.find((w) => w.id === deepLinkId) : undefined;
        const initial = deepLinked ?? loadedWorkspaces[0];
        setActiveWorkspaceId(initial.id);
        setRoot(layoutToTree(initial.layout, loadedSessions));
        // Session recovery: patches in any eagerly-restored/deferred panes
        // once the server responds — see restoreWorkspaceSessions's own
        // doc comment for why this never blocks the tree set just above.
        restoreWorkspaceSessions(initial.id, setRoot, setSessions);
      }
      // If there are zero workspaces, `root` stays null and `workspacesLoaded`
      // (now true) drives the first-run prompt instead of "Loading…".
    };

    loadJson<{ sessions: SessionInfo[] }>("/api/sessions")
      .then((body) => {
        loadedSessions = body.sessions;
        tryInitRoot();
      })
      .catch((err: unknown) => {
        console.warn("vibedeck: failed to load sessions", err);
        loadedSessions = []; // still let workspace/root init proceed
        tryInitRoot();
      });

    loadJson<{ workspaces: Workspace[] }>("/api/workspaces")
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

  // Phase 7: the board's "Dispatch" action just created a session via
  // POST /api/board/cards/:id/dispatch — unlike handleSessionStarted above,
  // there's no specific pane it was started FROM (the board isn't a pane at
  // all), so this folds it into whichever empty pane already exists, or
  // splits a fresh one if every pane is occupied — the same two building
  // blocks (`attachSession`/`splitPane`) addPane() already uses.
  const handleSessionDispatched = useCallback(
    (session: SessionInfo) => {
      setSessions((prev) => [...prev, session]);
      // Reads `root`/`focusedPaneId` directly from the closure (not via a
      // `setRoot(prev => ...)` functional updater) specifically so the
      // matching `setFocusedPaneId` call below can sit next to it as a
      // plain, separate statement — same style `handleClosePane` already
      // uses elsewhere in this file — rather than triggering a second
      // state update from inside a `setState` updater function, which
      // React's StrictMode double-invokes in development.
      if (!root) return;
      const panes = listPanes(root);
      const emptyPane = panes.find((p) => p.sessionId === null);
      if (emptyPane) {
        setRoot(attachSession(root, emptyPane.id, session.id));
        setFocusedPaneId(emptyPane.id);
        return;
      }
      const target = panes.find((p) => p.id === focusedPaneId) ?? panes[0];
      const split = splitPane(root, target.id, "row");
      // The freshly-created leaf is the only pane id NOT present before
      // the split — findable by diffing the before/after pane id sets.
      const beforeIds = new Set(panes.map((p) => p.id));
      const newLeafId = listPanes(split).find((p) => !beforeIds.has(p.id))?.id;
      setRoot(newLeafId ? attachSession(split, newLeafId, session.id) : split);
      if (newLeafId) setFocusedPaneId(newLeafId);
    },
    [root, focusedPaneId]
  );

  // Phase 7: clicking a dispatched board card's session indicator — switch
  // to Terminals and focus whichever pane that session ended up attached
  // to (via handleSessionDispatched above, or wherever else it may have
  // landed since).
  //
  // Phase 9b reuses this SAME function for the swarm canvas's "Show
  // terminal" action (see swarm/SidePanel.tsx) — but a mission agent's pty
  // session is created entirely server-side (`swarm/dispatch.ts` calls
  // `sessionManager.create` directly), unlike a board card's, which always
  // gets attached to a pane client-side via `handleSessionDispatched`
  // above at the moment it's dispatched. So a swarm agent's session ID
  // never has a matching pane to find — the search below would silently
  // do nothing. The fallback (attach to an empty pane, or split the
  // focused one) is exactly `handleSessionDispatched`'s own logic, reused
  // rather than forked, so "jump to this session's terminal" behaves
  // identically everywhere it's offered, regardless of how that session
  // came to exist.
  const focusSessionInGrid = useCallback(
    (sessionId: string) => {
      setCenterView("terminals");
      if (!root) return;
      const panes = listPanes(root);
      const existing = panes.find((p) => p.sessionId === sessionId);
      if (existing) {
        setFocusedPaneId(existing.id);
        return;
      }

      const emptyPane = panes.find((p) => p.sessionId === null);
      if (emptyPane) {
        setRoot(attachSession(root, emptyPane.id, sessionId));
        setFocusedPaneId(emptyPane.id);
        return;
      }
      const target = panes.find((p) => p.id === focusedPaneId) ?? panes[0];
      const split = splitPane(root, target.id, "row");
      const beforeIds = new Set(panes.map((p) => p.id));
      const newLeafId = listPanes(split).find((p) => !beforeIds.has(p.id))?.id;
      setRoot(newLeafId ? attachSession(split, newLeafId, sessionId) : split);
      if (newLeafId) setFocusedPaneId(newLeafId);
    },
    [root, focusedPaneId]
  );

  const handleSplit = useCallback((paneId: PaneId, direction: Direction) => {
    setRoot((prev) => (prev ? splitPane(prev, paneId, direction) : prev));
  }, []);

  // "Launch more than one..." (BridgeSpace parity, PaneView.tsx's empty-pane
  // picker). Smallest honest version: exactly 2 agents, side by side — see
  // grid/agentPicker.ts's MAX_MULTI_LAUNCH comment for why this doesn't
  // (yet) generalise to arbitrary N. Reuses the SAME split-then-diff-ids
  // trick handleSessionDispatched/focusSessionInGrid above already use to
  // find a freshly-created leaf's id: splitPane doesn't hand the new leaf's
  // id back directly, so it's found by diffing the pane-id sets before and
  // after the split.
  const handleLaunchMultiple = useCallback(
    (paneId: PaneId, agentIds: AgentId[]) => {
      if (!root || agentIds.length !== 2) return;
      const [firstAgent, secondAgent] = agentIds;
      const panesBefore = listPanes(root);
      const split = splitPane(root, paneId, "row");
      const beforeIds = new Set(panesBefore.map((p) => p.id));
      const newLeafId = listPanes(split).find((p) => !beforeIds.has(p.id))?.id;
      if (!newLeafId) return;

      setRoot(split);
      setFocusedPaneId(paneId);

      const startOne = (agent: AgentId, targetPaneId: PaneId) =>
        fetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...(activeWorkspaceId ? { agent, workspaceId: activeWorkspaceId } : { agent }),
            paneId: targetPaneId,
          }),
        })
          .then((res) => {
            if (!res.ok) throw new Error(`Server responded with ${res.status}`);
            return res.json() as Promise<SessionInfo>;
          })
          .then((session) => {
            setSessions((prev) => [...prev, session]);
            setRoot((prev) => (prev ? attachSession(prev, targetPaneId, session.id) : prev));
          })
          .catch((err: unknown) => {
            // Same "warn, leave that half of the split empty" fallback
            // PaneView.tsx's own single-agent startSession uses on failure
            // — the other agent (if it already started) keeps running.
            console.warn(`vibedeck: failed to start "${agent}" during multi-launch`, err);
          });

      void startOne(firstAgent, paneId);
      void startOne(secondAgent, newLeafId);
    },
    [root, activeWorkspaceId]
  );

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
      // ...OrEmpty, because a plain `closePane` returns null once the last
      // pane goes, and null is ALSO this component's "layout hasn't loaded
      // yet" state (`useState<GridNode | null>(null)` above) — which the
      // render below shows as "Loading…". Closing your last pane therefore
      // parked the whole app on a spinner that could never resolve,
      // because nothing was loading; only a page reload escaped it. See
      // closePaneOrEmpty's own comment in grid/tree.ts.
      setRoot(closePaneOrEmpty(root, paneId));
      setFocusedPaneId((prev) => (prev === paneId ? null : prev));
      setMaximizedPaneId((prev) => (prev === paneId ? null : prev));
    },
    [root]
  );

  // Session recovery: a deferred pane's record was just explicitly
  // discarded (PaneView.tsx's "Discard" button, already confirmed
  // server-side via POST /api/session-records/:id/discard) — clear its
  // `deferred` marker so the pane falls back to a plain empty state.
  const handleDeferredDiscarded = useCallback(
    (paneId: PaneId) => {
      setRoot((prev) => (prev ? clearDeferredPane(prev, paneId) : prev));
    },
    []
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

  // The SessionInfo behind whichever pane currently has focus — null if no
  // pane is focused, or the focused pane is empty. This is what drives the
  // right dock's "Blocks" tab (Phase 5): it always shows the FOCUSED pane's
  // command blocks, so switching focus switches which pane's blocks you're
  // looking at, the same way switching focus already changes which pane
  // Cmd+D/Cmd+Shift+W etc operate on.
  const focusedSession = useMemo(() => {
    if (!root || !focusedPaneId) return null;
    const pane = findPane(root, focusedPaneId);
    if (!pane || pane.kind !== "leaf" || !pane.sessionId) return null;
    return sessions.find((s) => s.id === pane.sessionId) ?? null;
  }, [root, focusedPaneId, sessions]);

  // Cmd+Up / Cmd+Down (Phase 5): jump the focused pane's terminal to the
  // previous/next command block. `blockNavIndexRef` remembers, PER
  // session, which block we last jumped to — so repeated presses walk
  // through the list in order instead of always snapping back to the most
  // recent block. A plain ref (not React state) is enough since nothing
  // ever needs to re-render off of it; it only exists to make repeated key
  // presses feel like they're moving through a list.
  const blockNavIndexRef = useRef<Map<string, number>>(new Map());
  const jumpBlock = useCallback(
    (delta: 1 | -1) => {
      if (!focusedSession) return;
      // BlockTracker.list() (surfaced here via getBlocksSnapshot) is
      // oldest-first; "previous" (Cmd+Up, like shell history) means older
      // = lower index, "next" (Cmd+Down) means more recent = higher index.
      const blocks = getBlocksSnapshot(focusedSession.id);
      if (blocks.length === 0) return;
      const current = blockNavIndexRef.current.get(focusedSession.id) ?? blocks.length - 1;
      const next = Math.min(Math.max(current + delta, 0), blocks.length - 1);
      blockNavIndexRef.current.set(focusedSession.id, next);
      scrollSessionToLine(focusedSession.id, blocks[next].startLine);
    },
    [focusedSession]
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
          body: JSON.stringify({
            ...(activeWorkspaceId ? { agent, workspaceId: activeWorkspaceId } : { agent }),
            paneId: focusedPaneId,
          }),
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

  // The SSH-profile counterpart to startAgentInFocusedPane above — same
  // "only acts on a currently-empty focused pane" guard, same request shape
  // as PaneView.tsx's own startSshSession, just reachable from the command
  // palette's "Connect to <profile> in this pane" entries too.
  const startSshProfileInFocusedPane = useCallback(
    async (profileId: string) => {
      if (!root || !focusedPaneId) return;
      const pane = findPane(root, focusedPaneId);
      if (!pane || pane.kind !== "leaf" || pane.sessionId) return;
      try {
        const res = await fetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...(activeWorkspaceId
              ? { sshProfileId: profileId, workspaceId: activeWorkspaceId }
              : { sshProfileId: profileId }),
            paneId: focusedPaneId,
          }),
        });
        if (!res.ok) return;
        const info = (await res.json()) as SessionInfo;
        handleSessionStarted(focusedPaneId, info);
      } catch (err) {
        console.warn("vibedeck: failed to start an SSH session from the command palette", err);
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
      // Session recovery: same restore call the initial mount makes — a
      // workspace switch is just as much "this workspace becoming active"
      // as the first load is.
      restoreWorkspaceSessions(targetId, setRoot, setSessions);
    },
    [activeWorkspaceId, root, workspaces, sessions]
  );

  const openCreateForm = useCallback(() => {
    setNewWorkspaceName("");
    setNewWorkspacePath(serverCwd);
    setNewWorkspaceTemplate(1);
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
      // buildTemplate(1) is a bare leaf with no split (asserted in
      // tree.test.ts), so the default is byte-for-byte the old behaviour.
      setRoot(buildTemplate(newWorkspaceTemplate));
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
  }, [newWorkspaceName, newWorkspacePath, newWorkspaceTemplate]);

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

  // Phase 9.5c (PARITY #41): sets or clears (via `color: null`) a
  // workspace's chosen colour. Same PATCH-then-reconcile shape as
  // `commitRename` above, minus the "editing in progress" local state —
  // the colour picker's open/closed toggle is purely transient UI state
  // that lives inside WorkspaceRail.tsx itself (see that file's own
  // comment), so this callback only ever needs to own the actual mutation.
  const setWorkspaceColor = useCallback(async (id: string, color: string | null) => {
    try {
      const res = await fetch(`/api/workspaces/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ color }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<Workspace> & { error?: string };
      if (!res.ok) {
        throw new Error(body.error ?? `Server responded with ${res.status}`);
      }
      const updated = body as Workspace;
      setWorkspaces((prev) => prev.map((w) => (w.id === updated.id ? updated : w)));
    } catch (err) {
      console.warn("vibedeck: failed to set workspace colour", err);
    }
  }, []);

  const requestDeleteWorkspace = useCallback((id: string) => {
    setPendingDeleteWorkspaceId(id);
  }, []);

  // Clears the error too, so a previous failure isn't still on screen the
  // next time the confirmation opens.
  const cancelDeleteWorkspace = useCallback(() => {
    setPendingDeleteWorkspaceId(null);
    setDeleteError(null);
  }, []);

  const confirmDeleteWorkspace = useCallback(async () => {
    const id = pendingDeleteWorkspaceId;
    if (!id) return;
    // Both halves of this matter. `fetch` only rejects on a NETWORK
    // failure — an HTTP 404 or 500 resolves normally — so without the
    // `res.ok` check a server-side refusal counted as success. And the UI
    // used to drop the workspace whether or not the delete actually
    // happened, which is the worse half: the workspace vanished from the
    // tab strip, looked deleted, and came back on the next launch because
    // the server still had it. Observed exactly that, with the row still
    // present in ~/.vibedeck/vibedeck.db after the tab was gone.
    //
    // Now a failure leaves the workspace visible and says so, which is the
    // honest outcome — the alternative is a UI that lies about what it did.
    try {
      const res = await fetch(`/api/workspaces/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setDeleteError(body.error ?? `Could not delete workspace (HTTP ${res.status})`);
        return;
      }
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Could not reach the server.");
      return;
    }
    setDeleteError(null);
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
      "prev-block": () => jumpBlock(-1),
      "next-block": () => jumpBlock(1),
      "view-terminals": () => setCenterView("terminals"),
      "view-editor": () => setCenterView("editor"),
      "view-preview": () => setCenterView("preview"),
      "view-board": () => setCenterView("board"),
      "view-graph": () => setCenterView("graph"),
      "view-swarm": () => setCenterView("swarm"),
      "view-agents": () => setCenterView("agents"),
      "view-prompts": () => setCenterView("prompts"),
      "view-skills": () => setCenterView("skills"),
      "view-ssh": () => setCenterView("ssh"),
      "view-settings": () => setCenterView("settings"),
      "quick-open": () => {
        if (activeWorkspaceId) setActiveOverlay("quickOpen");
      },
      // ⌘T / ⌘W, matching BridgeSpace's documented shortcut table. Both go
      // through the SAME paths the tab strip's own "+" and "×" use — a
      // shortcut that quietly skipped the delete confirmation would be a
      // very expensive difference, since a workspace can own running agent
      // sessions.
      "new-workspace-tab": () => openCreateForm(),
      "close-workspace-tab": () => {
        if (activeWorkspaceId) requestDeleteWorkspace(activeWorkspaceId);
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
      // Same trick for the nine "switch to workspace tab N" shortcuts.
      // `workspaceIdForTabIndex` returns null when there is no tab at that
      // position — ⌘7 with three workspaces open does nothing at all,
      // rather than throwing on an undefined array slot.
      if (shortcut.workspaceIndex !== undefined) {
        const oneBased = shortcut.workspaceIndex + 1;
        handlers[shortcut.id] = () => {
          const id = workspaceIdForTabIndex(workspaces, oneBased);
          if (id !== null && id !== activeWorkspaceId) switchWorkspace(id);
        };
      }
    }
    return handlers;
  }, [
    splitFocused,
    addPane,
    closeFocusedPane,
    cycleFocus,
    focusPaneByIndex,
    focusedPaneId,
    toggleMaximize,
    jumpBlock,
    activeWorkspaceId,
  ]);

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

  // Phase 10 (PARITY #37): every pane in the ACTIVE workspace's own grid
  // that currently has a live, running session attached — the Skills
  // view's "Send to pane…" target list (see skills/Skills.tsx's top
  // comment for why that's a list of buttons rather than a real drop
  // zone). Deliberately built from `root`/`listPanes`, NOT the raw
  // `sessions` array directly — `sessions` can include sessions from
  // OTHER workspaces (it's fetched once from `GET /api/sessions`, which
  // is global), and a pane in some other workspace's grid is not a
  // sensible injection target for a skill browsed against this one.
  const skillsPanes = useMemo<PaneRef[]>(() => {
    if (!root) return [];
    const sessionsById = new Map(sessions.map((s) => [s.id, s]));
    const targets: PaneRef[] = [];
    listPanes(root).forEach((pane, index) => {
      if (!pane.sessionId) return;
      const session = sessionsById.get(pane.sessionId);
      if (!session || session.status !== "running") return;
      targets.push({ paneId: pane.id, index, session });
    });
    return targets;
  }, [root, sessions]);

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
        // "Layout: Quad (4)" rather than "Layout: 4 panes" — BridgeSpace
        // names its templates, and the count stays visible either way.
        label: `Layout: ${templateLabel(n)}`,
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
      for (const profile of sshProfiles) {
        commands.push({
          id: `start-ssh-${profile.id}`,
          label: `Connect to ${profile.name} in this pane`,
          category: "SSH",
          run: () => void startSshProfileInFocusedPane(profile.id),
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
    sshProfiles,
    startSshProfileInFocusedPane,
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

      {/* Phase 11b (PARITY #51): no-op in the browser build (UpdateBanner
          itself checks isTauriApp()) — only ever visible in the desktop
          build, and only once a real update has actually been found. */}
      <UpdateBanner />

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
        <Logo size={16} accent="var(--vd-accent)" />
        <strong style={{ fontSize: FONT.title, fontWeight: 600, letterSpacing: "-0.01em", flexShrink: 0 }}>
          vibedeck
        </strong>

        <StatusDot status={healthStatusKind} title={healthTitle} />

        {/* Workspaces as tabs (BridgeSpace's own layout — see
            WorkspaceTabs.tsx). They live here rather than in the left
            sidebar, which is now purely the file browser. */}
        <WorkspaceTabStrip
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
          onSwitch={switchWorkspace}
          onNewWorkspace={openCreateForm}
          onRequestClose={requestDeleteWorkspace}
          renamingId={renamingId}
          renameValue={renameValue}
          onRenameValueChange={setRenameValue}
          onStartRename={startRename}
          onCommitRename={() => void commitRename()}
          onCancelRename={cancelRename}
          renameError={renameError}
          runningCount={workspacePaneCount}
          onSetWorkspaceColor={(id, color) => void setWorkspaceColor(id, color)}
        />

        {/* Just the path now. The workspace's NAME is on its tab a few
            pixels to the left, and printing it twice in one 36px bar spends
            horizontal room the tab strip needs more. */}
        <span
          style={{
            fontSize: 11,
            color: "var(--vd-text-faint)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
            flexShrink: 1,
          }}
          title={activeWorkspace ? activeWorkspace.rootPath : undefined}
        >
          {activeWorkspace ? activeWorkspace.rootPath : "No workspace"}
        </span>

        <div style={{ flex: 1 }} />

        {/* Phase 6/7/9.5b, now grouped (premium-pass, problem #4): Terminals/
            Editor/Preview (the workspace views) | Board/Graph/Swarm (planning
            & orchestration) | Agents/Prompts/Skills (the library) | Settings
            on its own, each cluster separated by a hairline divider instead
            of ten flat tabs in an undifferentiated row. See CenterView's doc
            comment in viewTypes.ts for why all ten stay mounted regardless
            of which is visible. */}
        <div
          role="tablist"
          aria-label="Centre column view"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 2,
            background: "var(--vd-bg)",
            border: "1px solid var(--vd-border)",
            borderRadius: RADIUS.md,
            padding: 3,
            flexShrink: 0,
          }}
        >
          <ViewTabButton
            view="terminals"
            active={centerView === "terminals"}
            onClick={() => setCenterView("terminals")}
            shortcut={formatShortcut(KEYMAP.find((s) => s.id === "view-terminals")!, isMac)}
          >
            Terminals
          </ViewTabButton>
          <ViewTabButton
            view="editor"
            active={centerView === "editor"}
            onClick={() => setCenterView("editor")}
            shortcut={formatShortcut(KEYMAP.find((s) => s.id === "view-editor")!, isMac)}
          >
            Editor
          </ViewTabButton>
          <ViewTabButton
            view="preview"
            active={centerView === "preview"}
            onClick={() => setCenterView("preview")}
            shortcut={formatShortcut(KEYMAP.find((s) => s.id === "view-preview")!, isMac)}
          >
            Preview
          </ViewTabButton>

          <TabGroupDivider />

          <ViewTabButton
            view="board"
            active={centerView === "board"}
            onClick={() => setCenterView("board")}
            shortcut={formatShortcut(KEYMAP.find((s) => s.id === "view-board")!, isMac)}
          >
            Board
          </ViewTabButton>
          <ViewTabButton
            view="graph"
            active={centerView === "graph"}
            onClick={() => setCenterView("graph")}
            shortcut={formatShortcut(KEYMAP.find((s) => s.id === "view-graph")!, isMac)}
          >
            Graph
          </ViewTabButton>
          <ViewTabButton
            view="swarm"
            active={centerView === "swarm"}
            onClick={() => setCenterView("swarm")}
            shortcut={formatShortcut(KEYMAP.find((s) => s.id === "view-swarm")!, isMac)}
          >
            Swarm
          </ViewTabButton>

          <TabGroupDivider />

          <ViewTabButton
            view="agents"
            active={centerView === "agents"}
            onClick={() => setCenterView("agents")}
            shortcut={formatShortcut(KEYMAP.find((s) => s.id === "view-agents")!, isMac)}
          >
            Agents
          </ViewTabButton>
          <ViewTabButton
            view="prompts"
            active={centerView === "prompts"}
            onClick={() => setCenterView("prompts")}
            shortcut={formatShortcut(KEYMAP.find((s) => s.id === "view-prompts")!, isMac)}
          >
            Prompts
          </ViewTabButton>
          <ViewTabButton
            view="skills"
            active={centerView === "skills"}
            onClick={() => setCenterView("skills")}
            shortcut={formatShortcut(KEYMAP.find((s) => s.id === "view-skills")!, isMac)}
          >
            Skills
          </ViewTabButton>
          <ViewTabButton
            view="ssh"
            active={centerView === "ssh"}
            onClick={() => setCenterView("ssh")}
            shortcut={formatShortcut(KEYMAP.find((s) => s.id === "view-ssh")!, isMac)}
          >
            SSH
          </ViewTabButton>

          <TabGroupDivider />

          <ViewTabButton
            view="settings"
            active={centerView === "settings"}
            onClick={() => setCenterView("settings")}
            shortcut={formatShortcut(KEYMAP.find((s) => s.id === "view-settings")!, isMac)}
          >
            Settings
          </ViewTabButton>
        </div>

        <select
          value={defaultAgent}
          onChange={(e) => updateDefaultAgent(e.target.value as AgentId)}
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
            onOpenFile={openFileInEditor}
            showCreateForm={showCreateForm}
            onOpenCreateForm={openCreateForm}
            newWorkspaceName={newWorkspaceName}
            onNewWorkspaceNameChange={setNewWorkspaceName}
            newWorkspacePath={newWorkspacePath}
            onNewWorkspacePathChange={setNewWorkspacePath}
            onCreateWorkspace={() => void createWorkspace()}
            newWorkspaceTemplate={newWorkspaceTemplate}
            onNewWorkspaceTemplateChange={setNewWorkspaceTemplate}
            onCancelCreate={() => setShowCreateForm(false)}
            creating={creating}
            createError={createError}
            deleteError={deleteError}
            pendingDeleteWorkspaceId={pendingDeleteWorkspaceId}
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
              // Phase 6: all three centre-column views stay mounted at
              // once, toggled with CSS `display` — NOT conditional
              // rendering — so switching away from Terminals never
              // disconnects a pane's WebSocket (it would reconnect and
              // replay scrollback, which technically "works" since sessions
              // are server-owned, but the reconnect churn is pointless per
              // this phase's own instruction), and switching away from
              // Editor never discards an open tab's unsaved buffer.
              <div style={{ position: "relative", height: "100%" }}>
                <div
                  style={{ position: "absolute", inset: 0, display: centerView === "terminals" ? "block" : "none" }}
                >
                  <Grid
                    key={gridEpoch}
                    root={root}
                    sessions={sessions}
                    agents={agents}
                    sshProfiles={sshProfiles}
                    defaultAgent={defaultAgent}
                    workspaceId={activeWorkspaceId}
                    workspace={activeWorkspace}
                    theme={theme}
                    focusedPaneId={focusedPaneId}
                    onFocus={handleFocus}
                    onSessionStarted={handleSessionStarted}
                    onDeferredDiscarded={handleDeferredDiscarded}
                    onLaunchMultiple={handleLaunchMultiple}
                    onSplit={handleSplit}
                    onClosePane={handleClosePane}
                    maximizedPaneId={maximizedPaneId}
                    onToggleMaximize={toggleMaximize}
                  />
                </div>
                <div style={{ position: "absolute", inset: 0, display: centerView === "editor" ? "block" : "none" }}>
                  <Editor workspaceId={activeWorkspaceId} theme={theme} openRequest={editorOpenRequest} />
                </div>
                <div style={{ position: "absolute", inset: 0, display: centerView === "preview" ? "block" : "none" }}>
                  <Preview />
                </div>
                <div style={{ position: "absolute", inset: 0, display: centerView === "board" ? "block" : "none" }}>
                  <Board
                    workspaceId={activeWorkspaceId}
                    agents={agents}
                    defaultAgent={defaultAgent}
                    sessions={sessions}
                    onSessionDispatched={handleSessionDispatched}
                    onFocusSession={focusSessionInGrid}
                  />
                </div>
                <div style={{ position: "absolute", inset: 0, display: centerView === "graph" ? "block" : "none" }}>
                  <Graph
                    workspaceId={activeWorkspaceId}
                    onOpenNote={openNoteInMemoryTab}
                    visible={centerView === "graph"}
                  />
                </div>
                <div style={{ position: "absolute", inset: 0, display: centerView === "swarm" ? "block" : "none" }}>
                  <Swarm
                    workspaceId={activeWorkspaceId}
                    agents={agents}
                    visible={centerView === "swarm"}
                    onFocusSession={focusSessionInGrid}
                  />
                </div>
                <div style={{ position: "absolute", inset: 0, display: centerView === "agents" ? "block" : "none" }}>
                  <Agents workspaceId={activeWorkspaceId} visible={centerView === "agents"} />
                </div>
                <div style={{ position: "absolute", inset: 0, display: centerView === "prompts" ? "block" : "none" }}>
                  <Prompts workspaceId={activeWorkspaceId} visible={centerView === "prompts"} />
                </div>
                <div style={{ position: "absolute", inset: 0, display: centerView === "skills" ? "block" : "none" }}>
                  <Skills
                    workspaceId={activeWorkspaceId}
                    visible={centerView === "skills"}
                    panes={skillsPanes}
                    onFocusSession={focusSessionInGrid}
                  />
                </div>
                <div style={{ position: "absolute", inset: 0, display: centerView === "ssh" ? "block" : "none" }}>
                  <SshProfiles
                    visible={centerView === "ssh"}
                    profiles={sshProfiles}
                    loadState={sshProfilesLoadState}
                    loadError={sshProfilesLoadError}
                    onReload={reloadSshProfiles}
                    onProfilesChange={setSshProfiles}
                  />
                </div>
                <div style={{ position: "absolute", inset: 0, display: centerView === "settings" ? "block" : "none" }}>
                  <Settings
                    themeId={themeId}
                    onThemeChange={setTheme}
                    defaultAgent={defaultAgent}
                    onDefaultAgentChange={updateDefaultAgent}
                    agents={agents}
                    workspaces={workspaces}
                    // Session recovery: History's "Resume" reuses the exact
                    // same "fold a fresh session into an empty pane, or
                    // split the focused one" placement logic the board's
                    // own Dispatch action already uses — see
                    // History.tsx's top comment for why resuming from
                    // History behaves like a dispatch, not a pane-local
                    // restore.
                    onSessionResumed={handleSessionDispatched}
                  />
                </div>
              </div>
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
            focusedSession={focusedSession}
            workspaceId={activeWorkspaceId}
            openNoteRequest={openNoteRequest}
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
      {activeOverlay === "quickOpen" && (
        <QuickOpen workspaceId={activeWorkspaceId} onClose={closeOverlay} onOpenFile={openFileInEditor} />
      )}
    </div>
  );
}

/** One button in the top bar's grouped view-switcher segmented control
 * (docs/DESIGN.md §1; premium-pass problem #4). Now carries its own icon
 * (`ViewIcon`, keyed off `view`) and a "solid" active state — a filled
 * accent pill with a soft shadow and bolder text, rather than the flat
 * accent rectangle this replaced — while keeping every existing
 * accessibility/keyboard-shortcut hook (`role="tab"`, `aria-selected`, the
 * shortcut-bearing `title`) byte-for-byte the same. */
function ViewTabButton({
  view,
  active,
  onClick,
  shortcut,
  children,
}: {
  view: CenterView;
  active: boolean;
  onClick: () => void;
  shortcut: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      title={`${children} (${shortcut})`}
      className="vd-view-tab"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        background: active ? "var(--vd-accent)" : "transparent",
        color: active ? "var(--vd-accent-text)" : "var(--vd-text-muted)",
        border: "none",
        borderRadius: RADIUS.sm,
        padding: "5px 10px",
        fontSize: FONT.meta,
        fontWeight: active ? 600 : 500,
        boxShadow: active ? SHADOW_VAR.sm : "none",
        cursor: "pointer",
        whiteSpace: "nowrap",
        // Motion pass: the active pill's fill/shadow now animates in
        // instead of snapping when a view switch changes which tab is
        // active — ".vd-view-tab"'s own hover transition (GlobalShellStyles)
        // covers the same properties, this just makes sure the ACTIVE-state
        // change (driven by this inline style, which always wins over the
        // class per shell/ui.tsx's IconButton doc comment) animates too.
        transition: `background-color ${MOTION.fast} ${MOTION.easing}, color ${MOTION.fast} ${MOTION.easing}, box-shadow ${MOTION.fast} ${MOTION.easing}`,
      }}
    >
      <ViewIcon view={view} />
      {children}
    </button>
  );
}

/** A 1px hairline between logical groups of view tabs (workspace views /
 * planning views / the library / settings) — see the tablist's own comment
 * for why these four clusters, replacing ten undifferentiated tabs. */
function TabGroupDivider() {
  return (
    <span
      aria-hidden
      style={{
        width: 1,
        alignSelf: "stretch",
        margin: "3px 2px",
        background: "var(--vd-border)",
        flexShrink: 0,
      }}
    />
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
