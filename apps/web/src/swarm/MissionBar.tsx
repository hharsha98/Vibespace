/**
 * The Swarm view's top bar (Phase 9b requirement #2): mission prompt
 * (truncated, full text on hover), status pill, task progress, a ticking
 * elapsed-time clock, the conflict count (in `--danger` when non-zero, per
 * requirement #6 — conflicts must not be buried), and Pause/Resume/Stop.
 *
 * Stop does NOT use `window.confirm` (banned app-wide, docs/DESIGN.md §6
 * rule 5 — it breaks the aesthetic and freezes browser automation). Instead
 * clicking Stop swaps the action row for an inline warning banner — the
 * same pattern App.tsx already uses for "switching templates will close
 * running panes" and "delete this workspace" — naming exactly what stopping
 * does: kills every agent's terminal session AND releases every claim the
 * mission holds (see docs/SWARM.md's `PATCH .../missions/:id` section).
 */
import type { Mission } from "@vibedeck/shared";
import { Pill, StatusDot } from "../shell/ui.js";
import { formatElapsed, missionStatusKind, type MissionProgress } from "./logic.js";

export interface MissionBarProps {
  mission: Mission;
  progress: MissionProgress;
  conflictCount: number;
  /** Current time in ms, re-supplied by the parent's own ticking interval —
   * see `formatElapsed`'s doc comment for why this isn't read internally. */
  nowMs: number;
  pendingStop: boolean;
  onTogglePause: () => void;
  onRequestStop: () => void;
  onConfirmStop: () => void;
  onCancelStop: () => void;
}

export default function MissionBar({
  mission,
  progress,
  conflictCount,
  nowMs,
  pendingStop,
  onTogglePause,
  onRequestStop,
  onConfirmStop,
  onCancelStop,
}: MissionBarProps) {
  const canPauseOrResume = mission.status === "running" || mission.status === "paused";
  const canStop = mission.status === "running" || mission.status === "paused";

  return (
    <div style={wrapperStyle}>
      <div style={topRowStyle}>
        <span title={mission.prompt} style={promptStyle}>
          {mission.prompt}
        </span>

        <Pill status={missionStatusKind(mission.status)}>{mission.status}</Pill>

        <div style={progressWrapStyle} title={`${progress.completed} of ${progress.total} tasks complete`}>
          <div style={progressTrackStyle}>
            <div style={{ ...progressFillStyle, width: `${Math.round(progress.ratio * 100)}%` }} />
          </div>
          <span style={metaTextStyle}>
            {progress.completed}/{progress.total}
          </span>
        </div>

        <span style={metaTextStyle}>{mission.status === "running" ? formatElapsed(mission.createdAt, nowMs) : "—"}</span>

        <span
          style={{
            ...metaTextStyle,
            color: conflictCount > 0 ? "var(--vd-danger)" : "var(--vd-text-faint)",
            fontWeight: conflictCount > 0 ? 600 : 400,
          }}
          title="Detected file conflicts — see the Claims & conflicts panel"
        >
          <StatusDot status={conflictCount > 0 ? "danger" : "idle"} /> {conflictCount} conflict
          {conflictCount === 1 ? "" : "s"}
        </span>

        <div style={{ flex: 1 }} />

        {canPauseOrResume && (
          <button type="button" onClick={onTogglePause} style={secondaryActionStyle}>
            {mission.status === "running" ? "Pause" : "Resume"}
          </button>
        )}
        {canStop && !pendingStop && (
          <button type="button" onClick={onRequestStop} style={dangerActionStyle}>
            Stop
          </button>
        )}
      </div>

      {pendingStop && (
        <div style={warningBannerStyle}>
          <span>
            Stopping kills every agent's terminal session in this mission and releases every file claim it holds.
            This can't be undone. Continue?
          </span>
          <button type="button" onClick={onConfirmStop} style={dangerActionStyle}>
            Stop mission
          </button>
          <button type="button" onClick={onCancelStop} style={secondaryActionStyle}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

const wrapperStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  flexShrink: 0,
  borderBottom: "1px solid var(--vd-border)",
  background: "var(--vd-surface)",
};

const topRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "8px 12px",
  minHeight: 36,
};

const promptStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--vd-text)",
  maxWidth: 320,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  flexShrink: 1,
};

const progressWrapStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
};

const progressTrackStyle: React.CSSProperties = {
  width: 80,
  height: 4,
  borderRadius: 2,
  background: "var(--vd-border)",
  overflow: "hidden",
};

const progressFillStyle: React.CSSProperties = {
  height: "100%",
  background: "var(--vd-ok)",
  transition: "width 200ms ease",
};

const metaTextStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  fontSize: 11,
  color: "var(--vd-text-muted)",
  flexShrink: 0,
  whiteSpace: "nowrap",
};

const secondaryActionStyle: React.CSSProperties = {
  background: "transparent",
  color: "var(--vd-text-muted)",
  border: "1px solid var(--vd-border)",
  borderRadius: 4,
  padding: "4px 10px",
  fontSize: 11,
  cursor: "pointer",
};

const dangerActionStyle: React.CSSProperties = {
  background: "var(--vd-danger)",
  color: "var(--vd-bg)",
  border: "none",
  borderRadius: 4,
  padding: "4px 10px",
  fontSize: 11,
  cursor: "pointer",
  fontWeight: 600,
};

const warningBannerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "6px 12px",
  background: "color-mix(in srgb, var(--vd-danger) 15%, var(--vd-bg))",
  borderTop: "1px solid var(--vd-danger)",
  fontSize: 12,
  color: "var(--vd-text)",
  flexWrap: "wrap",
};
