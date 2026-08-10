import { useCallback, useEffect, useState } from "react";
import type { AgentId, SessionInfo } from "@vibedeck/shared";
import Terminal from "./term/Terminal.js";

interface HealthResponse {
  status: string;
  version: string;
}

interface AgentOption {
  id: AgentId;
  displayName: string;
  available: boolean;
}

type HealthState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; health: HealthResponse };

export default function App() {
  const [health, setHealth] = useState<HealthState>({ kind: "loading" });
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<AgentId | "">("");
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  // Load server health, the agent menu, and any sessions already running on
  // the server (e.g. left over from before a page refresh) once on mount.
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
        if (firstAvailable) setSelectedAgent(firstAvailable.id);
      })
      .catch((err: unknown) => {
        console.warn("vibedeck: failed to load agents", err);
      });

    fetch("/api/sessions")
      .then((res) => res.json() as Promise<{ sessions: SessionInfo[] }>)
      .then((body) => {
        setSessions(body.sessions);
        if (body.sessions.length > 0) {
          setActiveSessionId(body.sessions[body.sessions.length - 1].id);
        }
      })
      .catch((err: unknown) => {
        console.warn("vibedeck: failed to load sessions", err);
      });
  }, []);

  const createSession = useCallback(async () => {
    if (!selectedAgent) return;
    setCreateError(null);
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: selectedAgent }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Server responded with ${res.status}`);
      }
      const info = (await res.json()) as SessionInfo;
      setSessions((prev) => [...prev, info]);
      setActiveSessionId(info.id);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Unknown error");
    }
  }, [selectedAgent]);

  // A session's Terminal calls this once it's confirmed the server-side
  // session was actually killed (via the right-click "Close" menu item).
  const handleSessionClosed = useCallback((id: string) => {
    setSessions((prev) => prev.filter((s) => s.id !== id));
    setActiveSessionId((current) => (current === id ? null : current));
  }, []);

  const activeSession = sessions.find((s) => s.id === activeSessionId);

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

        <select
          value={selectedAgent}
          onChange={(e) => setSelectedAgent(e.target.value as AgentId)}
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

        <button
          onClick={() => void createSession()}
          disabled={!selectedAgent}
          style={{
            background: "#2a6df4",
            color: "white",
            border: "none",
            borderRadius: 4,
            padding: "0.4rem 0.9rem",
            cursor: selectedAgent ? "pointer" : "not-allowed",
            opacity: selectedAgent ? 1 : 0.5,
          }}
        >
          New session
        </button>
      </header>

      {createError && (
        <div style={{ padding: "0.5rem 1rem", color: "#f28b82", fontSize: "0.85rem" }}>
          {createError}
        </div>
      )}

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <nav
          style={{
            width: 220,
            flexShrink: 0,
            borderRight: "1px solid #2a2e37",
            overflowY: "auto",
            padding: "0.5rem",
          }}
        >
          {sessions.length === 0 && (
            <p style={{ color: "#6b7280", fontSize: "0.85rem", padding: "0.5rem" }}>
              No sessions yet. Pick an agent and start one.
            </p>
          )}
          {sessions.map((session) => (
            <button
              key={session.id}
              onClick={() => setActiveSessionId(session.id)}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                background: session.id === activeSessionId ? "#1f2937" : "transparent",
                color: "#e6e6e6",
                border: "none",
                borderRadius: 4,
                padding: "0.5rem 0.6rem",
                marginBottom: 2,
                cursor: "pointer",
                fontSize: "0.85rem",
              }}
            >
              <span
                style={{
                  display: "inline-block",
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  marginRight: 6,
                  background: session.status === "running" ? "#81c995" : "#6b7280",
                }}
              />
              {session.title}
              {session.status === "exited" && (
                <span style={{ color: "#6b7280" }}> (exited {session.exitCode})</span>
              )}
            </button>
          ))}
        </nav>

        <main style={{ flex: 1, minWidth: 0 }}>
          {activeSession ? (
            // The `key` forces React to remount the Terminal when the
            // active session id changes, which is exactly what we want:
            // it closes the old view's socket and opens a fresh one for
            // the newly-selected session, replaying that session's own
            // scrollback.
            <Terminal
              key={activeSession.id}
              sessionId={activeSession.id}
              onClose={() => handleSessionClosed(activeSession.id)}
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
              Select or start a session to see its terminal.
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
