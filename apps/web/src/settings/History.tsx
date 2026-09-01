/**
 * The History section (BridgeSpace v3.2.2 + v3.4.13 parity): the one place
 * to see every RECOVERABLE session — one that isn't currently running (its
 * pty exited, or the server restarted since it was spawned) but could be —
 * and act on it: Resume (spawns a fresh session using whatever "resume"
 * actually means for that agent, see `apps/server/src/pty/resume.ts`) or
 * Discard (dismiss it for good). Lives inside Settings.tsx, per this
 * feature's own instruction ("Settings is where BridgeSpace put it and we
 * now have a Settings view").
 *
 * Deliberately does NOT try to reattach a resumed session into any
 * particular pane — unlike a deferred pane's own inline Restore button
 * (PaneView.tsx), a record here may belong to a workspace that isn't even
 * the active one, or have no pane of origin at all (a board/swarm-
 * dispatched session). `onSessionResumed` hands the fresh `SessionInfo`
 * back to App.tsx, which folds it into the CURRENT workspace's grid using
 * the exact same "attach to an empty pane, or split the focused one" logic
 * `handleSessionDispatched` already uses for the board's own "Dispatch"
 * action — resuming from History behaves like dispatching a task, not like
 * a pane-local restore.
 */
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import type { ResumeSessionResponse, SessionInfo, SessionRecord, Workspace } from "@vibespace/shared";
import { AgentGlyph } from "../grid/agentVisuals.js";
import { Button, EmptyState, Pill, StatusDot } from "../shell/ui.js";
import { FONT, RADIUS, SPACE } from "../shell/tokens.js";

export interface HistorySectionProps {
  /** For resolving a record's `workspaceId` to a human-readable name. */
  workspaces: Workspace[];
  /** Fired with the fresh session once a Resume succeeds — see this file's
   * top comment for why App.tsx folds it in the same way a board dispatch
   * would, rather than this component trying to guess a pane. */
  onSessionResumed: (session: SessionInfo) => void;
}

type LoadState = "loading" | "loaded" | "error";

async function parseErrorBody(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; installHint?: string | null };
  return body.installHint ? `${body.error} (${body.installHint})` : (body.error ?? `Server responded with ${res.status}`);
}

/** Short, human-facing label for why a record ended up recoverable — see
 * `SessionRecordEndedReason` in packages/shared/src/protocol.ts. */
function endedReasonLabel(reason: SessionRecord["endedReason"]): string {
  switch (reason) {
    case "server_restart":
      return "Server restarted";
    case "resume_failed":
      return "Resume failed";
    case "exited":
      return "Exited";
    default:
      return "Ended";
  }
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export default function HistorySection({ workspaces, onSessionResumed }: HistorySectionProps) {
  const [records, setRecords] = useState<SessionRecord[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoadState("loading");
    setLoadError(null);
    fetch("/api/session-records")
      .then(async (res) => {
        if (!res.ok) throw new Error(await parseErrorBody(res));
        return (await res.json()) as { records: SessionRecord[] };
      })
      .then((body) => {
        setRecords(body.records);
        setLoadState("loaded");
      })
      .catch((err: unknown) => {
        setLoadError(err instanceof Error ? err.message : "Failed to load session history");
        setLoadState("error");
      });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const resume = useCallback(
    async (record: SessionRecord) => {
      setActionError(null);
      setPendingId(record.id);
      try {
        const res = await fetch(`/api/session-records/${record.id}/resume`, { method: "POST" });
        if (!res.ok) throw new Error(await parseErrorBody(res));
        const body = (await res.json()) as ResumeSessionResponse;
        onSessionResumed(body.session);
        reload();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Failed to resume session");
      } finally {
        setPendingId(null);
      }
    },
    [onSessionResumed, reload]
  );

  const discard = useCallback(
    async (record: SessionRecord) => {
      setActionError(null);
      setPendingId(record.id);
      try {
        const res = await fetch(`/api/session-records/${record.id}/discard`, { method: "POST" });
        if (!res.ok) throw new Error(await parseErrorBody(res));
        reload();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Failed to discard session");
      } finally {
        setPendingId(null);
      }
    },
    [reload]
  );

  const recoverable = records.filter((r) => r.status === "recoverable");
  const workspaceName = (id: string | null) => (id ? (workspaces.find((w) => w.id === id)?.name ?? "Unknown workspace") : "No workspace");

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: SPACE.sm }}>
        <p style={{ ...sectionHintStyle, margin: 0 }}>
          Sessions whose pane closed, exited, or was orphaned by a server restart — resumable instead of
          lost for good.
        </p>
        <Button variant="secondary" onClick={reload} disabled={loadState === "loading"}>
          Refresh
        </Button>
      </div>

      {actionError && <p style={{ color: "var(--vd-danger)", fontSize: FONT.meta, margin: `0 0 ${SPACE.sm}px` }}>{actionError}</p>}

      {loadState === "loading" && records.length === 0 ? (
        <p style={{ color: "var(--vd-text-muted)", fontSize: FONT.body }}>Loading…</p>
      ) : loadState === "error" ? (
        <p style={{ color: "var(--vd-danger)", fontSize: FONT.body }}>{loadError}</p>
      ) : recoverable.length === 0 ? (
        <EmptyState title="Nothing to recover" description="Every session is either running, or was already discarded." maxWidth={420} />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: SPACE.xs }}>
          {recoverable.map((record) => (
            <div key={record.id} style={rowStyle}>
              <span
                aria-hidden
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 26,
                  height: 26,
                  borderRadius: "50%",
                  flexShrink: 0,
                  background: "var(--vd-surface)",
                }}
              >
                <AgentGlyph id={record.agent} size={14} color="var(--vd-text-faint)" />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: SPACE.xs, flexWrap: "wrap" }}>
                  <StatusDot status="idle" />
                  <span style={{ fontSize: FONT.body, color: "var(--vd-text)", fontWeight: 500 }}>{record.title}</span>
                  <Pill status="idle">{endedReasonLabel(record.endedReason)}</Pill>
                </div>
                <div
                  style={{
                    fontSize: FONT.meta,
                    color: "var(--vd-text-faint)",
                    marginTop: 2,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={record.cwd}
                >
                  {workspaceName(record.workspaceId)} · {record.cwd}
                  {record.endedAt ? ` · ${timeAgo(record.endedAt)}` : ""}
                </div>
              </div>
              <Button
                variant="primary"
                disabled={pendingId === record.id}
                onClick={() => void resume(record)}
              >
                {pendingId === record.id ? "Resuming…" : "Resume"}
              </Button>
              <Button
                variant="secondary"
                disabled={pendingId === record.id}
                onClick={() => void discard(record)}
              >
                Discard
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: SPACE.sm,
  padding: SPACE.sm,
  background: "var(--vd-surface-raised)",
  border: "1px solid var(--vd-border)",
  borderRadius: RADIUS.sm,
};

const sectionHintStyle: CSSProperties = {
  fontSize: FONT.meta,
  color: "var(--vd-text-muted)",
  lineHeight: 1.5,
};
