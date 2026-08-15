import { useMemo, useState } from "react";
import type { AgentId, SessionInfo, Workspace } from "@vibedeck/shared";
import Terminal from "../term/Terminal.js";
import type { Theme } from "../themes/themes.js";
import type { Direction, PaneId } from "./tree.js";
import { EMPTY_SURFACE_BACKGROUND, IconButton, KeyHint, Pill, StatusDot, sessionStatusKind } from "../shell/ui.js";
import { FONT, RADIUS, SHADOW, SPACE } from "../shell/tokens.js";
import { AgentGlyph, agentAccentVar } from "./agentVisuals.js";
import { useGitBranch } from "./useGitBranch.js";
import { KEYMAP, formatShortcut, isMacPlatform } from "../keys/keymap.js";

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
  agents: AgentOption[];
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
  agents,
  defaultAgent,
  workspaceId,
  workspace,
  theme,
  isFocused,
  onFocus,
  onSessionStarted,
  onSplit,
  onClosePane,
  isMaximized,
  onToggleMaximize,
}: PaneViewProps) {
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  // Phase 9.5c, PARITY #13b — polls independently per pane; see
  // useGitBranch.ts's top comment for why polling (not a filesystem watch)
  // and the resulting staleness window.
  const gitBranch = useGitBranch(workspaceId);
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
        body: JSON.stringify(workspaceId ? { agent, workspaceId } : { agent }),
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
        // sake, present on every pane equally.
        boxShadow: SHADOW.sm,
        background: "var(--vd-bg)",
      }}
    >
      <div
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
            theme={theme}
            onClose={() => onClosePane(paneId)}
            // Phase 9.5c, PARITY #9: the right-click menu's "Split right" /
            // "Split down" entries call this SAME handler the header's split
            // icons already call (see the IconButtons above) — no separate
            // split logic lives in Terminal.tsx.
            onSplit={(direction) => onSplit(paneId, direction)}
          />
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
            <div style={{ width: "100%", maxWidth: 440 }}>
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
                  Start an agent
                </h2>
                <p style={{ margin: "4px 0 0", fontSize: FONT.meta, color: "var(--vd-text-faint)" }}>
                  Pick one to run in this pane
                </p>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                  gap: SPACE.sm,
                }}
              >
                {agents.map((agent) => {
                  const disabled = !agent.available || starting;
                  const isDefault = agent.id === defaultAgent && agent.available;
                  return (
                    <button
                      key={agent.id}
                      type="button"
                      disabled={disabled}
                      onClick={() => void startSession(agent.id)}
                      title={
                        agent.available
                          ? `Start ${agent.displayName}`
                          : agent.installHint
                            ? `Not installed — ${agent.installHint}`
                            : "Not installed"
                      }
                      className={`vd-agent-card${disabled ? " is-disabled" : ""}`}
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "flex-start",
                        gap: SPACE.xs + 2,
                        textAlign: "left",
                        background: "var(--vd-surface-raised)",
                        border: `1px solid ${isDefault ? "var(--vd-accent)" : "var(--vd-border)"}`,
                        borderStyle: agent.available ? "solid" : "dashed",
                        borderRadius: RADIUS.xl,
                        padding: SPACE.md,
                        cursor: agent.available && !starting ? "pointer" : "not-allowed",
                        opacity: agent.available ? 1 : 0.55,
                        transition: "border-color 120ms ease, transform 120ms ease, box-shadow 120ms ease",
                        boxSizing: "border-box",
                        width: "100%",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: SPACE.xs, width: "100%" }}>
                        <span
                          aria-hidden
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: 30,
                            height: 30,
                            borderRadius: "50%",
                            flexShrink: 0,
                            background: agent.available
                              ? `color-mix(in srgb, ${agentAccentVar(agent.id)} 16%, transparent)`
                              : "var(--vd-surface)",
                          }}
                        >
                          <AgentGlyph
                            id={agent.id}
                            size={17}
                            color={agent.available ? undefined : "var(--vd-text-faint)"}
                          />
                        </span>
                        {isDefault && <Pill status="info">Default</Pill>}
                      </div>

                      <span
                        style={{
                          fontSize: FONT.body,
                          fontWeight: 600,
                          color: agent.available ? "var(--vd-text)" : "var(--vd-text-muted)",
                        }}
                      >
                        {agent.displayName}
                      </span>

                      {agent.available ? (
                        <span style={{ fontSize: FONT.meta, color: "var(--vd-text-faint)" }}>Ready</span>
                      ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                          <Pill status="idle">Not installed</Pill>
                          {agent.installHint && (
                            <code
                              style={{
                                fontSize: FONT.meta - 1,
                                color: "var(--vd-text-faint)",
                                fontFamily:
                                  "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                                overflowWrap: "anywhere",
                              }}
                            >
                              {agent.installHint}
                            </code>
                          )}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>

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
