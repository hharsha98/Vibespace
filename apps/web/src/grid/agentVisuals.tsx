/**
 * Per-agent visual identity for the empty-pane agent picker (PaneView.tsx) —
 * a small hand-drawn glyph plus an accent colour for each of the four
 * `AgentId`s, so "Claude", "Cursor Agent", "Codex" and "Shell" read as four
 * distinct, intentional choices instead of four identical grey rectangles.
 *
 * Two deliberate constraints, both inherited from docs/DESIGN.md §6 ("colour
 * means status, never decoration... one accent at a time"):
 *
 *  - No new hex colours, anywhere. `agentAccentVar` maps each agent to one
 *    of the UI palette's EXISTING CSS custom properties (`--vd-accent`,
 *    `--vd-info`, `--vd-ok`, `--vd-idle`) — every one of the 26 themes
 *    already defines all four, so "Claude's card looks tinted differently
 *    from Cursor's" is true on every theme with zero new tokens and zero
 *    hard-coded hex. The visual *distinctness* the design brief asks for
 *    comes from pairing that colour with a genuinely different GLYPH SHAPE
 *    per agent, not from inventing four new brand hues that would only
 *    ever be "decoration" per DESIGN.md's own rule.
 *  - Every glyph is drawn by hand as inline SVG using `currentColor` —
 *    no icon library, no external asset, matching every other icon already
 *    in this codebase (see PaneView.tsx's SplitVerticalIcon etc.).
 *
 * `agentAccentVar` is exported on its own (not just used inside
 * `<AgentGlyph>`) so PaneView.tsx can also tint a card's border/background
 * tint to match its glyph — see agentVisuals.test.ts for why it's pure
 * data-in/data-out and therefore trivially unit testable.
 */
import type { AgentId } from "@vibedeck/shared";

/**
 * Maps an agent to the CSS custom property that should colour its glyph,
 * card accents, and hover border. Pure function — no DOM, no React — so
 * `agentVisuals.test.ts` can exercise it under plain Node/vitest the same
 * way `shell/ui.tsx`'s `sessionStatusKind` is tested.
 */
export function agentAccentVar(id: AgentId): string {
  switch (id) {
    case "claude":
      // The app's own primary accent — Claude is vibedeck's default/first
      // agent (see App.tsx's "first available" fallback), so it gets the
      // one colour every theme treats as "the" accent.
      return "var(--vd-accent)";
    case "cursor-agent":
      return "var(--vd-info)";
    case "codex":
      return "var(--vd-ok)";
    case "shell":
      // A plain login shell isn't a third-party "agent" brand at all — it
      // stays the neutral grey every theme already uses for "nothing
      // special going on", same as an idle/exited session's status dot.
      return "var(--vd-idle)";
  }
}

const GLYPH_BY_AGENT: Record<AgentId, () => React.JSX.Element> = {
  claude: ClaudeGlyph,
  "cursor-agent": CursorGlyph,
  codex: CodexGlyph,
  shell: ShellGlyph,
};

/** Renders the glyph for `id` at `size`px, coloured with `agentAccentVar(id)`
 * unless the caller overrides `color` (PaneView.tsx does, for the muted
 * "not installed" state — see that file). */
export function AgentGlyph({
  id,
  size = 20,
  color,
}: {
  id: AgentId;
  size?: number;
  color?: string;
}) {
  const Glyph = GLYPH_BY_AGENT[id];
  return (
    <span
      aria-hidden
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        color: color ?? agentAccentVar(id),
        flexShrink: 0,
      }}
    >
      <Glyph />
    </span>
  );
}

// --- Glyphs --------------------------------------------------------------
// Every glyph shares a 24x24 viewBox and draws in `currentColor` so
// `<AgentGlyph>`'s wrapper `color` (above) is the only place a colour
// decision gets made — the SVGs themselves are pure shape.

/** Claude: an abstract six-point spark — a generic "AI" mark, not a
 * reproduction of any product's actual logo. */
function ClaudeGlyph() {
  return (
    <svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" aria-hidden>
      <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <path d="M12 3.5V9.5" />
        <path d="M12 14.5V20.5" />
        <path d="M4.4 7L9.3 10.2" />
        <path d="M14.7 13.8L19.6 17" />
        <path d="M19.6 7L14.7 10.2" />
        <path d="M9.3 13.8L4.4 17" />
      </g>
      <circle cx="12" cy="12" r="2.1" fill="currentColor" />
    </svg>
  );
}

/** Cursor: a mouse-pointer arrow — the literal shape "cursor" names. */
function CursorGlyph() {
  return (
    <svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M6 4.5L18 13.2L12.4 14.4L15.3 20L12.9 21.1L10 15.5L6 19V4.5Z"
        fill="currentColor"
        fillOpacity="0.18"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Codex: a code bracket mark, `</>`. */
function CodexGlyph() {
  return (
    <svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M9 6.5L4 12L9 17.5M15 6.5L20 12L15 17.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M13.2 5L10.8 19" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/** Shell: a terminal prompt — a rounded frame with a `>` chevron and a
 * cursor underscore, the conventional "this is a terminal" glyph. */
function ShellGlyph() {
  return (
    <svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7 9.5L10.5 12L7 14.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.5 14.5H16.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
