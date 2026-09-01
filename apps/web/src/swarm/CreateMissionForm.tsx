/**
 * The "no mission yet" state of the Swarm view (Phase 9b requirement #2): a
 * real form — mission prompt, plus one row per agent spec (role / agent CLI
 * / count) — not a placeholder. Posts straight to `POST
 * /api/swarm/missions` (see docs/SWARM.md's Missions section for the exact
 * body shape); `Swarm.tsx` owns the actual fetch and swaps this form out for
 * the canvas once a mission comes back.
 */
import { useState } from "react";
import { MISSION_ROLES, type AgentId, type MissionRole } from "@vibespace/shared";
import type { AgentOption } from "../grid/PaneView.js";
import { Button, EMPTY_SURFACE_BACKGROUND, EmptyState } from "../shell/ui.js";
import { FONT, RADIUS, SPACE } from "../shell/tokens.js";

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
    <div style={wrapStyle}>
      <div style={{ width: "100%", maxWidth: 560 }}>
        <EmptyState
          icon={
            <span style={iconBadgeStyle}>
              <MissionGlyph />
            </span>
          }
          title="Launch your first mission"
          description="Describe what the swarm should do, pick a role/agent/count for each dispatched session, then launch — the coordinator splits this into tasks and waves."
          maxWidth={480}
        >
          <form onSubmit={handleSubmit} style={formBodyStyle}>
            <label style={labelStyle}>Mission prompt</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g. Build the login flow: form, validation, and a session cookie"
              rows={3}
              style={textareaStyle}
            />

            <label style={{ ...labelStyle, marginTop: SPACE.md }}>Agents</label>
            <div style={{ display: "flex", flexDirection: "column", gap: SPACE.sm }}>
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
              <p style={{ color: "var(--vd-warn)", fontSize: FONT.meta, marginTop: SPACE.sm }}>
                No agent CLIs are installed/available on this machine — install one first (see the top bar's agent
                picker for install hints).
              </p>
            )}

            {(validationError ?? error) && <p style={errorStyle}>{validationError ?? error}</p>}

            <div style={{ marginTop: SPACE.lg }}>
              <Button type="submit" variant="primary" disabled={submitting}>
                {submitting ? "Launching…" : "Launch mission"}
              </Button>
            </div>
          </form>
        </EmptyState>
      </div>
    </div>
  );
}

/** A small mission-swarm glyph — three small nodes around a centre one, the
 * same "coordinator with team radiating out" shape the mission canvas itself
 * draws (MissionCanvas.tsx), so this onboarding icon previews what launching
 * actually produces. Inline SVG, no icon library. */
function MissionGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden style={{ color: "var(--vd-accent)" }}>
      <path d="M10 10L4 5.5M10 10L16 5.5M10 10L4 14.5M10 10L16 14.5" stroke="currentColor" strokeWidth="1.2" opacity="0.6" />
      <circle cx="10" cy="10" r="2.6" fill="currentColor" />
      <circle cx="4" cy="5.5" r="1.8" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="16" cy="5.5" r="1.8" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="4" cy="14.5" r="1.8" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="16" cy="14.5" r="1.8" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

/** The full-pane wrapper — same dotted-texture "real content lives here"
 * background PaneView.tsx's own empty-pane picker uses, so a workspace's
 * first look at Swarm reads as a designed onboarding screen rather than a
 * bare form marooned in blank space. */
const wrapStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  height: "100%",
  overflowY: "auto",
  padding: SPACE.xl,
  boxSizing: "border-box",
  background: "var(--vd-bg)",
  ...EMPTY_SURFACE_BACKGROUND,
};

const iconBadgeStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 40,
  height: 40,
  borderRadius: "50%",
  background: "color-mix(in srgb, var(--vd-accent) 16%, transparent)",
};

/** The form's own fields render left-aligned, overriding EmptyState's
 * centred text — the icon/title/description above stay centred (that part
 * IS a headline), but a form of labelled inputs reads naturally left-to-
 * right, same as every other form in the app. */
const formBodyStyle: React.CSSProperties = {
  textAlign: "left",
  width: "100%",
  marginTop: SPACE.lg,
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: FONT.label,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--vd-text-faint)",
  marginBottom: SPACE.xs + 2,
};

const textareaStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "var(--vd-bg)",
  color: "var(--vd-text)",
  border: "1px solid var(--vd-border)",
  borderRadius: RADIUS.sm,
  padding: "6px 8px",
  fontSize: FONT.body,
  resize: "vertical",
  fontFamily: "inherit",
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  gap: SPACE.sm,
  alignItems: "center",
};

const selectStyle: React.CSSProperties = {
  background: "var(--vd-bg)",
  color: "var(--vd-text)",
  border: "1px solid var(--vd-border)",
  borderRadius: RADIUS.sm,
  padding: "5px 6px",
  fontSize: FONT.body,
  flex: 1,
};

const countInputStyle: React.CSSProperties = {
  width: 52,
  background: "var(--vd-bg)",
  color: "var(--vd-text)",
  border: "1px solid var(--vd-border)",
  borderRadius: RADIUS.sm,
  padding: "5px 6px",
  fontSize: FONT.body,
};

const removeButtonStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--vd-text-faint)",
  cursor: "pointer",
  fontSize: FONT.meta,
  padding: 4,
};

const addRowButtonStyle: React.CSSProperties = {
  marginTop: SPACE.sm,
  background: "transparent",
  border: "1px dashed var(--vd-border)",
  borderRadius: RADIUS.sm,
  color: "var(--vd-text-muted)",
  fontSize: FONT.meta,
  padding: "5px 10px",
  cursor: "pointer",
};

const errorStyle: React.CSSProperties = {
  color: "var(--vd-danger)",
  fontSize: FONT.meta,
  marginTop: SPACE.sm,
};
