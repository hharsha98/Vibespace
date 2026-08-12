/**
 * The "no mission yet" state of the Swarm view (Phase 9b requirement #2): a
 * real form — mission prompt, plus one row per agent spec (role / agent CLI
 * / count) — not a placeholder. Posts straight to `POST
 * /api/swarm/missions` (see docs/SWARM.md's Missions section for the exact
 * body shape); `Swarm.tsx` owns the actual fetch and swaps this form out for
 * the canvas once a mission comes back.
 */
import { useState } from "react";
import { MISSION_ROLES, type AgentId, type MissionRole } from "@vibedeck/shared";
import type { AgentOption } from "../grid/PaneView.js";

export interface AgentSpecRow {
  role: MissionRole;
  agent: AgentId | "";
  count: number;
}

export interface CreateMissionFormProps {
  agents: AgentOption[];
  submitting: boolean;
  error: string | null;
  onSubmit: (prompt: string, rows: { role: MissionRole; agent: AgentId; count: number }[]) => void;
}

function nextRow(): AgentSpecRow {
  return { role: "builder", agent: "", count: 1 };
}

export default function CreateMissionForm({ agents, submitting, error, onSubmit }: CreateMissionFormProps) {
  const [prompt, setPrompt] = useState("");
  const [rows, setRows] = useState<AgentSpecRow[]>([{ role: "coordinator", agent: "", count: 1 }, nextRow()]);
  const [validationError, setValidationError] = useState<string | null>(null);

  const availableAgents = agents.filter((a) => a.available);

  function updateRow(index: number, patch: Partial<AgentSpecRow>) {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }

  function addRow() {
    setRows((prev) => [...prev, nextRow()]);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setValidationError(null);

    if (prompt.trim().length === 0) {
      setValidationError("The mission needs a prompt.");
      return;
    }
    if (rows.length === 0) {
      setValidationError("Add at least one agent to the mission.");
      return;
    }
    const incomplete = rows.find((r) => r.agent === "");
    if (incomplete) {
      setValidationError("Every row needs an agent CLI picked.");
      return;
    }

    onSubmit(
      prompt.trim(),
      rows.map((r) => ({ role: r.role, agent: r.agent as AgentId, count: r.count }))
    );
  }

  return (
    <form onSubmit={handleSubmit} style={formStyle}>
      <div style={{ maxWidth: 520 }}>
        <p style={introStyle}>
          No mission running in this workspace yet. Describe what the swarm should do, pick a role/agent/count for
          each dispatched session, then launch — see docs/SWARM-MECHANISM.md for how the coordinator splits this
          into tasks and waves.
        </p>

        <label style={labelStyle}>Mission prompt</label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="e.g. Build the login flow: form, validation, and a session cookie"
          rows={3}
          style={textareaStyle}
        />

        <label style={{ ...labelStyle, marginTop: 12 }}>Agents</label>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {rows.map((row, i) => (
            <div key={i} style={rowStyle}>
              <select value={row.role} onChange={(e) => updateRow(i, { role: e.target.value as MissionRole })} style={selectStyle}>
                {MISSION_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
              <select
                value={row.agent}
                onChange={(e) => updateRow(i, { agent: e.target.value as AgentId | "" })}
                style={selectStyle}
              >
                <option value="" disabled>
                  Agent CLI…
                </option>
                {availableAgents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.displayName}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min={1}
                value={row.count}
                onChange={(e) => updateRow(i, { count: Math.max(1, Number(e.target.value) || 1) })}
                style={countInputStyle}
              />
              <button
                type="button"
                onClick={() => removeRow(i)}
                disabled={rows.length <= 1}
                title="Remove row"
                style={removeButtonStyle}
              >
                ✕
              </button>
            </div>
          ))}
        </div>

        <button type="button" onClick={addRow} style={addRowButtonStyle}>
          + Add role
        </button>

        {availableAgents.length === 0 && (
          <p style={{ color: "var(--vd-warn)", fontSize: 11, marginTop: 8 }}>
            No agent CLIs are installed/available on this machine — install one first (see the top bar's agent
            picker for install hints).
          </p>
        )}

        {(validationError ?? error) && <p style={errorStyle}>{validationError ?? error}</p>}

        <button type="submit" disabled={submitting} style={submitButtonStyle}>
          {submitting ? "Launching…" : "Launch mission"}
        </button>
      </div>
    </form>
  );
}

const formStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  height: "100%",
  overflowY: "auto",
  padding: 32,
  boxSizing: "border-box",
};

const introStyle: React.CSSProperties = {
  color: "var(--vd-text-muted)",
  fontSize: 12,
  lineHeight: 1.5,
  marginBottom: 16,
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 10,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--vd-text-faint)",
  marginBottom: 6,
};

const textareaStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "var(--vd-bg)",
  color: "var(--vd-text)",
  border: "1px solid var(--vd-border)",
  borderRadius: 4,
  padding: "6px 8px",
  fontSize: 12,
  resize: "vertical",
  fontFamily: "inherit",
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  gap: 6,
  alignItems: "center",
};

const selectStyle: React.CSSProperties = {
  background: "var(--vd-bg)",
  color: "var(--vd-text)",
  border: "1px solid var(--vd-border)",
  borderRadius: 4,
  padding: "5px 6px",
  fontSize: 12,
  flex: 1,
};

const countInputStyle: React.CSSProperties = {
  width: 52,
  background: "var(--vd-bg)",
  color: "var(--vd-text)",
  border: "1px solid var(--vd-border)",
  borderRadius: 4,
  padding: "5px 6px",
  fontSize: 12,
};

const removeButtonStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--vd-text-faint)",
  cursor: "pointer",
  fontSize: 11,
  padding: 4,
};

const addRowButtonStyle: React.CSSProperties = {
  marginTop: 8,
  background: "transparent",
  border: "1px dashed var(--vd-border)",
  borderRadius: 4,
  color: "var(--vd-text-muted)",
  fontSize: 11,
  padding: "5px 10px",
  cursor: "pointer",
};

const submitButtonStyle: React.CSSProperties = {
  marginTop: 16,
  background: "var(--vd-accent)",
  color: "var(--vd-accent-text)",
  border: "none",
  borderRadius: 4,
  padding: "6px 14px",
  fontSize: 12,
  cursor: "pointer",
};

const errorStyle: React.CSSProperties = {
  color: "var(--vd-danger)",
  fontSize: 11,
  marginTop: 8,
};
