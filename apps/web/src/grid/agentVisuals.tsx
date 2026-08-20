/**
 * Per-agent visual identity for the empty-pane agent picker (PaneView.tsx) —
 * a small hand-drawn glyph plus an accent colour for each `AgentId`, so
 * every agent reads as a distinct, intentional choice instead of identical
 * grey rectangles.
 *
 * Two deliberate constraints, both inherited from docs/DESIGN.md §6 ("colour
 * means status, never decoration... one accent at a time"):
 *
 *  - `agentAccentVar` maps each agent to one of the UI palette's EXISTING
 *    CSS custom properties (`--vd-accent`, `--vd-info`, `--vd-ok`,
 *    `--vd-idle`, `--vd-warn`, `--vd-danger` — every `StatusKind` token
 *    `shell/ui.tsx` defines, plus the primary accent) — never a new hex
 *    value. That's 6 tokens total. With the BridgeSpace-parity expansion to
 *    10 agents, there are more agents than tokens, so — same as
 *    `WORKSPACE_COLORS` already does for workspace identity in
 *    `packages/shared/src/protocol.ts` — a couple of tokens are now reused
 *    across two agents each rather than every one being 1:1 unique. The
 *    visual *distinctness* the design brief asks for comes primarily from
 *    each agent's genuinely different GLYPH SHAPE (and, per this phase's
 *    explicit brand-icon exception below, real brand colour baked into a
 *    handful of the more recognisable glyphs themselves), not from the
 *    wrapper accent alone.
 *  - Every glyph is drawn by hand as inline SVG using `currentColor` —
 *    no icon library, no external asset, matching every other icon already
 *    in this codebase (see PaneView.tsx's SplitVerticalIcon etc.) — WITH
 *    one deliberate exception new to this phase: a brand mark is allowed to
 *    use its own real (approximate, hand-picked) brand colour INSIDE its
 *    own `<svg>`, because a brand's colours are part of what makes it
 *    recognisable and they're fixed by the brand, not a decoration this
 *    app invented. That exception stays scoped to inside the glyph
 *    component — it never leaks into `agentAccentVar` or any layout/text/
 *    surface colour, which still resolve only through the CSS custom
 *    properties above on every one of the 26 themes. Used sparingly here:
 *    Gemini's sparkle (Google's well-known 4-colour brand palette, high
 *    confidence) and DeepSeek's whale mark (an approximate brand blue,
 *    lower confidence — see agents.ts's INSTALL_HINTS comment for why).
 *    Every other new glyph (droid, antigravity, opencode, grok) stays
 *    monochrome `currentColor` like the original four, because no brand
 *    colour for those could be confirmed with any real confidence and a
 *    guessed hex would be worse than none. None of these glyphs are traced
 *    from any product's actual logo asset — same "generic, recognisable
 *    shape" policy the original four already established (see ClaudeGlyph's
 *    comment below), not a reproduction of proprietary artwork.
 *
 * `agentAccentVar` is exported on its own (not just used inside
 * `<AgentGlyph>`) so PaneView.tsx can also tint a card's border/background
 * tint to match its glyph — see agentVisuals.test.ts for why it's pure
 * data-in/data-out and therefore trivially unit testable.
 */
import { useId } from "react";
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
    case "gemini":
      // The sparkle glyph itself already carries Google's real brand
      // colours (see GeminiGlyph below) — the wrapper accent just needs to
      // be a warm token that doesn't clash with it.
      return "var(--vd-warn)";
    case "droid":
      return "var(--vd-danger)";
    case "opencode":
      return "var(--vd-idle)";
    case "deepseek":
      // Reuses claude's token — see this file's top comment on why token
      // reuse is unavoidable once there are more agents than palette slots.
      // DeepSeek's own whale glyph carries its (approximate) brand blue.
      return "var(--vd-accent)";
    case "grok":
      return "var(--vd-ok)";
    case "antigravity":
      return "var(--vd-info)";
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
  droid: DroidGlyph,
  deepseek: DeepSeekGlyph,
  antigravity: AntigravityGlyph,
  gemini: GeminiGlyph,
  opencode: OpenCodeGlyph,
  grok: GrokGlyph,
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

/** Droid (Factory): a small robot head — rounded frame, two antennae, two
 * eye dots and a mouth line. Generic "robot" shape, not a trace of
 * Factory's actual logo. Monochrome — see this file's top comment on why
 * no brand colour is used here. */
function DroidGlyph() {
  return (
    <svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M8 5.5L9.4 3.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M16 5.5L14.6 3.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <rect x="5" y="7" width="14" height="11" rx="4" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="9.4" cy="12.3" r="1.1" fill="currentColor" />
      <circle cx="14.6" cy="12.3" r="1.1" fill="currentColor" />
      <path d="M9.3 15.8H14.7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** DeepSeek: a simplified whale silhouette — DeepSeek's real mark is a
 * whale, so the shape borrows that idea without tracing the actual logo
 * asset. Uses an approximate brand blue INSIDE the svg only (see this
 * file's top comment on the brand-colour exception and its confidence
 * level) — `agentAccentVar` itself still resolves through a theme token. */
function DeepSeekGlyph() {
  return (
    <svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M3.3 14.4c1.6-4.4 6.2-7.2 11-6.3c3.7.7 6.4 3.1 7.4 6.3c-1.9.6-3.7-.1-4.5-1.6c-.5 2.2-3.1 3.7-6.2 3.7c-3.1 0-6.1-1-7.7-2.1Z"
        fill="#4D6BFE"
      />
      <circle cx="9.3" cy="12.6" r="0.85" fill="#0B0F1A" fillOpacity="0.55" />
    </svg>
  );
}

/** Antigravity (Google): an arrow breaking straight up out of a dashed
 * "orbit" ellipse — a literal reading of "anti-gravity" (defying it,
 * floating free). Monochrome — no brand colour could be confirmed for
 * this product (see this file's top comment). */
function AntigravityGlyph() {
  return (
    <svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" aria-hidden>
      <ellipse cx="12" cy="16.2" rx="7.2" ry="2.4" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2 2.2" />
      <path
        d="M12 15V4M12 4L8.6 7.4M12 4L15.4 7.4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Gemini CLI (Google): the familiar four-point "sparkle" shape, in
 * Google's well-known brand gradient (blue/purple/red/orange — high
 * confidence, these are Google's long-standing brand colours). A generic
 * sparkle shape, not a trace of the actual Gemini logo asset. Uses
 * `useId()` for the gradient id so multiple instances of this glyph on
 * screen at once (e.g. several empty panes) never collide on one SVG
 * `<defs>` id. */
function GeminiGlyph() {
  const gradientId = useId();
  return (
    <svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" aria-hidden>
      <defs>
        <linearGradient id={gradientId} x1="3" y1="21" x2="21" y2="3" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#4285F4" />
          <stop offset="0.35" stopColor="#9B72CB" />
          <stop offset="0.65" stopColor="#D96570" />
          <stop offset="1" stopColor="#F2A93B" />
        </linearGradient>
      </defs>
      <path
        d="M12 2C12 8 8 12 2 12C8 12 12 16 12 22C12 16 16 12 22 12C16 12 12 8 12 2Z"
        fill={`url(#${gradientId})`}
      />
    </svg>
  );
}

/** OpenCode: square brackets `[ ]` (an "open" idiom) around a chevron —
 * distinct from Codex's angle-bracket `</>` mark. Monochrome. */
function OpenCodeGlyph() {
  return (
    <svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M8.5 4H5.8A1.8 1.8 0 0 0 4 5.8V18.2A1.8 1.8 0 0 0 5.8 20H8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M15.5 4H18.2A1.8 1.8 0 0 1 20 5.8V18.2A1.8 1.8 0 0 1 18.2 20H15.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10.5 9.8L13.2 12L10.5 14.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Grok Build (xAI): an abstract "G" — an open circular arc plus a bar,
 * the same "generic initial/abstract mark" treatment this file's other
 * glyphs use, not a reproduction of xAI's actual logo. Monochrome — xAI's
 * own branding is itself black/white/minimal, so no colour is lost here. */
function GrokGlyph() {
  return (
    <svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M17.2 8.3A6.6 6.6 0 1 0 18.6 15"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path d="M13.2 12H18.6V16.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
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
