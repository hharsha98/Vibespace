/**
 * Per-agent visual identity for the empty-pane agent picker (PaneView.tsx) —
 * a small glyph plus an accent colour for each `AgentId`, so every agent
 * reads as a distinct, intentional choice instead of identical grey
 * rectangles.
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
 *    each agent's genuinely different GLYPH SHAPE, not from the wrapper
 *    accent alone.
 *  - Every glyph is inline SVG, no icon library or external asset fetch —
 *    WITH one deliberate exception: **real product logos are used for the
 *    agents that name an actual third-party tool** (nominative use — the
 *    mark identifies which tool a row launches, same as any IDE/launcher's
 *    "open with X" list; it never appears in vibespace's own branding —
 *    Logo.tsx, favicon.svg, the Tauri app icons are untouched by this
 *    file). Every path below is the exact `d` geometry published by one of
 *    two source-of-truth icon sets, copied verbatim, not hand-traced:
 *      - simple-icons (github.com/simple-icons/simple-icons, CC0) — Cursor,
 *        OpenCode.
 *      - lobehub/lobe-icons (github.com/lobehub/lobe-icons, MIT) — an
 *        actively maintained AI/LLM-brand-logo set used for every mark
 *        simple-icons doesn't (yet) carry: Claude Code, Codex, Gemini CLI,
 *        DeepSeek, Antigravity, Grok/xAI. Two products have NO published
 *        mark in either set — Factory's Droid and vibespace's own plain
 *        shell — those two glyphs are still hand-drawn approximations, and
 *        say so in their own comments below.
 *    A brand mark is allowed to use its own real brand colour INSIDE its
 *    own `<svg>` (Claude Code's clay #D97757, DeepSeek's blue #4D6BFE,
 *    Gemini CLI's red→purple→blue gradient — all copied from the source
 *    icon set's own colour constants, not eyeballed). That exception stays
 *    scoped to inside the glyph component — it never leaks into
 *    `agentAccentVar` or any layout/text/surface colour, which still
 *    resolve only through the CSS custom properties above on every one of
 *    the 26 themes. Brands that are themselves monochrome black/white
 *    (Codex, Cursor, OpenCode, Antigravity, Grok/xAI — confirmed by their
 *    source icon set's own `COLOR_PRIMARY: '#fff'`/`'#000'` constants, not
 *    guessed) render in `currentColor` instead, which reads correctly in
 *    both light and dark themes rather than forcing a fixed black or white.
 *
 * `agentAccentVar` is exported on its own (not just used inside
 * `<AgentGlyph>`) so PaneView.tsx can also tint a card's border/background
 * tint to match its glyph — see agentVisuals.test.ts for why it's pure
 * data-in/data-out and therefore trivially unit testable.
 */
import { useId } from "react";
import type { AgentId } from "@vibespace/shared";

/**
 * Maps an agent to the CSS custom property that should colour its glyph,
 * card accents, and hover border. Pure function — no DOM, no React — so
 * `agentVisuals.test.ts` can exercise it under plain Node/vitest the same
 * way `shell/ui.tsx`'s `sessionStatusKind` is tested.
 */
export function agentAccentVar(id: AgentId): string {
  switch (id) {
    case "claude":
      // The app's own primary accent — Claude is vibespace's default/first
      // agent (see App.tsx's "first available" fallback), so it gets the
      // one colour every theme treats as "the" accent.
      return "var(--vd-accent)";
    case "cursor-agent":
      return "var(--vd-info)";
    case "codex":
      return "var(--vd-ok)";
    case "gemini":
      // The glyph itself already carries Gemini CLI's real brand gradient
      // (see GeminiGlyph below) — the wrapper accent just needs to be a
      // warm token that doesn't clash with it.
      return "var(--vd-warn)";
    case "droid":
      return "var(--vd-danger)";
    case "opencode":
      return "var(--vd-idle)";
    case "deepseek":
      // Reuses claude's token — see this file's top comment on why token
      // reuse is unavoidable once there are more agents than palette slots.
      // DeepSeek's own whale glyph carries its real brand blue.
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
// Every glyph shares a 24x24 viewBox (the native viewBox of every source
// path below, so no rescaling was needed) and renders at whatever pixel
// size <AgentGlyph> is given — see this file's top comment for where each
// `d` path came from and the brand-colour exception's scope.

/** Claude Code: Anthropic's actual "Claude Code" application mark — a
 * terminal window motif rendered as a single cut path — in its real clay/
 * terracotta brand colour (#D97757, copied from lobe-icons'
 * `ClaudeCode.style.COLOR_PRIMARY`, not eyeballed). Source: lobehub/
 * lobe-icons `src/ClaudeCode/components/Color.tsx`. This is Claude Code's
 * own distinct app mark, not the general Claude.ai asterisk — the more
 * correct choice since this row launches the Claude Code CLI specifically. */
function ClaudeGlyph() {
  return (
    <svg width="100%" height="100%" viewBox="0 0 24 24" aria-hidden>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        fill="#D97757"
        d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z"
      />
    </svg>
  );
}

/** Cursor: the real Cursor mark, a faceted diamond/pointer built from three
 * flat-shaded triangular planes. Monochrome in the source brand itself
 * (`COLOR_PRIMARY: '#000'`), so rendered in `currentColor`. Source: simple-
 * icons `icons/cursor.svg` (path is byte-identical to lobe-icons' own
 * Cursor Mono, cross-confirming it). */
function CursorGlyph() {
  return (
    <svg width="100%" height="100%" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="currentColor"
        d="M22.106 5.68L12.5.135a.998.998 0 00-.998 0L1.893 5.68a.84.84 0 00-.419.726v11.186c0 .3.16.577.42.727l9.607 5.547a.999.999 0 00.998 0l9.608-5.547a.84.84 0 00.42-.727V6.407a.84.84 0 00-.42-.726zm-.603 1.176L12.228 22.92c-.063.108-.228.064-.228-.061V12.34a.59.59 0 00-.295-.51l-9.11-5.26c-.107-.062-.063-.228.062-.228h18.55c.264 0 .428.286.296.514z"
      />
    </svg>
  );
}

/** OpenAI Codex: OpenAI's actual Codex product mark (a rounded, leaf-like
 * abstract shape distinct from the general OpenAI "flower" logo — Codex
 * has its own icon). Monochrome in the source brand (`COLOR_PRIMARY:
 * '#fff'`), rendered in `currentColor`. Source: lobehub/lobe-icons
 * `src/Codex/components/Mono.tsx`. */
function CodexGlyph() {
  return (
    <svg width="100%" height="100%" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"
      />
    </svg>
  );
}

/** Droid (Factory): NEITHER simple-icons NOR lobehub/lobe-icons (checked
 * both, including a raw github directory search) carries a published mark
 * for Factory's Droid CLI — it's simply too new/niche for either set. This
 * stays a hand-drawn approximation: a small robot head, generic "robot"
 * shape, not a trace of any real Factory logo asset. Monochrome
 * `currentColor` since no real brand colour could be confirmed either. */
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

/** DeepSeek: DeepSeek's actual whale mark, in its real brand blue
 * (#4D6BFE — copied from lobe-icons' `DeepSeek.style.COLOR_PRIMARY`; this
 * exact hex is also independently confirmed by simple-icons'
 * `icons/deepseek.svg`, so it's high confidence, not the "approximate"
 * guess this file used before real path data was available). Source:
 * lobehub/lobe-icons `src/DeepSeek/components/Color.tsx`. */
function DeepSeekGlyph() {
  return (
    <svg width="100%" height="100%" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="#4D6BFE"
        d="M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z"
      />
    </svg>
  );
}

/** Antigravity (Google): Antigravity's own published mark — a swept
 * wing/flame silhouette — found only in lobehub/lobe-icons (simple-icons
 * doesn't carry it yet), so this is a real product mark but from a single
 * source rather than cross-confirmed across two, worth flagging at a
 * slightly lower confidence than the others. Monochrome in the source
 * brand (`COLOR_PRIMARY: '#fff'`), rendered in `currentColor`. Source:
 * lobehub/lobe-icons `src/Antigravity/components/Mono.tsx`. */
function AntigravityGlyph() {
  return (
    <svg width="100%" height="100%" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="currentColor"
        d="M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z"
      />
    </svg>
  );
}

/** Gemini CLI (Google): the real Gemini CLI application mark — a rounded
 * squircle badge with Google's brand gradient (red #EE4D5D → purple
 * #B381DD → blue #207CFE, copied from lobe-icons' own gradient stops) as
 * its ring, and a dark (#1E1E2E) cut-out "flash" glyph on top — the actual
 * app-icon design used by the Gemini CLI project, not the generic four-
 * point Gemini sparkle this file used before real path data was available.
 * Uses `useId()` for the gradient id so multiple instances on screen at
 * once (e.g. several empty panes) never collide on one SVG `<defs>` id.
 * Source: lobehub/lobe-icons `src/GeminiCLI/components/Color.tsx`. */
function GeminiGlyph() {
  const gradientId = useId();
  return (
    <svg width="100%" height="100%" viewBox="0 0 24 24" aria-hidden>
      <defs>
        <linearGradient id={gradientId} x1="24" y1="6.587" x2="0" y2="16.494" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#EE4D5D" />
          <stop offset="0.328" stopColor="#B381DD" />
          <stop offset="0.476" stopColor="#207CFE" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${gradientId})`}
        d="M0 4.391A4.391 4.391 0 014.391 0h15.217A4.391 4.391 0 0124 4.391v15.217A4.391 4.391 0 0119.608 24H4.391A4.391 4.391 0 010 19.608V4.391z"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        fill="#1E1E2E"
        d="M19.74 1.444a2.816 2.816 0 012.816 2.816v15.48a2.816 2.816 0 01-2.816 2.816H4.26a2.816 2.816 0 01-2.816-2.816V4.26A2.816 2.816 0 014.26 1.444h15.48zM7.236 8.564l7.752 3.728-7.752 3.727v2.802l9.557-4.596v-3.866L7.236 5.763v2.801z"
      />
    </svg>
  );
}

/** OpenCode: OpenCode's real mark, a nested-rectangle "frame" motif.
 * Monochrome in the source brand (`COLOR_PRIMARY: '#000'`), rendered in
 * `currentColor`. Source: simple-icons `icons/opencode.svg` (shape is
 * independently confirmed by lobe-icons' own OpenCode Mono, which draws
 * the same nested-frame idea at different coordinates). */
function OpenCodeGlyph() {
  return (
    <svg width="100%" height="100%" viewBox="0 0 24 24" aria-hidden>
      <path fill="currentColor" d="M22 24H2V0h20zM17 4.8H7v14.4h10z" />
    </svg>
  );
}

/** Grok (xAI): xAI's actual angular "X" mark — used by xAI across Grok's
 * own branding. Monochrome in the source brand (`COLOR_PRIMARY: '#fff'`,
 * confirming this file's earlier note that xAI's branding is itself
 * black/white/minimal), rendered in `currentColor`. Source: lobehub/
 * lobe-icons `src/XAI/components/Mono.tsx` (its own `TITLE` constant is
 * literally `'Grok'`). */
function GrokGlyph() {
  return (
    <svg width="100%" height="100%" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="currentColor"
        d="M6.469 8.776L16.512 23h-4.464L2.005 8.776H6.47zm-.004 7.9l2.233 3.164L6.467 23H2l4.465-6.324zM22 2.582V23h-3.659V7.764L22 2.582zM22 1l-9.952 14.095-2.233-3.163L17.533 1H22z"
      />
    </svg>
  );
}

/** Shell: a plain login shell isn't a third-party product with its own
 * brand mark, so this stays what it always was — a hand-drawn terminal
 * prompt (a rounded frame with a `>` chevron and a cursor underscore), the
 * conventional "this is a terminal" glyph. */
function ShellGlyph() {
  return (
    <svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7 9.5L10.5 12L7 14.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.5 14.5H16.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
