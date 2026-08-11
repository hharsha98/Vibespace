import { useState } from "react";
import type { AgentId, SessionInfo } from "@vibedeck/shared";
import Terminal from "../term/Terminal.js";
import type { Theme } from "../themes/themes.js";
import type { Direction, PaneId } from "./tree.js";

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
}

/**
 * One cell of the grid. Either shows a small agent picker (empty pane) or a
 * live `<Terminal>` (pane with a session). Always mounted for as long as its
 * leaf exists in the tree — the grid never hides panes via unmounting, so a
 * pane's terminal keeps streaming output even while some other pane has
 * focus.
 */
export default function PaneView({
  paneId,
  sessionId,
  session,
  agents,
  defaultAgent,
  workspaceId,
  theme,
  isFocused,
  onFocus,
  onSessionStarted,
  onSplit,
  onClosePane,
}: PaneViewProps) {
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

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

  return (
    <div
      // Clicking anywhere in the pane (including inside the terminal, since
      // this event bubbles up before Terminal handles its own clicks)
      // focuses it — that's what drives the accent border below.
      onMouseDown={onFocus}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        boxSizing: "border-box",
        border: `2px solid ${isFocused ? "var(--vd-accent)" : "var(--vd-border)"}`,
        background: "var(--vd-bg)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "3px 6px",
          borderBottom: "1px solid var(--vd-border)",
          flexShrink: 0,
          fontSize: 12,
          color: "var(--vd-text-muted)",
        }}
      >
        <span
          title={session ? session.status : "empty"}
          style={{
            display: "inline-block",
            width: 6,
            height: 6,
            flexShrink: 0,
            borderRadius: "50%",
            background:
              session?.status === "running" ? "#81c995" : session ? "var(--vd-text-muted)" : "var(--vd-border)",
          }}
        />
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {session ? session.title : "empty pane"}
          {session?.status === "exited" && ` (exited ${session.exitCode})`}
        </span>
        <button onClick={() => onSplit(paneId, "row")} title="Split horizontal" style={paneButtonStyle}>
          ⬓
        </button>
        <button onClick={() => onSplit(paneId, "column")} title="Split vertical" style={paneButtonStyle}>
          ⬒
        </button>
        <button onClick={closeFromHeader} title="Close pane" style={paneButtonStyle}>
          ✕
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0 }}>
        {sessionId ? (
          <Terminal sessionId={sessionId} theme={theme} onClose={() => onClosePane(paneId)} />
        ) : (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>
            <div style={{ textAlign: "center" }}>
              <p style={{ color: "var(--vd-text-muted)", fontSize: 13, marginBottom: 10 }}>
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
                      fontSize: 13,
                    }}
                  >
                    {agent.displayName}
                    {!agent.available ? " (not installed)" : ""}
                  </button>
                ))}
              </div>
              {startError && <p style={{ color: "#f28b82", fontSize: 12, marginTop: 8 }}>{startError}</p>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const paneButtonStyle: React.CSSProperties = {
  background: "transparent",
  color: "var(--vd-text-muted)",
  border: "none",
  cursor: "pointer",
  fontSize: 12,
  lineHeight: 1,
  padding: "2px 4px",
};
