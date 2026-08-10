import { useEffect, useState } from "react";
import type { AgentId } from "@vibedeck/shared";

interface HealthResponse {
  status: string;
  version: string;
  agents: AgentId[];
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; health: HealthResponse };

export default function App() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;

    fetch("/api/health")
      .then((res) => {
        if (!res.ok) {
          throw new Error(`Server responded with ${res.status}`);
        }
        return res.json() as Promise<HealthResponse>;
      })
      .then((health) => {
        if (!cancelled) setState({ kind: "loaded", health });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({
            kind: "error",
            message: err instanceof Error ? err.message : "Unknown error",
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#0f1115",
        color: "#e6e6e6",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "1rem",
        padding: "2rem",
      }}
    >
      <h1 style={{ margin: 0, fontSize: "2rem" }}>vibedeck</h1>
      <p style={{ margin: 0, color: "#9aa0a6" }}>Phase 0 — wiring proof</p>

      <section
        style={{
          marginTop: "1.5rem",
          background: "#1a1d24",
          border: "1px solid #2a2e37",
          borderRadius: "8px",
          padding: "1.5rem",
          minWidth: "320px",
        }}
      >
        {state.kind === "loading" && <p>Checking server…</p>}

        {state.kind === "error" && (
          <p style={{ color: "#f28b82" }}>
            Could not reach the server: {state.message}
          </p>
        )}

        {state.kind === "loaded" && (
          <>
            <p style={{ margin: "0 0 0.5rem" }}>
              Status: <strong style={{ color: "#81c995" }}>{state.health.status}</strong>{" "}
              (v{state.health.version})
            </p>
            <p style={{ margin: "0 0 0.25rem", color: "#9aa0a6" }}>Supported agents:</p>
            <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
              {state.health.agents.map((agent) => (
                <li key={agent}>{agent}</li>
              ))}
            </ul>
          </>
        )}
      </section>
    </main>
  );
}
