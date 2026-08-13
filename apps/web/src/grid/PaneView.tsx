import { useState } from "react";
import type { AgentId, SessionInfo, Workspace } from "@vibedeck/shared";
import Terminal from "../term/Terminal.js";
import type { Theme } from "../themes/themes.js";
import type { Direction, PaneId } from "./tree.js";
import { IconButton, StatusDot, sessionStatusKind } from "../shell/ui.js";
import { useGitBranch } from "./useGitBranch.js";

/** One entry from `GET /api/agents` — mirrors the shape App.tsx already fetches. */
export interface AgentOption {
  id: AgentId;
  displayName: string;
  available: boolean;
}

interface PaneViewProps {
  paneId: PaneId;
  /** The session this pane's leaf currently points at, or null if it's empty. */
  sessionId: string | null;
  /** Looked-up SessionInfo for `sessionId` (title/status), or null if empty/not found yet. */
  session: SessionInfo | null;
  agents: AgentOption[];
  /** Pre-highlighted choice in the empty-pane agent picker (the header <select>'s current value). */
  defaultAgent: AgentId | "";
  /** The active workspace's id, sent with `POST /api/sessions` so the new
   * pty spawns in that workspace's rootPath instead of the server's own
   * cwd. Null only in the (should-be-rare) case no workspace is active. */
  workspaceId: string | null;
  /** The active workspace itself (not just its id) — Phase 9.5c, PARITY
   * #13c/#41: this pane's header names the workspace (and, if the
   * workspace has a chosen colour, tints its chip with it) alongside the
   * agent. Null in the same rare case `workspaceId` is. */
  workspace: Workspace | null;
  /** The active theme, threaded down to this pane's `<Terminal>` so its
   * ANSI palette matches what the rest of the app is showing. */
  theme: Theme;
  isFocused: boolean;
  onFocus: () => void;
  /** Fired once `POST /api/sessions` succeeds for this (previously empty) pane. */
  onSessionStarted: (paneId: PaneId, session: SessionInfo) => void;
  onSplit: (paneId: PaneId, direction: Direction) => void;
  /** Fired once this pane should be removed from the tree (session already killed, if it had one). */
  onClosePane: (paneId: PaneId) => void;
  /** Whether THIS pane is the one currently filling the whole grid — see
   * Grid.tsx's `maximizedPaneId`. Purely a rendering/icon-swap concern here;
   * Grid.tsx owns the actual "render only this pane, full size" decision. */
  isMaximized: boolean;
  /** Toggles maximize for this pane. Wired to both the title-bar icon and
   * (via App.tsx) the Cmd+Shift+Return shortcut / Escape key. */
  onToggleMaximize: (paneId: PaneId) => void;
}

/**
 * One cell of the grid. Either shows a small agent picker (empty pane) or a
 * live `<Terminal>` (pane with a session). Always mounted for as long as its
 * leaf exists in the tree — the grid never hides panes via unmounting, so a
 * pane's terminal keeps streaming output even while some other pane has
 * focus.
 *
 * Styling follows docs/DESIGN.md §5 "Pane": 6px radius, 1px border, and a
 * focused pane gets a 1px accent border and NOTHING else (no glow/thick
 * ring). The title-bar icon row (split/maximise/close) only shows on hover
 * or while focused — see the `.vd-pane`/`.vd-pane-icons` rules in
 * `shell/ui.tsx`'s `GlobalShellStyles`.
 */
export default function PaneView({
  paneId,
  sessionId,
  session,
  agents,
  defaultAgent,
  workspaceId,
  workspace,
  theme,
  isFocused,
  onFocus,
  onSessionStarted,
  onSplit,
  onClosePane,
  isMaximized,
  onToggleMaximize,
}: PaneViewProps) {
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  // Phase 9.5c, PARITY #13b — polls independently per pane; see
  // useGitBranch.ts's top comment for why polling (not a filesystem watch)
  // and the resulting staleness window.
  const gitBranch = useGitBranch(workspaceId);

  const startSession = async (agent: AgentId) => {
    setStartError(null);
    setStarting(true);
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(workspaceId ? { agent, workspaceId } : { agent }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Server responded with ${res.status}`);
      }
      const info = (await res.json()) as SessionInfo;
      onSessionStarted(paneId, info);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setStarting(false);
    }
  };

  // Used by the header's "close" button. Terminal's own right-click "Close"
  // menu item already DELETEs the session itself before calling its onClose
  // prop, so this DELETE-then-remove pair only needs to run here, when the
  // *header* button (not Terminal's own menu) triggered the close.
  const closeFromHeader = () => {
    if (sessionId) {
      fetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch((err: unknown) => {
        console.warn("vibedeck: failed to close session", err);
      });
    }
    onClosePane(paneId);
  };

  const statusKind = sessionStatusKind(session ? session.status : "empty");

  return (
    <div
      // Clicking anywhere in the pane (including inside the terminal, since
      // this event bubbles up before Terminal handles its own clicks)
      // focuses it — that's what drives the accent border below.
      onMouseDown={onFocus}
      className={`vd-pane${isFocused ? " is-focused" : ""}`}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        boxSizing: "border-box",
        borderRadius: 6,
        overflow: "hidden",
        border: `1px solid ${isFocused ? "var(--vd-accent)" : "var(--vd-border)"}`,
        background: "var(--vd-bg)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          height: 26,
          padding: "0 6px",
          borderBottom: "1px solid var(--vd-border)",
          flexShrink: 0,
          fontSize: 12,
          color: "var(--vd-text-muted)",
          boxSizing: "border-box",
        }}
      >
        <StatusDot status={statusKind} title={session ? session.status : "empty"} />
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {session ? session.title : "empty pane"}
          {session?.status === "exited" && ` (exited ${session.exitCode})`}
        </span>
        {/* Phase 9.5c, PARITY #13c: names the workspace alongside the agent
            — `● agent · workspace`, matching BridgeSpace's header shape.
            Coloured dot only appears once the workspace has a chosen colour
            (PARITY #41); no colour means no dot, not a random one. */}
        {workspace && (
          <span
            title={workspace.rootPath}
            style={{
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              gap: 4,
              color: "var(--vd-text-faint)",
              maxWidth: 140,
              overflow: "hidden",
            }}
          >
            <span aria-hidden>·</span>
            {workspace.color && (
              <span
                aria-hidden
                style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: workspace.color }}
              />
            )}
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {workspace.name}
            </span>
          </span>
        )}
        {/* Phase 9.5c, PARITY #13b: the git branch chip. Renders nothing
            while the branch hasn't loaded yet OR the directory isn't a git
            repo at all — `isRepo: false` is a clean, honest answer (see
            GitBranchResponse's doc comment), not an error state to show. */}
        {gitBranch?.isRepo && gitBranch.branch && (
          <span
            title={`Branch: ${gitBranch.branch}`}
            style={{
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              gap: 3,
              color: "var(--vd-text-faint)",
              fontSize: 11,
              maxWidth: 120,
              overflow: "hidden",
            }}
          >
            <BranchIcon />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {gitBranch.branch}
            </span>
          </span>
        )}
        <div className="vd-pane-icons" style={{ display: "flex", alignItems: "center", gap: 2 }}>
          <IconButton title="Split vertical" onClick={() => onSplit(paneId, "row")}>
            <SplitVerticalIcon />
          </IconButton>
          <IconButton title="Split horizontal" onClick={() => onSplit(paneId, "column")}>
            <SplitHorizontalIcon />
          </IconButton>
          <IconButton
            title={isMaximized ? "Restore pane" : "Maximize pane"}
            onClick={() => onToggleMaximize(paneId)}
          >
            {isMaximized ? <RestoreIcon /> : <MaximizeIcon />}
          </IconButton>
          <IconButton title="Close pane" onClick={closeFromHeader}>
            <CloseIcon />
          </IconButton>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0 }}>
        {sessionId ? (
          <Terminal
            sessionId={sessionId}
            // `session` is looked up by sessionId in the same render pass
            // that sets sessionId itself (Grid.tsx's onSessionStarted path
            // updates both together), so this should always be populated
            // by the time a session id exists — the "shell" fallback only
            // guards the theoretical instant it isn't, defaulting to the
            // SAFER of the two busy-detection paths (exact, not heuristic).
            agentId={session?.agent ?? "shell"}
            theme={theme}
            onClose={() => onClosePane(paneId)}
            // Phase 9.5c, PARITY #9: the right-click menu's "Split right" /
            // "Split down" entries call this SAME handler the header's split
            // icons already call (see the IconButtons above) — no separate
            // split logic lives in Terminal.tsx.
            onSplit={(direction) => onSplit(paneId, direction)}
          />
        ) : (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>
            <div style={{ textAlign: "center" }}>
              <p style={{ color: "var(--vd-text-muted)", fontSize: 12, marginBottom: 10 }}>
                Start an agent in this pane
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 160 }}>
                {agents.map((agent) => (
                  <button
                    key={agent.id}
                    disabled={!agent.available || starting}
                    onClick={() => void startSession(agent.id)}
                    style={{
                      background: agent.id === defaultAgent ? "var(--vd-accent)" : "var(--vd-surface)",
                      color: agent.id === defaultAgent ? "var(--vd-accent-text)" : "var(--vd-text)",
                      border: "1px solid var(--vd-border)",
                      borderRadius: 4,
                      padding: "6px 14px",
                      cursor: agent.available && !starting ? "pointer" : "not-allowed",
                      opacity: agent.available ? 1 : 0.5,
                      fontSize: 12,
                    }}
                  >
                    {agent.displayName}
                    {!agent.available ? " (not installed)" : ""}
                  </button>
                ))}
              </div>
              {startError && (
                <p style={{ color: "var(--vd-danger)", fontSize: 11, marginTop: 8 }}>{startError}</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Title-bar icons ---------------------------------------------------
// Inline SVG, 14x14, `currentColor` strokes so they pick up IconButton's
// faint→text hover colour automatically — no icon library, no external
// requests (per Phase 4.5's constraints).

function SplitVerticalIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <rect x="1.5" y="2.5" width="11" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.1" />
      <line x1="7" y1="2.5" x2="7" y2="11.5" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

function SplitHorizontalIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <rect x="1.5" y="2.5" width="11" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.1" />
      <line x1="1.5" y1="7" x2="12.5" y2="7" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

function MaximizeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M2 5.5V2h3.5M12 5.5V2H8.5M2 8.5V12h3.5M12 8.5V12H8.5"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M5.5 2v3.5H2M8.5 2v3.5H12M5.5 12V8.5H2M8.5 12V8.5H12"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A small git-branch glyph (two nodes joined by a curved line, the
 * conventional "branch" icon) — inline SVG, matching this file's other
 * title-bar icons: no icon library, `currentColor` so it inherits the
 * chip's muted text colour. */
function BranchIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 14 14" fill="none" aria-hidden style={{ flexShrink: 0 }}>
      <circle cx="4" cy="3" r="1.8" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="4" cy="11" r="1.8" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="10" cy="6" r="1.8" stroke="currentColor" strokeWidth="1.1" />
      <path d="M4 4.8V9.2" stroke="currentColor" strokeWidth="1.1" />
      <path d="M4 6.5C4 5 5 4 6.5 4H8.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M3 3L11 11M11 3L3 11"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}
