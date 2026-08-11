import type { SessionInfo, Workspace } from "@vibedeck/shared";
import type { AgentOption } from "../grid/PaneView.js";
import { ListRow, Pill } from "./ui.js";

export const DOCK_WIDTH = 320;

interface RightDockProps {
  activeWorkspace: Workspace | null;
  agents: AgentOption[];
  /** Every session belonging to the active workspace (already filtered by
   * the caller — see App.tsx's `sessionsForWorkspace`), not the whole
   * server-wide session list. */
  workspaceSessions: SessionInfo[];
}

/**
 * The right dock: a tabbed shell per docs/DESIGN.md §1, shipped with a
 * single "Info" tab because Board/Memory/Skills (Phases 7/8/10) don't exist
 * yet. Collapsed/hidden by default (see App.tsx's `dockCollapsed` state) —
 * this component only renders the panel's CONTENTS; App.tsx decides whether
 * to mount it at all.
 *
 * "Info" is real information, not a placeholder: the active workspace's
 * directory, which agents are actually installed and available, and how
 * many sessions (running vs. total) belong to this workspace right now.
 */
export default function RightDock({ activeWorkspace, agents, workspaceSessions }: RightDockProps) {
  const runningCount = workspaceSessions.filter((s) => s.status === "running").length;

  return (
    <div
      style={{
        width: DOCK_WIDTH,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        borderLeft: "1px solid var(--vd-border)",
        background: "var(--vd-surface)",
        overflowY: "auto",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "8px 12px",
          borderBottom: "1px solid var(--vd-border)",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: "var(--vd-text)",
            borderBottom: "2px solid var(--vd-accent)",
            paddingBottom: 6,
            marginBottom: -9,
          }}
        >
          Info
        </span>
      </div>

      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 16 }}>
        <Section title="Directory">
          {activeWorkspace ? (
            <code
              style={{
                fontSize: 12,
                color: "var(--vd-text)",
                wordBreak: "break-all",
                display: "block",
                lineHeight: 1.5,
              }}
            >
              {activeWorkspace.rootPath}
            </code>
          ) : (
            <p style={{ fontSize: 12, color: "var(--vd-text-faint)", margin: 0 }}>No active workspace.</p>
          )}
        </Section>

        <Section title="Sessions">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Pill status={runningCount > 0 ? "ok" : "idle"}>
              {runningCount} running
            </Pill>
            <span style={{ fontSize: 11, color: "var(--vd-text-faint)" }}>
              {workspaceSessions.length} total in this workspace
            </span>
          </div>
        </Section>

        <Section title="Agents">
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {agents.length === 0 && (
              <p style={{ fontSize: 12, color: "var(--vd-text-faint)", margin: 0 }}>Loading…</p>
            )}
            {agents.map((agent) => (
              <ListRow
                key={agent.id}
                statusKind={agent.available ? "ok" : "idle"}
                label={agent.displayName}
                trailing={
                  !agent.available && (
                    <span style={{ fontSize: 10, color: "var(--vd-text-faint)" }}>not installed</span>
                  )
                }
              />
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--vd-text-faint)",
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}
