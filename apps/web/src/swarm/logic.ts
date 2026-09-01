/**
 * Pure logic behind the Phase 9b mission canvas — no DOM, no React, so it's
 * unit-testable under plain Node/vitest (CI is ubuntu-latest with no
 * browser, same constraint `keymap.ts` and `Graph.tsx`'s helpers live
 * under). Everything a component needs to derive from a `MissionDetail`
 * that ISN'T "draw a canvas" lives here: node positions, role/status colour
 * lookups, progress arithmetic, elapsed-time formatting, and @mention
 * parsing for the command bar.
 */
import type { MissionAgentStatus, MissionRole, MissionStatus, MissionTaskStatus } from "@vibespace/shared";
import type { StatusKind } from "../shell/ui.js";

// --- Node layout ------------------------------------------------------------

export interface RoleAgentLike {
  id: string;
  role: MissionRole;
}

export interface NodeLayout {
  id: string;
  x: number;
  y: number;
}

/** Distance from the coordinator to every other agent's ring. Matches
 * docs/DESIGN.md §5's "coordinator at the centre with its team radiating
 * out" literally: one coordinator sits at the origin, everyone else sits on
 * a circle around it, evenly spaced by angle. */
const TEAM_RADIUS = 150;
/** When a mission has more than one coordinator (unusual, but the server
 * doesn't forbid it), they'd otherwise all draw on top of each other at the
 * origin — spread them on a small inner ring instead. */
const COORDINATOR_RADIUS = 36;

/**
 * Lays out a mission's agents: coordinator(s) at/near the centre, every
 * other role on a ring around them, evenly spaced starting from the top
 * (12 o'clock) going clockwise. Pure and deterministic — same input, same
 * output — so the canvas component only has to draw the numbers this
 * returns, and this function can be unit-tested with plain coordinates
 * instead of a real render.
 */
export function layoutMissionNodes(agents: readonly RoleAgentLike[]): NodeLayout[] {
  const coordinators = agents.filter((a) => a.role === "coordinator");
  const others = agents.filter((a) => a.role !== "coordinator");

  const layout: NodeLayout[] = coordinators.map((c, i) => {
    if (coordinators.length <= 1) return { id: c.id, x: 0, y: 0 };
    const angle = (i / coordinators.length) * Math.PI * 2;
    return { id: c.id, x: Math.cos(angle) * COORDINATOR_RADIUS, y: Math.sin(angle) * COORDINATOR_RADIUS };
  });

  const n = others.length;
  others.forEach((agent, i) => {
    // Start at -90deg (straight up) so a single agent lands at 12 o'clock
    // rather than 3 o'clock — reads more like "radiating out" than an
    // arbitrary starting point would.
    const angle = n === 0 ? 0 : (i / n) * Math.PI * 2 - Math.PI / 2;
    layout.push({ id: agent.id, x: Math.cos(angle) * TEAM_RADIUS, y: Math.sin(angle) * TEAM_RADIUS });
  });

  return layout;
}

// --- Colour lookups ----------------------------------------------------------

/**
 * Role colours per docs/DESIGN.md §2: coordinator = `--warn`, builder =
 * `--ok`, scout = `--info` — all three already exist as theme-authored
 * status tokens, reused here for their ROLE meaning rather than their
 * status meaning (a deliberate, documented double-use, not a coincidence).
 * `reviewer` is the odd one out: the design doc gives it as a flat literal
 * hex (`#c084fc`), not a per-theme token, because no theme defines a
 * "reviewer" colour of its own. Rather than hard-coding that hex here (this
 * repo's "tokens only" rule), `--vd-role-reviewer` is minted as ONE new CSS
 * custom property, set once in `themes.ts`'s `applyThemeCssVars` — so the
 * literal from the design doc lives in exactly one place, and every
 * component (this file, MissionCanvas, the agent inspector) still only ever
 * reads a `var(--vd-*)` name, never a hex.
 */
const ROLE_COLOR_VAR: Record<MissionRole, string> = {
  coordinator: "var(--vd-warn)",
  builder: "var(--vd-ok)",
  scout: "var(--vd-info)",
  reviewer: "var(--vd-role-reviewer)",
};

export function roleColorVar(role: MissionRole): string {
  return ROLE_COLOR_VAR[role];
}

/** A short single-character glyph per role, drawn inside a node pill next to
 * its label — plain geometric unicode (not emoji, matching the rest of the
 * app's icon language, e.g. the pane title bar's split/close glyphs). */
const ROLE_GLYPH: Record<MissionRole, string> = {
  coordinator: "◆",
  builder: "▲",
  scout: "●",
  reviewer: "◇",
};

export function roleGlyph(role: MissionRole): string {
  return ROLE_GLYPH[role];
}

/**
 * Maps a live agent's status to the semantic `StatusKind` its node dot (and
 * the inspector panel) should render, per docs/DESIGN.md §2's status table:
 * idle -> idle (grey), working -> warn (attention), blocked -> danger (needs
 * a human), done -> ok (healthy/finished), failed -> danger (critical). The
 * ONE place this decision gets made, same reasoning as `sessionStatusKind`
 * in shell/ui.tsx.
 */
const AGENT_STATUS_KIND: Record<MissionAgentStatus, StatusKind> = {
  idle: "idle",
  working: "warn",
  blocked: "danger",
  done: "ok",
  failed: "danger",
};

export function agentStatusKind(status: MissionAgentStatus): StatusKind {
  return AGENT_STATUS_KIND[status];
}

/**
 * Maps a mission's own status to a `StatusKind` for its mission-bar pill.
 * `complete` reads as `idle` (grey, "nothing going on any more") rather than
 * `ok` — the same choice `sessionStatusKind` makes for `exited` — because
 * `ok` on this palette specifically means "currently healthy and running",
 * not "finished successfully".
 */
const MISSION_STATUS_KIND: Record<MissionStatus, StatusKind> = {
  running: "ok",
  paused: "warn",
  complete: "idle",
  stopped: "danger",
};

export function missionStatusKind(status: MissionStatus): StatusKind {
  return MISSION_STATUS_KIND[status];
}

// --- Progress ----------------------------------------------------------------

export interface MissionProgress {
  completed: number;
  total: number;
  /** 0..1, or 0 when there are no tasks yet (an empty mission isn't "100%
   * done", it just has nothing to measure). */
  ratio: number;
}

export function computeProgress(tasks: readonly { status: MissionTaskStatus }[]): MissionProgress {
  const completed = tasks.filter((t) => t.status === "complete").length;
  const total = tasks.length;
  return { completed, total, ratio: total === 0 ? 0 : completed / total };
}

// --- Elapsed time --------------------------------------------------------------

/**
 * Formats the time between `startIso` and `nowMs` as `mm:ss`, or `h:mm:ss`
 * past an hour. Takes `nowMs` as a parameter (rather than calling
 * `Date.now()` itself) so it stays pure and testable — the component
 * driving the ticking clock owns its own `setInterval`/re-render and just
 * passes the current time in.
 */
export function formatElapsed(startIso: string, nowMs: number): string {
  const startMs = new Date(startIso).getTime();
  const deltaSec = Math.max(0, Math.floor((nowMs - startMs) / 1000));
  const hours = Math.floor(deltaSec / 3600);
  const minutes = Math.floor((deltaSec % 3600) / 60);
  const seconds = deltaSec % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

// --- Command bar @mentions -----------------------------------------------------

export interface MentionTarget {
  id: string;
  /** The agent's human-facing label, e.g. "Builder 2" — what's typed after `@`. */
  label: string;
}

export interface MentionParseResult {
  /** The agent id a leading `@Label` addressed, or null for a broadcast. */
  targetAgentId: string | null;
  /** The message body with a matched leading `@Label` (and the whitespace
   * right after it) stripped — what actually gets POSTed as `body`. */
  body: string;
}

/**
 * Parses an optional leading `@Label` out of the command bar's text —
 * e.g. `"@Builder 2 fix the login bug"` against `[{id:"a1",label:"Builder
 * 2"}]` returns `{ targetAgentId: "a1", body: "fix the login bug" }`. Text
 * with no leading `@`, or an `@` that doesn't match any known agent label,
 * parses as a broadcast (`targetAgentId: null`) with the body untouched
 * (just trimmed) — this is what makes the command bar's "@ to target one
 * agent, otherwise broadcast" behaviour a pure, testable rule rather than
 * something only provable by clicking through a real browser.
 *
 * Matches the LONGEST agent label that's a prefix of the text after `@`, so
 * "Builder 1" doesn't shadow "Builder 10" (not a real label shape today, but
 * the longest-match rule is the correct general behaviour regardless).
 */
export function parseMention(text: string, agents: readonly MentionTarget[]): MentionParseResult {
  const trimmed = text.trim();
  if (!trimmed.startsWith("@")) {
    return { targetAgentId: null, body: trimmed };
  }

  const afterAt = trimmed.slice(1);
  let best: MentionTarget | null = null;
  for (const agent of agents) {
    if (afterAt.toLowerCase().startsWith(agent.label.toLowerCase())) {
      if (!best || agent.label.length > best.label.length) best = agent;
    }
  }
  if (!best) {
    return { targetAgentId: null, body: trimmed };
  }

  const remainder = afterAt.slice(best.label.length).trimStart();
  return { targetAgentId: best.id, body: remainder };
}

// --- Zoom-to-fit ---------------------------------------------------------------

export interface ViewTransform {
  x: number;
  y: number;
  k: number;
}

/** Clamp bounds shared with the canvas's scroll-to-zoom handler, so "fit"
 * never produces a scale the scroll wheel couldn't also reach. */
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 3;

/**
 * Computes the pan/zoom transform for the canvas's "fit" zoom-cluster
 * button: scale so every node's bounding box fits inside the container
 * (with padding), clamped to the same zoom range scrolling uses. Because
 * `layoutMissionNodes` always centres the coordinator (and therefore the
 * whole radial layout) on the origin, and the canvas draws that origin at
 * the container's own centre, "fit" only ever needs to change SCALE — the
 * pan offset that keeps the layout centred is already `(0, 0)`, so this
 * deliberately doesn't try to re-centre on the bounding box's own midpoint
 * (which, for a symmetric ring layout, is the same point anyway).
 */
export function fitTransform(
  nodes: readonly { x: number; y: number }[],
  containerWidth: number,
  containerHeight: number,
  nodeHalfExtent = 90,
  padding = 40
): ViewTransform {
  if (nodes.length === 0) return { x: 0, y: 0, k: 1 };

  const minX = Math.min(...nodes.map((n) => n.x)) - nodeHalfExtent;
  const maxX = Math.max(...nodes.map((n) => n.x)) + nodeHalfExtent;
  const minY = Math.min(...nodes.map((n) => n.y)) - nodeHalfExtent;
  const maxY = Math.max(...nodes.map((n) => n.y)) + nodeHalfExtent;
  const boxWidth = Math.max(1, maxX - minX);
  const boxHeight = Math.max(1, maxY - minY);

  const availableWidth = Math.max(1, containerWidth - padding * 2);
  const availableHeight = Math.max(1, containerHeight - padding * 2);

  const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(availableWidth / boxWidth, availableHeight / boxHeight)));
  return { x: 0, y: 0, k };
}

/**
 * While the user is still typing a mention (hasn't hit a space yet), returns
 * the partial text after the last `@` before `cursorIndex` — e.g. `"hey
 * @Buil"` with the cursor at the end returns `"Buil"`, so the command bar can
 * filter its inline agent-name suggestions against it. Returns null when the
 * cursor isn't inside an in-progress mention (no `@` before it on the
 * current word, or the mention word is already finished with a space).
 */
export function mentionQueryAt(text: string, cursorIndex: number): string | null {
  const upToCursor = text.slice(0, Math.max(0, Math.min(cursorIndex, text.length)));
  const at = upToCursor.lastIndexOf("@");
  if (at === -1) return null;
  const between = upToCursor.slice(at + 1);
  if (/\s/.test(between)) return null; // the @word was already closed by whitespace
  return between;
}
