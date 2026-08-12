import { useEffect, useState } from "react";
import type { SessionInfo, Workspace } from "@vibedeck/shared";
import type { AgentOption } from "../grid/PaneView.js";
import { formatBlockDuration, type CommandBlock } from "../term/blocks.js";
import { scrollSessionToLine, useSessionBlocks } from "../term/blockStore.js";
import MemoryPanel, { type OpenNoteRequest } from "../memory/MemoryPanel.js";
import { ListRow, Pill, type StatusKind } from "./ui.js";

export const DOCK_WIDTH = 320;

interface RightDockProps {
  activeWorkspace: Workspace | null;
  agents: AgentOption[];
  /** Every session belonging to the active workspace (already filtered by
   * the caller — see App.tsx's `sessionsForWorkspace`), not the whole
   * server-wide session list. */
  workspaceSessions: SessionInfo[];
  /** The session behind whichever pane currently has focus, or null if no
   * pane is focused / the focused pane is empty. Drives the "Blocks" tab —
   * it always shows THIS pane's command blocks, not some fixed pane. */
  focusedSession: SessionInfo | null;
  /** Bumped by App.tsx (from the Graph view, see Graph.tsx) to say "switch
   * to the Memory tab and show this note" — same pattern as Editor.tsx's
   * `openRequest`. Forwarded straight down to MemoryPanel; this component's
   * own job is just noticing it arrived and switching `activeTab` for it. */
  openNoteRequest: OpenNoteRequest | null;
  workspaceId: string | null;
}

/** Which of the right dock's tabs is showing. */
type DockTab = "info" | "blocks" | "memory";

/**
 * The right dock: a tabbed shell per docs/DESIGN.md §1. Ships with three
 * real tabs — "Info", "Blocks" (Phase 5), and "Memory" (Phase 8) — with
 * Board/Skills (Phases 7/10) still to come. Collapsed/hidden by default (see
 * App.tsx's `dockCollapsed` state) — this component only renders the
 * panel's CONTENTS; App.tsx decides whether to mount it at all.
 *
 * "Info" is real information, not a placeholder: the active workspace's
 * directory, which agents are actually installed and available, and how
 * many sessions (running vs. total) belong to this workspace right now.
 */
export default function RightDock({
  activeWorkspace,
  agents,
  workspaceSessions,
  focusedSession,
  openNoteRequest,
  workspaceId,
}: RightDockProps) {
  const [activeTab, setActiveTab] = useState<DockTab>("info");
  const runningCount = workspaceSessions.filter((s) => s.status === "running").length;

  // The Graph view asking to open a note (a bumped requestId, see
  // MemoryPanel's own top comment) always means "and show me the Memory
  // tab too" — the request would otherwise land on a tab nobody's looking
  // at.
  useEffect(() => {
    if (openNoteRequest) setActiveTab("memory");
  }, [openNoteRequest]);

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
        <DockTabButton label="Info" active={activeTab === "info"} onClick={() => setActiveTab("info")} />
        <DockTabButton
          label="Blocks"
          active={activeTab === "blocks"}
          onClick={() => setActiveTab("blocks")}
        />
        <DockTabButton
          label="Memory"
          active={activeTab === "memory"}
          onClick={() => setActiveTab("memory")}
        />
      </div>

      {activeTab === "info" && (
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
      )}
      {activeTab === "blocks" && (
        <div style={{ padding: 12 }}>
          <BlocksPanel session={focusedSession} />
        </div>
      )}
      {activeTab === "memory" && (
        <div style={{ padding: 12 }}>
          <MemoryPanel workspaceId={workspaceId} openNoteRequest={openNoteRequest} />
        </div>
      )}
    </div>
  );
}

/** One tab-header button, styled the same way the original single "Info"
 * label was (underline on the active tab) — just made clickable and
 * multiplied by two. */
function DockTabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: "transparent",
        border: "none",
        cursor: "pointer",
        fontSize: 11,
        fontWeight: 600,
        color: active ? "var(--vd-text)" : "var(--vd-text-faint)",
        borderBottom: `2px solid ${active ? "var(--vd-accent)" : "transparent"}`,
        paddingBottom: 6,
        marginBottom: -9,
      }}
    >
      {label}
    </button>
  );
}

/** Maps a block's state to the status-dot colour the Blocks tab shows —
 * the SAME mapping Terminal.tsx's gutter bars use (docs/DESIGN.md §2:
 * running = "working/attention" = warn, ok = ok, failed = danger), so a
 * block reads as the same colour whether you're looking at the gutter or
 * this list. */
function statusKindForBlock(state: CommandBlock["state"]): StatusKind {
  switch (state) {
    case "running":
      return "warn";
    case "ok":
      return "ok";
    case "failed":
      return "danger";
  }
}

/**
 * The "Blocks" tab's contents: the focused pane's command blocks, newest
 * first. Command blocks only ever exist for the "shell" agent (see
 * apps/server/src/pty/session-manager.ts — shell integration is
 * deliberately never applied to claude/cursor-agent/codex, which are
 * full-screen TUIs, not shells), so this is honest about that rather than
 * showing an empty list or a spinner for panes that will never have blocks.
 */
function BlocksPanel({ session }: { session: SessionInfo | null }) {
  const blocks = useSessionBlocks(session?.id ?? null);

  if (!session) {
    return <EmptyNote>No pane focused. Click a terminal pane to see its command blocks.</EmptyNote>;
  }

  if (session.agent !== "shell") {
    return (
      <EmptyNote>
        Command blocks need vibedeck's shell integration, which only runs in "shell" panes — not{" "}
        {session.title}.
      </EmptyNote>
    );
  }

  if (blocks.length === 0) {
    return <EmptyNote>No commands run yet in this pane.</EmptyNote>;
  }

  // Newest first, per the phase spec — BlockTracker.list() itself is
  // oldest-first (the order markers actually arrived in).
  const newestFirst = [...blocks].reverse();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {newestFirst.map((block) => (
        <ListRow
          key={block.id}
          statusKind={statusKindForBlock(block.state)}
          label={block.command ?? "(command not captured)"}
          title={block.command ?? undefined}
          onClick={() => scrollSessionToLine(session.id, block.startLine)}
          trailing={
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
              {block.state === "failed" && block.exitCode !== null && (
                <Pill status="danger">exit {block.exitCode}</Pill>
              )}
              {block.durationMs !== null && (
                <span style={{ fontSize: 10, color: "var(--vd-text-faint)" }}>
                  {formatBlockDuration(block.durationMs)}
                </span>
              )}
            </div>
          }
        />
      ))}
    </div>
  );
}

/** A single honest line of muted text — used everywhere the Blocks tab has
 * nothing (yet) to show. Deliberately not a spinner: none of these states
 * are "still loading," they're just "there is nothing here," which per
 * docs/DESIGN.md rule 5 (no fake loading states) should say so plainly. */
function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p style={{ fontSize: 12, color: "var(--vd-text-faint)", margin: 0, lineHeight: 1.5 }}>{children}</p>;
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
