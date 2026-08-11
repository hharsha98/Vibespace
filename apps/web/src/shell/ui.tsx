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
        fontSize: 10,
        lineHeight: 1.5,
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        padding: "1px 6px",
        borderRadius: 4,
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
        borderRadius: 4,
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
}: {
  active?: boolean;
  /** Omit for rows with no status meaning (e.g. a plain menu item). */
  statusKind?: StatusKind;
  label: ReactNode;
  title?: string;
  trailing?: ReactNode;
  onClick?: () => void;
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
        borderRadius: 4,
        cursor: onClick ? "pointer" : "default",
        background: active ? "var(--vd-surface-raised)" : undefined,
        borderLeft: active ? "2px solid var(--vd-accent)" : "2px solid transparent",
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
          fontSize: 12,
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
`}</style>
  );
}
