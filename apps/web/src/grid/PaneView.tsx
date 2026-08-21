import { useEffect, useMemo, useState } from "react";
import type {
  AgentId,
  DeferredPane,
  ResumeSessionResponse,
  SessionInfo,
  SshProfile,
  Workspace,
} from "@vibedeck/shared";
import Terminal from "../term/Terminal.js";
import type { Theme } from "../themes/themes.js";
import type { Direction, PaneId } from "./tree.js";
import {
  Button,
  EMPTY_SURFACE_BACKGROUND,
  EmptyState,
  IconButton,
  KeyHint,
  Pill,
  StatusDot,
  sessionStatusKind,
  type StatusKind,
} from "../shell/ui.js";
import { FONT, MOTION, RADIUS, SHADOW_VAR, SPACE } from "../shell/tokens.js";
import { AgentGlyph, agentAccentVar } from "./agentVisuals.js";
import { canLaunchMultiple, splitByAvailability, toggleMultiLaunchSelection } from "./agentPicker.js";
import { useGitBranch } from "./useGitBranch.js";
import { KEYMAP, formatShortcut, isMacPlatform } from "../keys/keymap.js";
import { formatSshDestination } from "../ssh/logic.js";
import {
  SKILL_DRAG_MIME_TYPE,
  canPaneAcceptSkill,
  parseSkillDragPayload,
} from "../skills/dragDrop.js";
import { sendSkillToPane } from "../skills/sendToPane.js";

/**
 * The empty-pane picker's footer hint row (premium-pass round 2): three
 * pane-related shortcuts that are genuinely USABLE right from an empty
 * pane, shown with their real key combo (via `formatShortcut`, so this
 * never drifts out of sync with `keys/keymap.ts`'s own table) under a
 * short, hint-row-sized label — `KEYMAP`'s own `label` text
 * ("Split pane (side by side)") is written for the command palette, not a
 * 3-up footer row. Picking these three (not e.g. "close pane", which does
 * nothing useful on a pane that's already empty) is the actual judgement
 * call here: they're the shortcuts someone staring at an empty pane is
 * most likely to reach for next.
 */
const PANE_HINT_SHORTCUTS: readonly { id: string; label: string }[] = [
  { id: "split-row", label: "Split" },
  { id: "split-column", label: "Stack" },
  { id: "new-pane", label: "New pane" },
];

/**
 * Context-meter pill (BridgeSpace v3.4.17 parity): maps Codex's own
 * "% context left" reading to a `Pill` colour. Thresholds are purely a
 * visual-urgency judgement call (not anything Codex itself labels) — low
 * remaining context gets progressively louder, matching how every other
 * status colour in this app is used (docs/DESIGN.md §2/§6: colour means
 * status, never decoration). `idle` (neutral grey), not `ok` (green), for
 * the healthy majority of the range: a context meter sitting at 80% isn't
 * an achievement worth celebrating in green, just unremarkable.
 */
function contextLeftPillStatus(percentLeft: number): StatusKind {
  if (percentLeft <= 10) return "danger";
  if (percentLeft <= 25) return "warn";
  return "idle";
}

/** One entry from `GET /api/agents` — mirrors the shape App.tsx already fetches. */
export interface AgentOption {
  id: AgentId;
  displayName: string;
  available: boolean;
  /** How to install this agent's CLI if it's missing (`null` once installed,
   * or for agents — like the plain shell — that never need a separate
   * install). Server-sent by `GET /api/agents` (see
   * apps/server/src/index.ts) since before this phase, but the frontend
   * type never carried it — the empty-pane picker below is the first
   * caller that actually shows it, per the premium-pass instruction that an
   * unavailable agent should "ideally hint how to install it". Optional so
   * every pre-existing caller that builds an `AgentOption` without this
   * field (there are none in practice, since it always comes straight off
   * the fetch response, but the type itself shouldn't require it) keeps
   * compiling unchanged. */
  installHint?: string | null;
}

interface PaneViewProps {
  paneId: PaneId;
  /** The session this pane's leaf currently points at, or null if it's empty. */
  sessionId: string | null;
  /** Looked-up SessionInfo for `sessionId` (title/status), or null if empty/not found yet. */
  session: SessionInfo | null;
  /**
   * Session recovery, deferred cold-start restore (`apps/server/src/pty/
   * restore.ts`): set when this pane's PREVIOUS session is recoverable but
   * wasn't eagerly resumed (the server's bounded budget, or its circuit
   * breaker, chose not to) — always `null` for an ordinary empty pane.
   * When set (and `sessionId` is null), this pane shows a "restore this
   * pane" affordance instead of the normal agent picker, keeping its split
   * position/cwd/intended agent until a person explicitly decides.
   */
  deferred: DeferredPane | null;
  agents: AgentOption[];
  /**
   * SSH connection profiles (see `SshProfile`'s doc comment in
   * `packages/shared/src/protocol.ts`), rendered as their own group in the
   * empty-pane picker BELOW the local-agent grid — a separate, clearly
   * labelled section so opening a remote pane is never confused with
   * starting a local CLI (the whole point of "as a separate group... so
   * it's obvious you're going remote" from this feature's design brief).
   */
  sshProfiles: SshProfile[];
  /** Pre-highlighted choice in the empty-pane agent picker (the header <select>'s current value). */
  defaultAgent: AgentId | "";
  /** The active workspace's id, sent with `POST /api/sessions` so the new
   * pty spawns in that workspace's rootPath instead of the server's own
   * cwd. Null only in the (should-be-rare) case no workspace is active. */
  workspaceId: string | null;
  /** The active workspace itself (not just its id) — Phase 9.5c, PARITY
   * #13c/#41: this pane's header names the workspace (and, if the
   * workspace has a chosen colour, tints its chip with it) alongside the
   * agent. Null in the same rare case `workspaceId` is. */
  workspace: Workspace | null;
  /** The active theme, threaded down to this pane's `<Terminal>` so its
   * ANSI palette matches what the rest of the app is showing. */
  theme: Theme;
  isFocused: boolean;
  onFocus: () => void;
  /** Fired once `POST /api/sessions` succeeds for this (previously empty) pane. */
  onSessionStarted: (paneId: PaneId, session: SessionInfo) => void;
  /** Session recovery: fired once this pane's `deferred` record has been
   * explicitly discarded (the "Discard" action below) — App.tsx clears
   * `deferred` from the tree so the pane goes back to a plain empty state.
   * A successful RESTORE reuses `onSessionStarted` above instead — see
   * that prop's own note in Grid.tsx. */
  onDeferredDiscarded: (paneId: PaneId) => void;
  /**
   * "Launch more than one..." (BridgeSpace parity): fired once the user has
   * picked 2 agents in the empty-pane picker's multi-select mode and
   * confirmed. App.tsx's `handleLaunchMultiple` owns the actual split +
   * dual `POST /api/sessions` — see agentPicker.ts's `MAX_MULTI_LAUNCH`
   * comment for why this is capped at exactly 2, not arbitrary N.
   */
  onLaunchMultiple: (paneId: PaneId, agentIds: AgentId[]) => void;
  onSplit: (paneId: PaneId, direction: Direction) => void;
  /** Fired once this pane should be removed from the tree (session already killed, if it had one). */
  onClosePane: (paneId: PaneId) => void;
  /** Whether THIS pane is the one currently filling the whole grid — see
   * Grid.tsx's `maximizedPaneId`. Purely a rendering/icon-swap concern here;
   * Grid.tsx owns the actual "render only this pane, full size" decision. */
  isMaximized: boolean;
  /** Toggles maximize for this pane. Wired to both the title-bar icon and
   * (via App.tsx) the Cmd+Shift+Return shortcut / Escape key. */
  onToggleMaximize: (paneId: PaneId) => void;
}

/**
 * One cell of the grid. Either shows a small agent picker (empty pane) or a
 * live `<Terminal>` (pane with a session). Always mounted for as long as its
 * leaf exists in the tree — the grid never hides panes via unmounting, so a
 * pane's terminal keeps streaming output even while some other pane has
 * focus.
 *
 * Styling follows docs/DESIGN.md §5 "Pane": 6px radius, 1px border, and a
 * focused pane gets a 1px accent border and NOTHING else (no glow/thick
 * ring). The title-bar icon row (split/maximise/close) only shows on hover
 * or while focused — see the `.vd-pane`/`.vd-pane-icons` rules in
 * `shell/ui.tsx`'s `GlobalShellStyles`.
 */
export default function PaneView({
  paneId,
  sessionId,
  session,
  deferred,
  agents,
  sshProfiles,
  defaultAgent,
  workspaceId,
  workspace,
  theme,
  isFocused,
  onFocus,
  onSessionStarted,
  onDeferredDiscarded,
  onLaunchMultiple,
  onSplit,
  onClosePane,
  isMaximized,
  onToggleMaximize,
}: PaneViewProps) {
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  // Session recovery: separate in-flight/error state from the ordinary
  // picker's `starting`/`startError` above — a deferred pane's Restore
  // button and the empty-pane agent picker are mutually exclusive (never
  // rendered at the same time; see the render branch below), but keeping
  // them as distinct state avoids any accidental cross-talk if that ever
  // changes.
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  // BridgeSpace parity: "N more not installed" starts collapsed, and
  // "Launch more than one..." starts as a plain link, not a live
  // multi-select — both are opt-in so the common case (click one available
  // agent, it starts) looks exactly as simple as it did before this phase.
  const [showUnavailable, setShowUnavailable] = useState(false);
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const [selectedAgents, setSelectedAgents] = useState<AgentId[]>([]);
  // Phase 9.5c, PARITY #13b — polls independently per pane; see
  // useGitBranch.ts's top comment for why polling (not a filesystem watch)
  // and the resulting staleness window.
  const gitBranch = useGitBranch(workspaceId);
  // Context-meter pill (BridgeSpace v3.4.17 parity): fed by Terminal.tsx's
  // `onContextLeftChange`, which only ever fires for `agentId === "codex"`
  // panes (the one CLI vibedeck ships that genuinely prints this — see
  // contextMeter.ts's top comment). Stays `null` — and the pill below
  // simply doesn't render — for every other agent, an empty pane, or a
  // codex session that hasn't reached its composer footer yet.
  const [contextLeft, setContextLeft] = useState<number | null>(null);

  // Skill drag-and-drop (PARITY #37). `skillDropActive` drives the drop
  // highlight and is only ever set for a pane that can genuinely receive a
  // skill — see `canPaneAcceptSkill`, which refuses empty panes, exited
  // sessions AND shell panes, matching the server's own 400 rather than a
  // looser guess of its own. Highlighting a pane the server would reject
  // would be a lie the user only discovers after dropping.
  const [skillDropActive, setSkillDropActive] = useState(false);
  const [skillDropNotice, setSkillDropNotice] = useState<string | null>(null);
  const canAcceptSkill = canPaneAcceptSkill(session);

  /** Whether the drag currently over this pane is carrying one of OUR
   * skills. During `dragover` the browser deliberately withholds
   * `getData()` — the payload is only readable on drop — so `types` is the
   * only thing available to decide droppability. Which is exactly why the
   * payload uses a private MIME type rather than `text/plain`: arbitrary
   * text dragged in from another application can never be mistaken for a
   * skill. */
  const dragCarriesSkill = (dataTransfer: DataTransfer): boolean =>
    Array.from(dataTransfer.types).includes(SKILL_DRAG_MIME_TYPE);

  const handleSkillDrop = async (raw: string | null): Promise<void> => {
    setSkillDropActive(false);
    const payload = parseSkillDragPayload(raw);
    if (!payload || !session || !workspaceId) return;
    try {
      const result = await sendSkillToPane(payload.name, session.id, workspaceId);
      // "Sent" is the strongest honest word available: this typed the
      // skill's body into the pty. Whether the agent then ACTS on it is
      // the agent's business, and something we genuinely cannot observe —
      // see docs/SKILLS.md and PARITY #37's second caveat.
      setSkillDropNotice(
        result.truncated ? `Sent "${payload.name}" (truncated to fit)` : `Sent "${payload.name}"`
      );
    } catch (err) {
      setSkillDropNotice(err instanceof Error ? err.message : "Could not send that skill.");
    }
    window.setTimeout(() => setSkillDropNotice(null), 4000);
  };
  // Terminal.tsx resets this to null on every one of ITS OWN mounts (a new
  // session starting), but when a session ENDS and this pane goes back to
  // empty/deferred, `<Terminal>` unmounts without ever calling
  // `onContextLeftChange` again — nothing would otherwise clear a stale
  // reading left over from the session that just closed. This effect is
  // that missing reset: whenever this pane has no live session, its pill
  // state goes back to "nothing to show" too.
  useEffect(() => {
    if (!sessionId) setContextLeft(null);
  }, [sessionId]);
  // Same "read navigator lazily, memoize once" pattern App.tsx's own isMac
  // already uses — the empty-pane footer's KeyHints need this to render
  // ⌘ vs Ctrl+.
  const isMac = useMemo(() => isMacPlatform(), []);

  const startSession = async (agent: AgentId) => {
    setStartError(null);
    setStarting(true);
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // `paneId` (session recovery): lets the server's durable
        // SessionRecord remember which pane this session belongs to, so a
        // later resume (or a deferred cold-start restore) can land back in
        // the SAME pane instead of "any empty one" — see
        // apps/server/src/db/migrations.ts's migration 8.
        body: JSON.stringify({ ...(workspaceId ? { agent, workspaceId } : { agent }), paneId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Server responded with ${res.status}`);
      }
      const info = (await res.json()) as SessionInfo;
      onSessionStarted(paneId, info);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setStarting(false);
    }
  };

  /** The SSH-profile counterpart to `startSession` above — same request/
   * response shape (`POST /api/sessions` -> `SessionInfo`, folded into
   * this same pane via `onSessionStarted`), just `sshProfileId` instead of
   * `agent` in the body (see `apps/server/src/index.ts`'s POST /api/sessions
   * handler for how the two are told apart server-side). Honest failures —
   * `ssh` not installed (a 409 with an install hint, same shape as a
   * missing local agent binary), an unknown profile — surface through the
   * SAME `startError` state a local agent's failed start already uses;
   * failures that can only be discovered by actually connecting (host
   * unreachable, auth rejected) show up as the pane's own pty output once
   * the session starts, not here — see index.ts's own comment on that. */
  const startSshSession = async (profileId: string) => {
    setStartError(null);
    setStarting(true);
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(workspaceId ? { sshProfileId: profileId, workspaceId } : { sshProfileId: profileId }),
          paneId,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Server responded with ${res.status}`);
      }
      const info = (await res.json()) as SessionInfo;
      onSessionStarted(paneId, info);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setStarting(false);
    }
  };

  /**
   * Session recovery: resumes THIS pane's deferred record — `POST
   * /api/session-records/:id/resume` decides, server-side, what "resume"
   * actually means for that record's agent (Claude's `--resume <uuid>`,
   * codex's `resume --last`, cursor-agent's `--continue`, or a plain fresh
   * session for anything without a resume concept — see
   * `apps/server/src/pty/resume.ts`). On success this reuses
   * `onSessionStarted`, the exact same "a session now fills this pane"
   * event the ordinary picker fires — `attachSession` (grid/tree.ts) also
   * clears `deferred` itself, so there's nothing extra to do here for that
   * case. On FAILURE the server has already left the record exactly as
   * 'recoverable' as it was (see `attemptResume`'s own doc comment) — this
   * pane simply shows why and keeps the Restore button available to try
   * again.
   */
  const restoreDeferredSession = async () => {
    if (!deferred) return;
    setRestoreError(null);
    setRestoring(true);
    try {
      const res = await fetch(`/api/session-records/${deferred.recordId}/resume`, { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Server responded with ${res.status}`);
      }
      const body = (await res.json()) as ResumeSessionResponse;
      onSessionStarted(paneId, body.session);
    } catch (err) {
      setRestoreError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setRestoring(false);
    }
  };

  /** Explicitly dismisses this pane's deferred record — `POST
   * /api/session-records/:id/discard` marks it 'discarded' server-side (it
   * will never be offered for resume again, here or in History), and
   * `onDeferredDiscarded` clears the pane's `deferred` marker so it falls
   * back to the ordinary empty-pane picker. */
  const discardDeferredSession = async () => {
    if (!deferred) return;
    setRestoreError(null);
    setRestoring(true);
    try {
      const res = await fetch(`/api/session-records/${deferred.recordId}/discard`, { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Server responded with ${res.status}`);
      }
      onDeferredDiscarded(paneId);
    } catch (err) {
      setRestoreError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setRestoring(false);
    }
  };

  /** A single agent row was clicked. Ordinary mode starts it immediately
   * (unchanged behaviour); multi-select mode toggles it into/out of the
   * pending selection instead — see agentPicker.ts's
   * `toggleMultiLaunchSelection` for the actual add/remove/cap logic. */
  const handleAgentClick = (agent: AgentId) => {
    if (multiSelectMode) {
      setSelectedAgents((prev) => toggleMultiLaunchSelection(prev, agent));
      return;
    }
    void startSession(agent);
  };

  const cancelMultiSelect = () => {
    setMultiSelectMode(false);
    setSelectedAgents([]);
  };

  const confirmMultiLaunch = () => {
    if (!canLaunchMultiple(selectedAgents)) return;
    onLaunchMultiple(paneId, selectedAgents);
    setMultiSelectMode(false);
    setSelectedAgents([]);
  };

  // Used by the header's "close" button. Terminal's own right-click "Close"
  // menu item already DELETEs the session itself before calling its onClose
  // prop, so this DELETE-then-remove pair only needs to run here, when the
  // *header* button (not Terminal's own menu) triggered the close.
  const closeFromHeader = () => {
    if (sessionId) {
      fetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch((err: unknown) => {
        console.warn("vibedeck: failed to close session", err);
      });
    }
    onClosePane(paneId);
  };

  const statusKind = sessionStatusKind(session ? session.status : "empty");

  return (
    <div
      // Clicking anywhere in the pane (including inside the terminal, since
      // this event bubbles up before Terminal handles its own clicks)
      // focuses it — that's what drives the accent border below.
      onMouseDown={onFocus}
      // Only panes that can actually take a skill react to the drag at
      // all. Without `preventDefault()` on dragover the browser refuses
      // the drop outright, so a pane that never calls it — an empty pane,
      // a dead session, a shell — is silently and correctly not a drop
      // target, with no highlight and no misleading "you can drop here".
      onDragOver={(e) => {
        if (!canAcceptSkill || !dragCarriesSkill(e.dataTransfer)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        if (!skillDropActive) setSkillDropActive(true);
      }}
      onDragLeave={(e) => {
        // Fires when crossing into a CHILD element too, which would flicker
        // the highlight the whole way across the pane. Ignore those: only a
        // move genuinely outside this pane's subtree counts as leaving.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setSkillDropActive(false);
      }}
      onDrop={(e) => {
        if (!canAcceptSkill || !dragCarriesSkill(e.dataTransfer)) return;
        e.preventDefault();
        void handleSkillDrop(e.dataTransfer.getData(SKILL_DRAG_MIME_TYPE));
      }}
      className={`vd-pane${isFocused ? " is-focused" : ""}`}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        boxSizing: "border-box",
        borderRadius: RADIUS.md,
        overflow: "hidden",
        border: `1px solid ${isFocused ? "var(--vd-accent)" : "var(--vd-border)"}`,
        // Premium-pass (problem #2): every pane now sits on a faint shadow,
        // lifting it off the black canvas — deliberately NOT tied to focus
        // (docs/DESIGN.md §5 is explicit that the focus border is the ONLY
        // focus affordance, no glow), so this is elevation for its own
        // sake, present on every pane equally. SHADOW_VAR (not the raw
        // SHADOW constant) so it re-tunes for light themes.
        // An INSET ring for "you can drop a skill here", deliberately not
        // the border. The first attempt tinted the border accent, which
        // was invisible on the focused pane — that pane's border is
        // already accent — and the focused pane is the very one you are
        // most likely to drop onto. docs/DESIGN.md §5 reserves the border
        // as the single FOCUS affordance; this is a different question
        // ("would this pane take the thing in your hand?"), it is
        // transient, and it has to stay legible on top of focus rather
        // than competing with it.
        boxShadow: skillDropActive
          ? `inset 0 0 0 2px var(--vd-accent), ${SHADOW_VAR.sm}`
          : SHADOW_VAR.sm,
        background: "var(--vd-bg)",
        // Motion pass: the focus border swap (the ONLY focus affordance —
        // still no glow, just this colour change) now animates instead of
        // snapping, so moving focus between panes reads as a deliberate
        // handoff rather than a flicker.
        transition: `border-color ${MOTION.fast} ${MOTION.easing}`,
      }}
    >
      <div
        // Terminal-chrome pass: the header dims (opacity only — no glow,
        // no second accent) when this pane isn't focused, the same
        // treatment Terminal.tsx applies to the Live/Blocks toggle and
        // PromptBar below it, so the pane's ENTIRE chrome — not just the
        // 1px outer border — recedes together. The border swap above
        // remains the one focus AFFORDANCE per docs/DESIGN.md §5; this is a
        // secondary reinforcement of the same fact, not a competing cue.
        style={{
          display: "flex",
          alignItems: "center",
          gap: SPACE.xs + 2,
          height: 30,
          padding: "0 8px",
          borderBottom: "1px solid var(--vd-border)",
          background: "var(--vd-surface)",
          flexShrink: 0,
          fontSize: FONT.body,
          color: "var(--vd-text-muted)",
          boxSizing: "border-box",
          opacity: isFocused ? 1 : 0.7,
          transition: `opacity ${MOTION.fast} ${MOTION.easing}`,
        }}
      >
        <StatusDot status={statusKind} title={session ? session.status : "empty"} />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            // Premium-pass (problem #6): a running session's title is real
            // information (which agent, essentially) and now reads at full
            // text contrast + a touch of weight; an empty pane's label stays
            // muted — it's genuinely secondary until something starts.
            color: session ? "var(--vd-text)" : "var(--vd-text-muted)",
            fontWeight: session ? 500 : 400,
          }}
        >
          {session ? session.title : "Empty pane"}
          {session?.status === "exited" && ` (exited ${session.exitCode})`}
        </span>
        {/* Phase 9.5c, PARITY #13c: names the workspace alongside the agent
            — `● agent · workspace`, matching BridgeSpace's header shape.
            Coloured dot only appears once the workspace has a chosen colour
            (PARITY #41); no colour means no dot, not a random one. */}
        {workspace && (
          <span
            title={workspace.rootPath}
            style={{
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "2px 6px",
              borderRadius: RADIUS.sm,
              background: "var(--vd-surface-raised)",
              color: "var(--vd-text-muted)",
              fontSize: FONT.meta,
              maxWidth: 140,
              overflow: "hidden",
            }}
          >
            <span
              aria-hidden
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                flexShrink: 0,
                background: workspace.color ?? "var(--vd-text-faint)",
              }}
            />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {workspace.name}
            </span>
          </span>
        )}
        {/* Phase 9.5c, PARITY #13b: the git branch chip. Renders nothing
            while the branch hasn't loaded yet OR the directory isn't a git
            repo at all — `isRepo: false` is a clean, honest answer (see
            GitBranchResponse's doc comment), not an error state to show. */}
        {gitBranch?.isRepo && gitBranch.branch && (
          <span
            title={`Branch: ${gitBranch.branch}`}
            style={{
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              gap: 3,
              padding: "2px 6px",
              borderRadius: RADIUS.sm,
              background: "var(--vd-surface-raised)",
              color: "var(--vd-text-muted)",
              fontSize: FONT.meta,
              maxWidth: 120,
              overflow: "hidden",
            }}
          >
            <BranchIcon />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {gitBranch.branch}
            </span>
          </span>
        )}
        {/* Context-meter pill (BridgeSpace v3.4.17 parity): only ever
            present for a codex session that has printed its own footer at
            least once — see `contextLeft`'s own comment above and
            contextMeter.ts's top comment for why this is Codex-only and why
            it's a real reading, not an estimate. `title` spells that out on
            hover, matching this app's established honesty-labelling tone
            (see Settings.tsx's notification-permission copy). */}
        {contextLeft !== null && (
          <span title={`${contextLeft}% of Codex's context window left — reported by Codex's own status line, not measured or estimated by vibedeck.`}>
            <Pill status={contextLeftPillStatus(contextLeft)}>{contextLeft}% left</Pill>
          </span>
        )}
        <div className="vd-pane-icons" style={{ display: "flex", alignItems: "center", gap: 2 }}>
          <IconButton title="Split vertical" onClick={() => onSplit(paneId, "row")}>
            <SplitVerticalIcon />
          </IconButton>
          <IconButton title="Split horizontal" onClick={() => onSplit(paneId, "column")}>
            <SplitHorizontalIcon />
          </IconButton>
          <IconButton
            title={isMaximized ? "Restore pane" : "Maximize pane"}
            onClick={() => onToggleMaximize(paneId)}
          >
            {isMaximized ? <RestoreIcon /> : <MaximizeIcon />}
          </IconButton>
          <IconButton title="Close pane" onClick={closeFromHeader}>
            <CloseIcon />
          </IconButton>
        </div>
      </div>

      {/* Result of a dropped skill. Shown here rather than as a toast so it
          is unambiguously attached to the pane it happened to — with 16
          panes open, a floating notice saying "Sent" would not say WHERE.
          Clears itself after a few seconds; a failure carries the server's
          own wording rather than a re-invented one. */}
      {skillDropNotice && (
        <div
          style={{
            padding: "3px 8px",
            fontSize: FONT.meta,
            color: "var(--vd-text-muted)",
            background: "var(--vd-surface)",
            borderBottom: "1px solid var(--vd-border)",
            flexShrink: 0,
          }}
        >
          {skillDropNotice}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0 }}>
        {sessionId ? (
          <Terminal
            sessionId={sessionId}
            // `session` is looked up by sessionId in the same render pass
            // that sets sessionId itself (Grid.tsx's onSessionStarted path
            // updates both together), so this should always be populated
            // by the time a session id exists — the "shell" fallback only
            // guards the theoretical instant it isn't, defaulting to the
            // SAFER of the two busy-detection paths (exact, not heuristic).
            agentId={session?.agent ?? "shell"}
            workspaceId={workspaceId}
            theme={theme}
            isFocused={isFocused}
            onClose={() => onClosePane(paneId)}
            // Phase 9.5c, PARITY #9: the right-click menu's "Split right" /
            // "Split down" entries call this SAME handler the header's split
            // icons already call (see the IconButtons above) — no separate
            // split logic lives in Terminal.tsx.
            onSplit={(direction) => onSplit(paneId, direction)}
            // Context-meter pill: see `contextLeft` state's own comment
            // above — Terminal.tsx only ever calls this for codex panes.
            onContextLeftChange={setContextLeft}
          />
        ) : deferred ? (
          // Session recovery, deferred cold-start restore: this pane's
          // OLD session is recoverable but wasn't eagerly restored (bounded
          // budget or circuit breaker — see restore-budget.ts). Keeps the
          // pane's split position/cwd/intended agent visible and offers an
          // explicit Restore/Discard choice instead of either silently
          // vanishing or auto-spawning a process nobody asked for yet.
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              padding: SPACE.lg,
              boxSizing: "border-box",
              background: "var(--vd-bg)",
              ...EMPTY_SURFACE_BACKGROUND,
            }}
          >
            <EmptyState
              icon={
                <span
                  aria-hidden
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 40,
                    height: 40,
                    borderRadius: "50%",
                    background: deferred.sshProfileId
                      ? "color-mix(in srgb, var(--vd-info) 16%, transparent)"
                      : `color-mix(in srgb, ${agentAccentVar(deferred.agent)} 16%, transparent)`,
                  }}
                >
                  {deferred.sshProfileId ? (
                    <RemoteGlyph size={20} />
                  ) : (
                    <AgentGlyph id={deferred.agent} size={20} />
                  )}
                </span>
              }
              title="This pane's session can be restored"
              description={
                <>
                  Was running <strong style={{ color: "var(--vd-text)" }}>{deferred.title}</strong> in{" "}
                  <code
                    style={{
                      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                      fontSize: FONT.meta,
                    }}
                  >
                    {deferred.cwd}
                  </code>
                  . Not restored automatically — the workspace had more recoverable panes than vibedeck
                  eagerly restores at once.
                </>
              }
              action={
                <div style={{ display: "flex", gap: SPACE.sm, justifyContent: "center" }}>
                  <Button variant="primary" disabled={restoring} onClick={() => void restoreDeferredSession()}>
                    {restoring ? "Restoring…" : "Restore"}
                  </Button>
                  <Button variant="secondary" disabled={restoring} onClick={() => void discardDeferredSession()}>
                    Discard
                  </Button>
                </div>
              }
            >
              {restoreError && (
                <p
                  style={{
                    color: "var(--vd-danger)",
                    fontSize: FONT.meta,
                    marginTop: SPACE.sm,
                    marginBottom: 0,
                    textAlign: "center",
                  }}
                >
                  {restoreError}
                </p>
              )}
            </EmptyState>
          </div>
        ) : (
          // Premium-pass round 1 (problem #1) gave every agent its own
          // glyph/colour on a real card instead of four identical grey
          // rectangles. Round 2 fixes the complaint that survived that pass:
          // the picker was still a small floating island in a ~85% blank
          // pane, which reads as "nothing designed this" rather than "no
          // agent yet". Two changes here: a dotted-texture background (the
          // same 24px/1px pattern the memory Graph/swarm canvas already use
          // for "real content lives here" surfaces — EMPTY_SURFACE_BACKGROUND
          // in shell/ui.tsx) so the negative space around the card grid
          // reads as intentional, and a footer hint row of the pane
          // shortcuts someone looking at an empty pane can actually use
          // right now — real vertical content, not padding for its own sake.
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              padding: SPACE.lg,
              boxSizing: "border-box",
              background: "var(--vd-bg)",
              ...EMPTY_SURFACE_BACKGROUND,
            }}
          >
            <div style={{ width: "100%", maxWidth: 480 }}>
              {/* BridgeSpace V3 parity: "Start vibe coding in {workspace}" +
                  their subtitle, replacing the old generic "Start an agent"
                  header. Falls back to no "in X" clause on the (should-be-
                  rare) null-workspace case, same defensive pattern the
                  workspace chip above already uses. */}
              <div style={{ textAlign: "center", marginBottom: SPACE.lg }}>
                <h2
                  style={{
                    margin: 0,
                    fontSize: FONT.heading,
                    fontWeight: 600,
                    color: "var(--vd-text)",
                    letterSpacing: "-0.01em",
                  }}
                >
                  Start vibe coding{workspace ? ` in ${workspace.name}` : ""}
                </h2>
                <p style={{ margin: "4px 0 0", fontSize: FONT.meta, color: "var(--vd-text-faint)" }}>
                  Launch a coding agent — it runs in a real terminal inside this pane.
                </p>
              </div>

              {(() => {
                const { available, unavailable } = splitByAvailability(agents);
                return (
                  <>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                        gap: SPACE.sm,
                      }}
                    >
                      {available.map((agent) => (
                        <AgentRow
                          key={agent.id}
                          agent={agent}
                          isDefault={agent.id === defaultAgent}
                          disabled={starting}
                          selectable={multiSelectMode}
                          selected={selectedAgents.includes(agent.id)}
                          selectionFull={
                            multiSelectMode &&
                            !selectedAgents.includes(agent.id) &&
                            !canLaunchMultiple([...selectedAgents, agent.id]) &&
                            selectedAgents.length >= 2
                          }
                          onClick={() => handleAgentClick(agent.id)}
                        />
                      ))}
                    </div>

                    {/* Collapsed disclosure row (BridgeSpace parity): agents
                        missing their binary don't clutter the main grid —
                        they sit behind "N more not installed" until opened,
                        each still showing its install hint once expanded. */}
                    {unavailable.length > 0 && (
                      <div style={{ marginTop: SPACE.sm }}>
                        <button
                          type="button"
                          onClick={() => setShowUnavailable((v) => !v)}
                          className="vd-row-hover"
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: SPACE.xs,
                            width: "100%",
                            background: "transparent",
                            border: "none",
                            borderRadius: RADIUS.sm,
                            padding: "6px 8px",
                            cursor: "pointer",
                            color: "var(--vd-text-faint)",
                            fontSize: FONT.meta,
                            boxSizing: "border-box",
                          }}
                        >
                          <DisclosureChevron open={showUnavailable} />
                          <span>{unavailable.length} more not installed</span>
                        </button>

                        {showUnavailable && (
                          <div
                            // Motion pass: this disclosure can only ever be
                            // fully mounted or fully absent (React never
                            // renders it "halfway"), so a `transition` has
                            // no live "before" state to animate from — a
                            // `vd-fade-in` animation (GlobalShellStyles)
                            // is what makes it unfold instead of snap in.
                            className="vd-fade-in"
                            style={{
                              display: "grid",
                              gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                              gap: SPACE.sm,
                              marginTop: SPACE.xs,
                            }}
                          >
                            {unavailable.map((agent) => (
                              <AgentRow key={agent.id} agent={agent} disabled selectable={false} selected={false} selectionFull={false} />
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* "Launch more than one..." (BridgeSpace parity):
                        smallest honest version — picks exactly 2 agents and
                        opens them in a side-by-side split. See
                        agentPicker.ts's MAX_MULTI_LAUNCH comment. */}
                    <div style={{ textAlign: "center", marginTop: SPACE.md }}>
                      {multiSelectMode ? (
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            gap: SPACE.sm,
                            flexWrap: "wrap",
                          }}
                        >
                          <span style={{ fontSize: FONT.meta, color: "var(--vd-text-faint)" }}>
                            {selectedAgents.length === 0
                              ? "Pick 2 agents to launch together"
                              : `${selectedAgents.length} of 2 selected`}
                          </span>
                          <Button
                            variant="primary"
                            disabled={!canLaunchMultiple(selectedAgents)}
                            onClick={confirmMultiLaunch}
                          >
                            Launch {selectedAgents.length || ""}
                          </Button>
                          <Button variant="secondary" onClick={cancelMultiSelect}>
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        available.length >= 2 && (
                          <button
                            type="button"
                            onClick={() => setMultiSelectMode(true)}
                            style={{
                              background: "none",
                              border: "none",
                              padding: 0,
                              color: "var(--vd-text-faint)",
                              fontSize: FONT.meta,
                              cursor: "pointer",
                              textDecoration: "underline",
                              textUnderlineOffset: 2,
                            }}
                          >
                            Launch more than one…
                          </button>
                        )
                      )}
                    </div>
                  </>
                );
              })()}

              {/* SSH connection profiles: a SEPARATE group below the local
                  CLI grid, behind its own hairline + label — never merged
                  into the grid above, so opening a remote pane is always a
                  deliberate, visually distinct choice from starting a local
                  agent (this feature's own design brief: "as a separate
                  group... so it's obvious you're going remote"). Hidden
                  entirely when there are no saved profiles, same "don't
                  show an empty section" idiom the unavailable-agents
                  disclosure above already follows. */}
              {sshProfiles.length > 0 && (
                <div style={{ marginTop: SPACE.lg, paddingTop: SPACE.md, borderTop: "1px solid var(--vd-border)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: SPACE.sm }}>
                    <span aria-hidden style={{ color: "var(--vd-info)", display: "flex" }}>
                      <RemoteGlyph />
                    </span>
                    <span style={{ fontSize: FONT.meta, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--vd-text-faint)" }}>
                      Remote (SSH)
                    </span>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: SPACE.xs }}>
                    {sshProfiles.map((profile) => (
                      <SshProfileRow
                        key={profile.id}
                        profile={profile}
                        disabled={starting}
                        onClick={() => void startSshSession(profile.id)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {startError && (
                <p
                  style={{
                    color: "var(--vd-danger)",
                    fontSize: FONT.meta,
                    marginTop: SPACE.sm,
                    marginBottom: 0,
                    textAlign: "center",
                  }}
                >
                  {startError}
                </p>
              )}

              {/* Footer hint row (round 2): real, usable shortcuts, not
                  decoration — see PANE_HINT_SHORTCUTS' own comment. The
                  hairline above it is the same idiom a pane's own title bar
                  border already uses to separate a header from its body,
                  applied here to separate "pick an agent" from "or, do this
                  instead". */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "center",
                  flexWrap: "wrap",
                  gap: SPACE.md,
                  marginTop: SPACE.lg,
                  paddingTop: SPACE.md,
                  borderTop: "1px solid var(--vd-border)",
                }}
              >
                {PANE_HINT_SHORTCUTS.map(({ id, label }) => {
                  const shortcut = KEYMAP.find((s) => s.id === id);
                  if (!shortcut) return null;
                  return (
                    <span
                      key={id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: SPACE.xs,
                        fontSize: FONT.meta,
                        color: "var(--vd-text-faint)",
                      }}
                    >
                      <KeyHint>{formatShortcut(shortcut, isMac)}</KeyHint>
                      {label}
                    </span>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Empty-pane picker rows (BridgeSpace parity) ------------------------

/**
 * One row in the empty-pane picker's two-column grid — a rounded, full-width
 * button with the agent's glyph + name, replacing the old 2x2 card grid.
 * Handles four states: plain (click to start), the current default agent
 * (accent border + "Default" pill), not-installed (dashed border, muted,
 * shows its install hint), and multi-select (a checkbox-style indicator
 * instead of starting immediately on click — see PaneView's own
 * `multiSelectMode`/`handleAgentClick`).
 */
function AgentRow({
  agent,
  isDefault = false,
  disabled = false,
  selectable,
  selected,
  selectionFull,
  onClick,
}: {
  agent: AgentOption;
  isDefault?: boolean;
  /** True while a start is already in flight, or (unavailable rows) always. */
  disabled?: boolean;
  /** True while the picker is in multi-select mode — swaps "click to start"
   * for "click to check/uncheck". Always false for unavailable rows (you
   * can't multi-launch something that isn't installed). */
  selectable: boolean;
  selected: boolean;
  /** True when multi-select is at its cap AND this row isn't one of the
   * already-selected ones — greys it out so it's clear clicking it won't do
   * anything (agentPicker.ts's `toggleMultiLaunchSelection` already no-ops
   * this case; this is just the matching visual). */
  selectionFull: boolean;
  onClick?: () => void;
}) {
  const isDisabled = !agent.available || disabled || selectionFull;
  return (
    <button
      type="button"
      disabled={isDisabled && !selected}
      onClick={onClick}
      title={
        agent.available
          ? selectable
            ? `${selected ? "Remove" : "Add"} ${agent.displayName}`
            : `Start ${agent.displayName}`
          : agent.installHint
            ? `Not installed — ${agent.installHint}`
            : "Not installed"
      }
      className={`vd-agent-card${isDisabled && !selected ? " is-disabled" : ""}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: SPACE.sm,
        textAlign: "left",
        background: "var(--vd-surface-raised)",
        // Non-shorthand border properties (not the `border: "1px solid ..."`
        // shorthand) so setting `borderStyle` separately never triggers
        // React's "mixing shorthand and non-shorthand" dev warning.
        borderWidth: 1,
        borderColor: selected || isDefault ? "var(--vd-accent)" : "var(--vd-border)",
        borderStyle: agent.available ? "solid" : "dashed",
        borderRadius: RADIUS.lg,
        padding: "8px 10px",
        cursor: isDisabled && !selected ? "not-allowed" : "pointer",
        opacity: agent.available ? (selectionFull && !selected ? 0.5 : 1) : 0.55,
        transition: `border-color ${MOTION.fast} ${MOTION.easing}, transform ${MOTION.fast} ${MOTION.easing}, box-shadow ${MOTION.fast} ${MOTION.easing}`,
        boxSizing: "border-box",
        width: "100%",
      }}
    >
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
          background: agent.available
            ? `color-mix(in srgb, ${agentAccentVar(agent.id)} 16%, transparent)`
            : "var(--vd-surface)",
        }}
      >
        <AgentGlyph id={agent.id} size={15} color={agent.available ? undefined : "var(--vd-text-faint)"} />
      </span>

      {/* A column, not a single line: an unavailable row's install hint
          needs its own full-width line to stay legible instead of fighting
          the name for space on one cramped line — verified against a real
          browser render (docs/DESIGN.md-style visual check), where a single
          line truncated names like "DeepSeek Harness" down to "DeepS…". */}
      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: FONT.body,
            fontWeight: 500,
            color: agent.available ? "var(--vd-text)" : "var(--vd-text-muted)",
          }}
        >
          {agent.displayName}
        </span>
        {!agent.available && agent.installHint && (
          <code
            style={{
              fontSize: FONT.meta - 1,
              color: "var(--vd-text-faint)",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {agent.installHint}
          </code>
        )}
      </span>

      {selectable ? (
        // A minimal checkbox-style indicator — a filled dot in a ring once
        // selected, an empty ring otherwise. Deliberately not a real
        // <input type="checkbox"> (this whole row is already the click
        // target, same as e.g. Gmail's row-click-to-select convention).
        <span
          aria-hidden
          style={{
            width: 14,
            height: 14,
            borderRadius: "50%",
            flexShrink: 0,
            border: `1.5px solid ${selected ? "var(--vd-accent)" : "var(--vd-border)"}`,
            background: selected ? "var(--vd-accent)" : "transparent",
          }}
        />
      ) : isDefault ? (
        <Pill status="info">Default</Pill>
      ) : null}
    </button>
  );
}

/**
 * One row in the SSH profiles group — deliberately a simpler, single-column
 * shape than `AgentRow` above (no availability/install-hint states, no
 * multi-select: every saved profile is always "clickable", since whether it
 * actually connects can only be known by trying — see this pane's own
 * `startSshSession` doc comment). Shows the profile's name plus its
 * connection target (`user@host:port`, via `formatSshDestination`) so it's
 * clear WHERE a profile goes before clicking it, and a small "SSH" pill
 * that echoes the section header's `var(--vd-info)` tint, reinforcing "this
 * row is remote" one more time at the row level, not just the section
 * label above it.
 */
function SshProfileRow({
  profile,
  disabled,
  onClick,
}: {
  profile: SshProfile;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={`Connect to ${formatSshDestination(profile)}`}
      className="vd-agent-card"
      style={{
        display: "flex",
        alignItems: "center",
        gap: SPACE.sm,
        textAlign: "left",
        background: "var(--vd-surface-raised)",
        borderWidth: 1,
        borderColor: "var(--vd-border)",
        borderStyle: "solid",
        borderRadius: RADIUS.lg,
        padding: "8px 10px",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
        transition: `border-color ${MOTION.fast} ${MOTION.easing}, box-shadow ${MOTION.fast} ${MOTION.easing}`,
        boxSizing: "border-box",
        width: "100%",
      }}
    >
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
          background: "color-mix(in srgb, var(--vd-info) 16%, transparent)",
          color: "var(--vd-info)",
        }}
      >
        <RemoteGlyph size={15} />
      </span>
      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: FONT.body,
            fontWeight: 500,
            color: "var(--vd-text)",
          }}
        >
          {profile.name}
        </span>
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: FONT.meta - 1,
            color: "var(--vd-text-faint)",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          }}
        >
          {formatSshDestination(profile)}
        </span>
      </span>
      <Pill status="info">SSH</Pill>
    </button>
  );
}

/** A small "remote machine" glyph — a monitor frame with a signal arc,
 * shared between the section header and each `SshProfileRow`'s icon badge.
 * Same hand-drawn, `currentColor`, no-icon-library convention as every
 * other glyph in this file (SplitVerticalIcon, BranchIcon, ...) and
 * `shell/viewIcons.tsx`'s own `SshIcon` (not imported from there directly:
 * that one is a module-private 14x14 tab icon, not exported, so this is a
 * separate but visually-matching glyph sized for a 26px badge instead). */
function RemoteGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden>
      <rect x="1.5" y="3" width="9.5" height="7" rx="1.3" stroke="currentColor" strokeWidth="1.1" />
      <path d="M3.6 5.2L5.6 6.5L3.6 7.8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6.6 7.8H8.6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      <path d="M10.6 2.4C11.7 3 12.3 4.1 12.3 5.3" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity="0.75" />
      <path d="M9.8 4C10.35 4.3 10.7 4.85 10.7 5.45" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round" opacity="0.75" />
    </svg>
  );
}

/** A small chevron that rotates 90° when `open` — the disclosure row's
 * "N more not installed" affordance. Inline SVG, `currentColor`, matching
 * every other icon in this file. */
function DisclosureChevron({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden
      style={{
        flexShrink: 0,
        transform: open ? "rotate(90deg)" : "none",
        transition: `transform ${MOTION.fast} ${MOTION.easing}`,
      }}
    >
      <path d="M5 3L9.5 7L5 11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// --- Title-bar icons ---------------------------------------------------
// Inline SVG, 14x14, `currentColor` strokes so they pick up IconButton's
// faint→text hover colour automatically — no icon library, no external
// requests (per Phase 4.5's constraints).

function SplitVerticalIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <rect x="1.5" y="2.5" width="11" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.1" />
      <line x1="7" y1="2.5" x2="7" y2="11.5" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

function SplitHorizontalIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <rect x="1.5" y="2.5" width="11" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.1" />
      <line x1="1.5" y1="7" x2="12.5" y2="7" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

function MaximizeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M2 5.5V2h3.5M12 5.5V2H8.5M2 8.5V12h3.5M12 8.5V12H8.5"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M5.5 2v3.5H2M8.5 2v3.5H12M5.5 12V8.5H2M8.5 12V8.5H12"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A small git-branch glyph (two nodes joined by a curved line, the
 * conventional "branch" icon) — inline SVG, matching this file's other
 * title-bar icons: no icon library, `currentColor` so it inherits the
 * chip's muted text colour. */
function BranchIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 14 14" fill="none" aria-hidden style={{ flexShrink: 0 }}>
      <circle cx="4" cy="3" r="1.8" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="4" cy="11" r="1.8" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="10" cy="6" r="1.8" stroke="currentColor" strokeWidth="1.1" />
      <path d="M4 4.8V9.2" stroke="currentColor" strokeWidth="1.1" />
      <path d="M4 6.5C4 5 5 4 6.5 4H8.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M3 3L11 11M11 3L3 11"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}
