/**
 * Phase 9b: the Swarm centre view (Terminals | Editor | Preview | Board |
 * Graph | Swarm, see App.tsx's `CenterView`). Owns all of this workspace's
 * mission data — fetching, polling, and every mutation (create, pause/
 * resume/stop, send a mailbox message) — and lays out the four pieces
 * described in docs/DESIGN.md §5 and this phase's spec: `MissionBar` on
 * top, `MissionCanvas` filling the centre with `CommandBar` floating over
 * it, and `SidePanel` on the right.
 *
 * State ownership follows Board.tsx/Graph.tsx's pattern (the other centre
 * views): this component fetches its own data given just a `workspaceId`,
 * there's no other consumer of "the current mission" to share it with.
 *
 * Two things this file has to get right, both hard-won lessons from
 * earlier phases (see this phase's own brief):
 *
 * 1. Centre views are never unmounted, only hidden with `display: none` —
 *    so a `visible` prop drives every fetch/poll effect below, and nothing
 *    here assumes "mounted" means "on screen" (Phase 8's Graph shipped
 *    without this once already).
 * 2. Polling must STOP the moment the view is hidden or the mission isn't
 *    `running` — a `setInterval` ticking behind a hidden tab, or against a
 *    paused/stopped/complete mission that can't change, is a pure battery/
 *    CPU leak with nothing to show for it.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentId, Mission, MissionAgent, MissionDetail, MissionRole } from "@vibespace/shared";
import type { AgentOption } from "../grid/PaneView.js";
import MissionBar from "./MissionBar.js";
import MissionCanvas from "./MissionCanvas.js";
import SidePanel from "./SidePanel.js";
import CommandBar from "./CommandBar.js";
import CreateMissionForm from "./CreateMissionForm.js";
import { computeProgress } from "./logic.js";
import { EmptyState } from "../shell/ui.js";

export interface SwarmProps {
  workspaceId: string | null;
  agents: AgentOption[];
  visible: boolean;
  /** Reuses the Board's own "jump to this session's terminal" path — App.tsx
   * wires this straight to `focusSessionInGrid`, switching to the Terminals
   * view and focusing whichever pane that session is attached to. */
  onFocusSession: (sessionId: string) => void;
}

/** How often to poll `GET /api/swarm/missions/:id` while the mission is
 * actually running and this view is visible — 2.5s sits inside the spec's
 * 2-3s window. */
const POLL_INTERVAL_MS = 2500;

type LoadState = "loading" | "loaded" | "error";

async function parseErrorBody(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `Server responded with ${res.status}`;
}

export default function Swarm({ workspaceId, agents, visible, onFocusSession }: SwarmProps) {
  const [missions, setMissions] = useState<Mission[]>([]);
  const [missionsLoadState, setMissionsLoadState] = useState<LoadState>("loading");
  const [detail, setDetail] = useState<MissionDetail | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [pendingStop, setPendingStop] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // The most recently created mission for this workspace is "the" mission
  // the view shows — the API supports many missions per workspace, but this
  // UI (like the spec's own "if no mission exists yet" framing) treats the
  // workspace as having one mission in focus at a time.
  const missionId = useMemo(() => {
    if (missions.length === 0) return null;
    return [...missions].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0].id;
  }, [missions]);

  // --- Load the mission list whenever the workspace changes or we become
  // visible (trap #1 — this view mounts once, usually with zero missions;
  // switching TO it later has to re-ask the server). -----------------------
  useEffect(() => {
    if (!visible) return;
    if (!workspaceId) {
      setMissions([]);
      setMissionsLoadState("loaded");
      return;
    }
    let cancelled = false;
    setMissionsLoadState("loading");
    fetch(`/api/swarm/missions?workspaceId=${encodeURIComponent(workspaceId)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(await parseErrorBody(res));
        return (await res.json()) as { missions: Mission[] };
      })
      .then((body) => {
        if (cancelled) return;
        setMissions(body.missions);
        setMissionsLoadState("loaded");
      })
      .catch(() => {
        if (cancelled) return;
        setMissionsLoadState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, visible]);

  const loadDetail = useCallback((id: string) => {
    return fetch(`/api/swarm/missions/${encodeURIComponent(id)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(await parseErrorBody(res));
        return (await res.json()) as MissionDetail;
      })
      .then((body) => {
        setDetail(body);
        return body;
      });
  }, []);

  // --- Load this mission's full detail whenever it changes, or we become
  // visible. Same trap-#1 reasoning as the mission-list effect above. ------
  useEffect(() => {
    if (!visible || !missionId) {
      setDetail(null);
      return;
    }
    loadDetail(missionId).catch(() => {
      /* surfaced via the render below staying on whatever detail we last had */
    });
  }, [missionId, visible, loadDetail]);

  // --- Poll ONLY while visible AND the mission is actually running. This is
  // the CPU/battery-leak guard called out in this phase's brief: a poll loop
  // must not keep running behind a hidden view, or against a mission that
  // can't change (paused/stopped/complete) — there's nothing new to fetch. --
  useEffect(() => {
    if (!visible || !missionId || detail?.mission.status !== "running") return;
    const interval = setInterval(() => {
      loadDetail(missionId).catch(() => {
        /* a transient failure just means we try again next tick */
      });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [visible, missionId, detail?.mission.status, loadDetail]);

  // --- Elapsed-time clock: only ticks while a mission is actually running,
  // and only while this view is visible — same "don't run timers behind a
  // hidden view" discipline as the poll effect above. ----------------------
  useEffect(() => {
    if (!visible || detail?.mission.status !== "running") return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [visible, detail?.mission.status]);

  // Deselect an agent that's no longer in the mission (shouldn't normally
  // happen — agents aren't removed once spawned — but guards against a
  // dangling selection if a mission ever gets replaced under the view).
  useEffect(() => {
    if (selectedAgentId && detail && !detail.agents.some((a) => a.id === selectedAgentId)) {
      setSelectedAgentId(null);
    }
  }, [selectedAgentId, detail]);

  const handleCreate = useCallback(
    (prompt: string, rows: { role: MissionRole; agent: AgentId; count: number }[]) => {
      if (!workspaceId) return;
      setCreating(true);
      setCreateError(null);
      fetch("/api/swarm/missions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, prompt, agents: rows }),
      })
        .then(async (res) => {
          if (!res.ok) throw new Error(await parseErrorBody(res));
          return (await res.json()) as MissionDetail;
        })
        .then((body) => {
          setMissions((prev) => [...prev, body.mission]);
          setDetail(body);
        })
        .catch((err: unknown) => {
          setCreateError(err instanceof Error ? err.message : "Failed to launch the mission");
        })
        .finally(() => setCreating(false));
    },
    [workspaceId]
  );

  const patchStatus = useCallback(
    (status: Mission["status"]) => {
      if (!missionId) return;
      setActionError(null);
      fetch(`/api/swarm/missions/${encodeURIComponent(missionId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      })
        .then(async (res) => {
          if (!res.ok) throw new Error(await parseErrorBody(res));
          // The PATCH response is just the bare `Mission`, not a full
          // `MissionDetail` (see routes.ts) — refetch the composed detail
          // so claims/conflicts reflect a stop's side effects too.
          return loadDetail(missionId);
        })
        .catch((err: unknown) => {
          setActionError(err instanceof Error ? err.message : "Failed to update the mission");
        });
    },
    [missionId, loadDetail]
  );

  const handleTogglePause = useCallback(() => {
    if (!detail) return;
    patchStatus(detail.mission.status === "running" ? "paused" : "running");
  }, [detail, patchStatus]);

  const handleConfirmStop = useCallback(() => {
    setPendingStop(false);
    patchStatus("stopped");
  }, [patchStatus]);

  const handleSend = useCallback(
    (body: string, toAgentId: string | null) => {
      if (!missionId) return;
      setActionError(null);
      fetch(`/api/swarm/missions/${encodeURIComponent(missionId)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toAgentId: toAgentId ?? undefined, body }),
      })
        .then(async (res) => {
          if (!res.ok) throw new Error(await parseErrorBody(res));
          return res.json();
        })
        .then((message) => {
          setDetail((prev) => (prev ? { ...prev, messages: [...prev.messages, message] } : prev));
        })
        .catch((err: unknown) => {
          setActionError(err instanceof Error ? err.message : "Failed to send the message");
        });
    },
    [missionId]
  );

  const selectedAgent: MissionAgent | null = useMemo(
    () => (detail && selectedAgentId ? (detail.agents.find((a) => a.id === selectedAgentId) ?? null) : null),
    [detail, selectedAgentId]
  );

  const progress = useMemo(() => computeProgress(detail?.tasks ?? []), [detail?.tasks]);

  if (!workspaceId) {
    return (
      <div style={emptyStateStyle}>
        <EmptyState title="No workspace open" description="Open a workspace to launch or view its swarm missions." />
      </div>
    );
  }
  if (missionsLoadState === "loading" && missions.length === 0) {
    return (
      <div style={emptyStateStyle}>
        <EmptyState title="Loading missions…" />
      </div>
    );
  }
  if (missionsLoadState === "error") {
    return (
      <div style={emptyStateStyle}>
        <EmptyState
          title="Couldn't load missions"
          description="Failed to load missions for this workspace."
        />
      </div>
    );
  }
  if (!missionId || !detail) {
    return <CreateMissionForm agents={agents} submitting={creating} error={createError} onSubmit={handleCreate} />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <MissionBar
        mission={detail.mission}
        progress={progress}
        conflictCount={detail.conflicts.length}
        nowMs={now}
        pendingStop={pendingStop}
        onTogglePause={handleTogglePause}
        onRequestStop={() => setPendingStop(true)}
        onConfirmStop={handleConfirmStop}
        onCancelStop={() => setPendingStop(false)}
      />

      {actionError && <div style={actionErrorStyle}>{actionError}</div>}

      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
          <MissionCanvas agents={detail.agents} selectedAgentId={selectedAgentId} onSelectAgent={setSelectedAgentId} />
          <CommandBar agents={detail.agents} disabled={detail.mission.status !== "running"} onSend={handleSend} />
        </div>

        <SidePanel
          agents={detail.agents}
          selectedAgent={selectedAgent}
          tasks={detail.tasks}
          claims={detail.claims}
          conflicts={detail.conflicts}
          messages={detail.messages}
          onClose={() => setSelectedAgentId(null)}
          onShowTerminal={onFocusSession}
        />
      </div>
    </div>
  );
}

const emptyStateStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: "100%",
  color: "var(--vd-text-muted)",
  fontSize: 12,
  background: "var(--vd-bg)",
};

const actionErrorStyle: React.CSSProperties = {
  padding: "4px 12px",
  fontSize: 11,
  color: "var(--vd-danger)",
  background: "color-mix(in srgb, var(--vd-danger) 10%, var(--vd-bg))",
  borderBottom: "1px solid var(--vd-border)",
  flexShrink: 0,
};
