/**
 * The mission canvas's right-hand panel (Phase 9b, requirements #4 and #6):
 * two tabs sharing one 320px column, the same width `RightDock.tsx` uses so
 * the swarm view's chrome doesn't feel narrower/wider than the rest of the
 * app for no reason.
 *
 * - "Agent" — appears once a canvas node is clicked: that agent's role,
 *   live status, current task, the file claims it holds, and its recent
 *   mailbox traffic. "Show terminal" reuses the Board's own
 *   click-a-session-indicator path (`onFocusSession` -> App.tsx's
 *   `focusSessionInGrid`), not a new one.
 * - "Claims & conflicts" — the honest half of the ownership design
 *   (docs/SWARM-MECHANISM.md §2-3): every claim currently held, grouped by
 *   agent, and every detected conflict (path, holder, when). Always
 *   reachable, not buried behind clicking a node, per this phase's own
 *   instruction that conflicts "must not be buried".
 *
 * Selecting a NEW node switches to the Agent tab automatically (see the
 * `useEffect` below) — same "the thing you just clicked is the thing you
 * probably want to look at" reasoning as `RightDock.tsx` jumping to its
 * Memory tab when a graph node is opened.
 */
import { useEffect, useState } from "react";
import type { ClaimConflict, FileClaim, MissionAgent, MissionMessage, MissionTask } from "@vibedeck/shared";
import { Pill, StatusDot } from "../shell/ui.js";
import { agentStatusKind, roleColorVar, roleGlyph } from "./logic.js";

export const SIDE_PANEL_WIDTH = 320;

export interface SidePanelProps {
  agents: MissionAgent[];
  selectedAgent: MissionAgent | null;
  tasks: MissionTask[];
  claims: FileClaim[];
  conflicts: ClaimConflict[];
  messages: MissionMessage[];
  onClose: () => void;
  onShowTerminal: (sessionId: string) => void;
}

type PanelTab = "agent" | "claims";

function agentLabel(agents: MissionAgent[], agentId: string): string {
  return agents.find((a) => a.id === agentId)?.label ?? agentId;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return iso;
  }
}

export default function SidePanel({
  agents,
  selectedAgent,
  tasks,
  claims,
  conflicts,
  messages,
  onClose,
  onShowTerminal,
}: SidePanelProps) {
  const [activeTab, setActiveTab] = useState<PanelTab>("claims");

  useEffect(() => {
    if (selectedAgent) setActiveTab("agent");
    // Only the SELECTED agent's identity should re-trigger this — re-running
    // on every prop change (e.g. a 2s poll refreshing `claims`) would yank
    // the user back to the Agent tab while they're reading Claims & conflicts.
  }, [selectedAgent?.id]);

  const currentTask = selectedAgent
    ? // Prefer a task this agent is actively working, then in review, then
      // fall back to the most recently updated task assigned to them at all
      // (e.g. one that's now blocked and needs their attention).
      [...tasks]
        .filter((t) => t.assignedAgentId === selectedAgent.id)
        .sort((a, b) => {
          const rank = (t: MissionTask) => (t.status === "running" ? 0 : t.status === "in_review" ? 1 : 2);
          const rankDiff = rank(a) - rank(b);
          if (rankDiff !== 0) return rankDiff;
          return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
        })[0]
    : undefined;

  const agentClaims = selectedAgent ? claims.filter((c) => c.agentId === selectedAgent.id) : [];
  // A broadcast carries `toAgentId === null` — that is what "sent to
  // everyone" means in the schema. Matching only on `toAgentId === id` would
  // therefore hide every broadcast from every agent's mailbox: you send one,
  // the server stores it and types it into the agents' terminals, and the UI
  // shows it nowhere. Found by hand-testing. A broadcast IS addressed to this
  // agent, so it belongs here.
  const agentMessages = selectedAgent
    ? messages
        .filter(
          (m) =>
            m.fromAgentId === selectedAgent.id ||
            m.toAgentId === selectedAgent.id ||
            m.toAgentId === null
        )
        .slice(-8)
        .reverse()
    : [];

  const claimsByAgent = new Map<string, FileClaim[]>();
  for (const claim of claims) {
    const list = claimsByAgent.get(claim.agentId) ?? [];
    list.push(claim);
    claimsByAgent.set(claim.agentId, list);
  }

  return (
    <div style={panelStyle}>
      <div style={tabRowStyle}>
        <TabButton label="Claims & conflicts" active={activeTab === "claims"} onClick={() => setActiveTab("claims")} />
        {selectedAgent && (
          <TabButton label={selectedAgent.label} active={activeTab === "agent"} onClick={() => setActiveTab("agent")} />
        )}
        <div style={{ flex: 1 }} />
        {selectedAgent && activeTab === "agent" && (
          <button type="button" title="Deselect agent" onClick={onClose} className="vd-icon-btn" style={closeButtonStyle}>
            ✕
          </button>
        )}
      </div>

      <div style={bodyStyle}>
        {activeTab === "agent" && selectedAgent && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ color: roleColorVar(selectedAgent.role), fontSize: 13 }}>
                  {roleGlyph(selectedAgent.role)}
                </span>
                <strong style={{ fontSize: 13, color: "var(--vd-text)" }}>{selectedAgent.label}</strong>
              </div>
              <div style={{ marginTop: 6, display: "flex", gap: 6, alignItems: "center" }}>
                <Pill status="idle">{selectedAgent.role}</Pill>
                <span
                  style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--vd-text-muted)" }}
                >
                  <StatusDot status={agentStatusKind(selectedAgent.status)} />
                  {selectedAgent.status}
                </span>
              </div>
              <div style={{ marginTop: 4, fontSize: 11, color: "var(--vd-text-faint)" }}>
                Runs: <code>{selectedAgent.agent}</code>
              </div>
            </div>

            {selectedAgent.sessionId && (
              <button
                type="button"
                onClick={() => onShowTerminal(selectedAgent.sessionId!)}
                className="vd-btn-secondary"
                style={showTerminalButtonStyle}
              >
                Show terminal
              </button>
            )}

            <Section title="Current task">
              {currentTask ? (
                <div>
                  <div style={{ fontSize: 12, color: "var(--vd-text)" }}>{currentTask.title}</div>
                  <div style={{ marginTop: 4 }}>
                    <Pill status={currentTask.status === "blocked" ? "danger" : "info"}>{currentTask.status}</Pill>
                  </div>
                </div>
              ) : (
                <EmptyNote>No task currently assigned.</EmptyNote>
              )}
            </Section>

            <Section title={`File claims (${agentClaims.length})`}>
              {agentClaims.length === 0 ? (
                <EmptyNote>Holds no file claims right now.</EmptyNote>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {agentClaims.map((claim) => (
                    <code key={claim.id} style={pathChipStyle}>
                      {claim.path}
                    </code>
                  ))}
                </div>
              )}
            </Section>

            <Section title="Recent mailbox">
              {agentMessages.length === 0 ? (
                <EmptyNote>No messages yet.</EmptyNote>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {agentMessages.map((m) => (
                    <div key={m.id} style={messageRowStyle}>
                      <div style={{ fontSize: 10, color: "var(--vd-text-faint)" }}>
                        {m.fromAgentId === selectedAgent.id
                          ? "sent"
                          : m.toAgentId === null
                            ? "broadcast"
                            : "received"}{" "}
                        · {formatTime(m.createdAt)}
                      </div>
                      <div style={{ fontSize: 12, color: "var(--vd-text)" }}>{m.body}</div>
                    </div>
                  ))}
                </div>
              )}
            </Section>
          </div>
        )}

        {activeTab === "claims" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <Section title={`Conflicts (${conflicts.length})`}>
              {conflicts.length === 0 ? (
                <EmptyNote>None detected — every claimed path has stayed untouched by anyone else.</EmptyNote>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {conflicts.map((c) => (
                    <div key={c.id} style={conflictRowStyle}>
                      <code style={pathChipStyle}>{c.path}</code>
                      <div style={{ fontSize: 11, color: "var(--vd-text-muted)", marginTop: 2 }}>
                        held by {agentLabel(agents, c.holderAgentId)} · detected {formatTime(c.detectedAt)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Section>

            <Section title={`Claims held (${claims.length})`}>
              {claimsByAgent.size === 0 ? (
                <EmptyNote>No agent currently holds a file claim.</EmptyNote>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {[...claimsByAgent.entries()].map(([agentId, agentClaimList]) => (
                    <div key={agentId}>
                      <div style={{ fontSize: 11, color: "var(--vd-text-muted)", marginBottom: 4 }}>
                        {agentLabel(agents, agentId)}
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        {agentClaimList.map((claim) => (
                          <code key={claim.id} style={pathChipStyle}>
                            {claim.path}
                          </code>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Section>
          </div>
        )}
      </div>
    </div>
  );
}

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="vd-view-tab" style={tabButtonStyle(active)}>
      {label}
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={sectionTitleStyle}>{title}</div>
      {children}
    </div>
  );
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, color: "var(--vd-text-faint)" }}>{children}</div>;
}

const panelStyle: React.CSSProperties = {
  width: SIDE_PANEL_WIDTH,
  flexShrink: 0,
  display: "flex",
  flexDirection: "column",
  borderLeft: "1px solid var(--vd-border)",
  background: "var(--vd-surface)",
  overflowY: "auto",
};

const tabRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  padding: "8px 10px",
  borderBottom: "1px solid var(--vd-border)",
  flexShrink: 0,
};

function tabButtonStyle(active: boolean): React.CSSProperties {
  return {
    fontSize: 11,
    padding: "3px 8px",
    borderRadius: 4,
    border: "1px solid " + (active ? "var(--vd-accent)" : "transparent"),
    background: active ? "var(--vd-surface-raised)" : "transparent",
    color: active ? "var(--vd-text)" : "var(--vd-text-muted)",
    cursor: "pointer",
    whiteSpace: "nowrap",
  };
}

const closeButtonStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--vd-text-faint)",
  fontSize: 11,
  cursor: "pointer",
  padding: 2,
};

const bodyStyle: React.CSSProperties = {
  padding: 12,
  overflowY: "auto",
  flex: 1,
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 10,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--vd-text-faint)",
  marginBottom: 6,
};

const pathChipStyle: React.CSSProperties = {
  display: "block",
  fontSize: 11,
  color: "var(--vd-text)",
  background: "var(--vd-bg)",
  border: "1px solid var(--vd-border)",
  borderRadius: 4,
  padding: "3px 6px",
  overflowWrap: "anywhere",
};

const conflictRowStyle: React.CSSProperties = {
  padding: 6,
  border: "1px solid var(--vd-danger)",
  borderRadius: 4,
  background: "color-mix(in srgb, var(--vd-danger) 10%, transparent)",
};

const messageRowStyle: React.CSSProperties = {
  padding: "6px 8px",
  background: "var(--vd-bg)",
  border: "1px solid var(--vd-border)",
  borderRadius: 4,
};

const showTerminalButtonStyle: React.CSSProperties = {
  fontSize: 11,
  padding: "5px 10px",
  borderRadius: 4,
  background: "transparent",
  border: "1px solid var(--vd-border)",
  color: "var(--vd-text)",
  cursor: "pointer",
  alignSelf: "flex-start",
};
