/**
 * Small, shared UI primitives for the Phase 4.5 shell (docs/DESIGN.md §5) —
 * `StatusDot`, `Pill`, `IconButton`, `ListRow` — plus the one bit of pure
 * logic behind them (`sessionStatusKind`) and a small global stylesheet for
 * the hover states CSS custom properties + inline styles alone can't do
 * (see the `GlobalShellStyles` comment below for why that's a `<style>` tag
 * and not inline styles).
 *
 * The point of pulling these out into their own file, rather than each of
 * WorkspaceRail/RightDock/PaneView reinventing "a 6px status dot" its own
 * way, is Phase 4.5's own instruction: later phases (7-10, Board/Memory/
 * Skills/the swarm canvas) reuse these same primitives instead of drifting
 * into slightly-different-looking copies.
 */
import type { ReactNode } from "react";
import { FONT, RADIUS, SHADOW } from "./tokens.js";

/** The five semantic status colours every theme defines (docs/DESIGN.md
 * §2) — the only "meaningful" colours in the whole app; everything else is
 * grey or the one active accent (see DESIGN.md §6, rule 2). */
export type StatusKind = "ok" | "warn" | "danger" | "idle" | "info";

/** Maps a `StatusKind` to the CSS custom property that carries it. Kept as
 * a lookup table (not a template string built from `kind`) so a typo in a
 * `StatusKind` value is a TypeScript error here, not a silently-wrong CSS
 * variable name at runtime. */
const STATUS_VAR: Record<StatusKind, string> = {
  ok: "var(--vd-ok)",
  warn: "var(--vd-warn)",
  danger: "var(--vd-danger)",
  idle: "var(--vd-idle)",
  info: "var(--vd-info)",
};

/**
 * The subset of a session's lifecycle that a status dot/pill ever needs to
 * distinguish. `"empty"` covers a pane with no session attached yet — not a
 * real `SessionInfo.status` value, but every caller (PaneView, the
 * workspace rail) needs a colour for that case too.
 */
export type SessionLikeStatus = "running" | "exited" | "empty";

/**
 * Pure mapping from a session's (or empty pane's) status to the semantic
 * status-colour token that should render it — the ONE place this decision
 * gets made, so a pane's title-bar dot, a workspace row's dot, and (later)
 * a board card's status pill can never silently disagree about what colour
 * "running" is. Per docs/DESIGN.md §2's status table, "exited" and "empty"
 * both read as `idle` (grey, "nothing going on") — only a live pty counts
 * as `ok`. No DOM, no React — plain data in, data out, so it's unit
 * testable under plain Node/vitest (see `ui.test.ts`).
 */
export function sessionStatusKind(status: SessionLikeStatus): StatusKind {
  switch (status) {
    case "running":
      return "ok";
    case "exited":
    case "empty":
      return "idle";
  }
}

/**
 * The CSS custom property that carries a given `StatusKind`'s colour, e.g.
 * `statusColorVar("ok")` -> `"var(--vd-ok)"`. Exported (unlike the
 * `STATUS_VAR` table above, which stays private) specifically so later
 * phases that tint a whole element by status meaning — Phase 7's board
 * column headers, Phase 9's swarm node roles — can reuse the exact same
 * mapping `StatusDot`/`Pill` use, instead of re-deriving their own copy of
 * "which var name means which status" and risking it drifting out of sync.
 */
export function statusColorVar(kind: StatusKind): string {
  return STATUS_VAR[kind];
}

/** A 6px status-colour circle — "the single most repeated element in the
 * UI" per docs/DESIGN.md §5. `title` becomes a native tooltip. */
export function StatusDot({ status, title }: { status: StatusKind; title?: string }) {
  return (
    <span
      title={title}
      aria-hidden={title ? undefined : true}
      style={{
        display: "inline-block",
        width: 6,
        height: 6,
        borderRadius: "50%",
        flexShrink: 0,
        background: STATUS_VAR[status],
      }}
    />
  );
}

/**
 * An uppercase 10px badge, tinted background at ~15% opacity over the
 * status colour with the status colour as text (docs/DESIGN.md §5). Used
 * for counts, priorities, and tags. `color-mix()` (not a hard-coded rgba)
 * is what produces the tint — it works out to the same "15% of the status
 * colour over the surface" regardless of which theme (and therefore which
 * hex value) is active.
 */
export function Pill({ status, children }: { status: StatusKind; children: ReactNode }) {
  const color = STATUS_VAR[status];
  return (
    <span
      style={{
        display: "inline-block",
        fontSize: FONT.label,
        lineHeight: 1.5,
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        padding: "1px 6px",
        borderRadius: RADIUS.sm,
        color,
        background: `color-mix(in srgb, ${color} 15%, transparent)`,
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      {children}
    </span>
  );
}

/**
 * A small chrome icon button — the top bar's theme/help/dock-toggle
 * buttons, a pane's title-bar split/maximise/close icons, etc. Deliberately
 * does NOT set `color` inline for the resting (non-active) state — that's
 * left to the `.vd-icon-btn` class in `GlobalShellStyles` below, so its
 * `:hover` rule (faint → text, per docs/DESIGN.md §5's pane icon spec) can
 * actually take effect. An inline `style.color` would always beat a
 * stylesheet `:hover` rule (inline styles outrank any non-`!important`
 * selector), so setting one here for the resting state would silently
 * break hovering.
 */
export function IconButton({
  title,
  onClick,
  children,
  active,
  className,
}: {
  title: string;
  onClick: () => void;
  children: ReactNode;
  /** Pinned "on" regardless of hover — e.g. the right dock toggle while the dock is open. */
  active?: boolean;
  /** Extra class(es), e.g. `"vd-pane-icons"` so a pane's icon row only shows on hover/focus. */
  className?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={["vd-icon-btn", active ? "is-active" : "", className].filter(Boolean).join(" ")}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 22,
        height: 22,
        padding: 0,
        background: "transparent",
        border: "none",
        borderRadius: RADIUS.sm,
        cursor: "pointer",
        flexShrink: 0,
      }}
    >
      {children}
    </button>
  );
}

/**
 * A 32px list row — workspaces, skills, sessions (docs/DESIGN.md §5).
 * Status dot, label, right-aligned trailing content (typically a `Pill` or
 * plain count). Active row gets a raised background AND a 2px accent left
 * edge; hover gets the raised background alone. Same "don't set the hover
 * property inline" reasoning as `IconButton` above: `background` is only
 * set inline when `active` is true, so the `.vd-list-row:hover` rule can
 * still apply on every OTHER row.
 */
export function ListRow({
  active,
  statusKind,
  label,
  title,
  trailing,
  onClick,
  accentColor,
}: {
  active?: boolean;
  /** Omit for rows with no status meaning (e.g. a plain menu item). */
  statusKind?: StatusKind;
  label: ReactNode;
  title?: string;
  trailing?: ReactNode;
  onClick?: () => void;
  /**
   * Phase 9.5c, PARITY #41: overrides the active row's left-edge colour
   * (and thickens it from 2px to 3px, so a workspace's own identity colour
   * reads as visually distinct from the theme's default accent edge) with a
   * caller-chosen colour instead of `var(--vd-accent)`. Only meaningful
   * when `active` is also true; ignored otherwise. Every OTHER caller of
   * `ListRow` (Board, Agents, Prompts, ...) simply never passes this, so
   * their active-row look is byte-for-byte unchanged.
   */
  accentColor?: string;
}) {
  return (
    <div
      onClick={onClick}
      title={title}
      className="vd-list-row"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        height: 32,
        padding: "0 8px",
        boxSizing: "border-box",
        borderRadius: RADIUS.sm,
        cursor: onClick ? "pointer" : "default",
        background: active ? "var(--vd-surface-raised)" : undefined,
        // Premium-pass (problem #2/#5): an active row now reads as
        // genuinely "raised", not just recoloured — a faint shadow on top
        // of the layering that was already there, same elevation idiom the
        // rest of this pass applies to panes and cards.
        boxShadow: active ? SHADOW.sm : undefined,
        borderLeft: active
          ? `${accentColor ? 3 : 2}px solid ${accentColor ?? "var(--vd-accent)"}`
          : "2px solid transparent",
      }}
    >
      {statusKind && <StatusDot status={statusKind} />}
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontSize: FONT.body,
          fontWeight: active ? 500 : 400,
          color: "var(--vd-text)",
        }}
      >
        {label}
      </span>
      {trailing}
    </div>
  );
}

/**
 * The handful of hover/visibility rules that genuinely need a real CSS
 * `:hover` (or descendant-combinator) selector rather than inline styles or
 * React state — mounted once, at the top of `App.tsx`. A plain `<style>`
 * tag in JSX (not a `document.createElement` side effect at module scope)
 * so it stays scoped to React's own render/mount lifecycle and doesn't run
 * at import time under Node/vitest.
 */
export function GlobalShellStyles() {
  return (
    <style>{`
.vd-icon-btn { color: var(--vd-text-faint); transition: color 120ms ease, background-color 120ms ease; }
.vd-icon-btn:hover, .vd-icon-btn.is-active { color: var(--vd-text); background: var(--vd-surface-raised); }
.vd-list-row:hover { background: var(--vd-surface-raised); }
.vd-pane-icons { opacity: 0; transition: opacity 120ms ease; }
.vd-pane:hover .vd-pane-icons, .vd-pane.is-focused .vd-pane-icons { opacity: 1; }
.vd-board-card-actions { opacity: 0; transition: opacity 120ms ease; }
.vd-board-card:hover .vd-board-card-actions { opacity: 1; }

/* Premium-pass additions (problems #2/#4/#5): a hovered, inactive top-bar
   tab gets a raised background so the whole switcher feels responsive, not
   just the one active pill (the active tab's own inline background always
   wins over this rule regardless, since inline styles outrank a class
   selector — see shell/ui.tsx's IconButton doc comment for the same
   reasoning applied here). */
.vd-view-tab:hover { background: var(--vd-surface-raised); color: var(--vd-text); }

/* A workspace row's rename/delete controls only reveal on hover — the
   colour swatch and running-count badge stay always-visible (they're
   information, not a destructive action), same "hide the controls, not the
   meaning" idiom board cards already use above. */
.vd-workspace-row-actions { opacity: 0; transition: opacity 120ms ease; }
.vd-workspace-row-wrap:hover .vd-workspace-row-actions,
.vd-workspace-row-wrap:focus-within .vd-workspace-row-actions { opacity: 1; }

/* The empty-pane agent picker's cards (PaneView.tsx): a soft lift on hover
   for available agents only — unavailable ("not installed") cards opt out
   via .vd-agent-card.is-disabled so they never look interactive. */
.vd-agent-card:hover:not(.is-disabled) { border-color: var(--vd-accent); transform: translateY(-1px); box-shadow: 0 6px 16px rgba(0, 0, 0, 0.32); }
.vd-agent-card:focus-visible:not(.is-disabled) { outline: 2px solid var(--vd-accent); outline-offset: 1px; }
`}</style>
  );
}
