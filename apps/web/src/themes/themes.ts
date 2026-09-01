/**
 * vibespace's theme engine: the `Theme` shape, the built-in theme catalogue,
 * and small helpers for persisting/applying the active one.
 *
 * Two independent palettes live inside every `Theme`:
 *  - `ui`: colours for vibespace's own chrome (header, tabs, panes, buttons),
 *    applied as CSS custom properties on `:root` (see `applyThemeCssVars`)
 *    so every component just reads `var(--vd-*)` instead of a hard-coded
 *    hex value.
 *  - `terminal`: the 16 ANSI colours plus background/foreground/cursor/
 *    selection, in exactly the shape xterm.js's `ITheme` expects (same
 *    field names) — so `theme.terminal` can be assigned straight to
 *    `term.options.theme` with no conversion step.
 *
 * `terminal` intentionally has NO optional fields. A theme that only fills
 * in, say, 12 of the 16 ANSI slots would silently fall back to xterm's
 * defaults for the rest — which makes coloured CLI output (an agent's own
 * syntax highlighting, `ls --color`, git diffs...) unreadable in exactly
 * the colours that theme was supposed to own. Making every field required
 * means TypeScript itself refuses to compile a half-finished palette;
 * `themes.test.ts` then double-checks the same thing at the data level, in
 * case a future edit widens the type back to optional.
 *
 * Nothing in this file touches the DOM or `localStorage` at module scope —
 * only inside function bodies — so importing it (as `themes.test.ts` does)
 * is safe under plain Node/vitest with no browser or jsdom involved. The one
 * import below (`SHADOW`/`LIGHT_SHADOW` from tokens.ts) keeps that property:
 * tokens.ts is itself a plain-constants module with no DOM/React dependency
 * of its own (see its own top comment), so pulling the elevation-shadow
 * scale in for `applyThemeCssVars` (below) doesn't change that.
 */
import { readWithLegacyFallback } from "../settings/legacyStorage.js";
import { LIGHT_SHADOW, SHADOW } from "../shell/tokens.js";

/**
 * vibespace's own UI chrome colours — applied as CSS custom properties.
 *
 * Phase 4.5 (the visual overhaul, see docs/DESIGN.md §2) grew this from 7
 * fields to 14: the original `background/surface/border/text/textMuted/
 * accent/accentText` set, plus `surfaceRaised`/`textFaint` (one more step
 * of layering/dimming each) and five *status* colours (`ok`/`warn`/`danger`/
 * `idle`/`info`) that every status dot, pill, and badge in the app draws
 * from — so "running" always means the same colour whether it's a workspace
 * row, a pane's title-bar dot, or (in later phases) a board card.
 */
export interface UIPalette {
  background: string;
  surface: string;
  /** One layer up from `surface` — cards, menus, popovers, the active row
   * in a list. Dark themes go a step LIGHTER than `surface`; light themes go
   * a step DARKER, so "raised" always reads as "closer to the viewer"
   * regardless of which direction that is in hex terms for this theme. */
  surfaceRaised: string;
  border: string;
  text: string;
  textMuted: string;
  /** Dimmer than `textMuted` — meta text, hints, the 10px uppercase section
   * labels (`WORKSPACES`). */
  textFaint: string;
  accent: string;
  /**
   * Text colour to place on top of an `accent`-coloured background (e.g. a
   * primary button's label). Not one of the fields the phase spec named
   * explicitly, but necessary once light themes exist — white text on a
   * light-theme's light-blue accent would be unreadable, unlike on the
   * dark themes where white always works.
   */
  accentText: string;
  /** Running / healthy. Status dots, "running" pills, ok-state badges. */
  ok: string;
  /** Working / needs attention. */
  warn: string;
  /** Error / critical / stopped. */
  danger: string;
  /** Idle / exited / nothing going on. Always a grey, never a "colour". */
  idle: string;
  /** Informational (not a running-state signal on its own). */
  info: string;
}

/**
 * The terminal colour palette, field-for-field identical to xterm.js's own
 * `ITheme` interface (see `@xterm/xterm`'s type definitions) — deliberately
 * NOT imported from there, so this file (and its test) stays completely
 * free of any xterm/DOM dependency. `Terminal.tsx` is the only place that
 * ever hands one of these to xterm, and it does so directly since the
 * shapes match.
 */
export interface TerminalPalette {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface Theme {
  /** Stable id — persisted to localStorage and used as the React key/lookup. */
  id: string;
  /** Display name shown in the theme picker, command palette, and header. */
  name: string;
  /** Drives which section of the picker a theme is grouped under. */
  isDark: boolean;
  ui: UIPalette;
  terminal: TerminalPalette;
}

/**
 * The 7 "hand-picked" UI fields every theme still authors directly — the
 * rest of `UIPalette` (`surfaceRaised`, `textFaint`, and the five status
 * colours) is *derived* from these plus the theme's own terminal palette,
 * by `deriveUi` below, rather than hand-written 26 more times over. This is
 * what "derived sensibly" (Phase 4.5's instruction) means in code: every
 * theme's status colours come from ITS OWN ANSI green/yellow/red/blue, so a
 * theme stays internally coherent instead of borrowing some other theme's
 * idea of "red".
 */
interface UIBase {
  background: string;
  surface: string;
  border: string;
  text: string;
  textMuted: string;
  accent: string;
  accentText: string;
}

/** One theme's raw data, before `deriveUi` expands `base` into a full `UIPalette`. */
interface ThemeDef {
  id: string;
  name: string;
  isDark: boolean;
  base: UIBase;
  terminal: TerminalPalette;
}

// --- Small, dependency-free colour math -----------------------------------
// Deliberately hand-rolled (not pulled from a colour library) — this file's
// whole point is staying free of any DOM/browser dependency so
// `themes.test.ts` can import it under plain Node/vitest (see the top-level
// comment). A tiny hex-blend function is a handful of lines; a colour
// library would be a dependency for a handful of lines' worth of value.

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

/** Parses a `#rgb` or `#rrggbb` hex string into its [r, g, b] byte triple. */
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const num = parseInt(full.slice(0, 6), 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  return (
    "#" +
    [r, g, b]
      .map((v) => clampByte(v).toString(16).padStart(2, "0"))
      .join("")
  );
}

/**
 * Blends `hex` toward white (`amount` > 0) or black (`amount` < 0) by
 * `|amount|` (0..1 fraction of the way there). Used to derive one extra step
 * of "raised" surface or "faint" text from a colour a theme already defines,
 * instead of asking every theme to hand-author two more near-duplicate
 * hex values.
 */
function mix(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  const target = amount >= 0 ? 255 : 0;
  const t = Math.min(1, Math.abs(amount));
  return rgbToHex(r + (target - r) * t, g + (target - g) * t, b + (target - b) * t);
}

/**
 * Expands a theme's hand-picked `base` fields (plus its terminal palette)
 * into the full 14-field `UIPalette`. See the `UIBase` doc comment above for
 * why this exists instead of every theme writing all 14 fields by hand.
 */
function deriveUi(base: UIBase, terminal: TerminalPalette, isDark: boolean): UIPalette {
  return {
    background: base.background,
    surface: base.surface,
    // "Raised" always means "a step closer to the viewer" — for a dark
    // theme that's lighter (closer to white); for a light theme it's
    // darker (closer to black), which is why the mix direction flips.
    // The light-side magnitude (0.12, matching dark's) is deliberately
    // NOT the original 0.06 — the light-theme audit that produced
    // LIGHT_SHADOW (tokens.ts) also found 0.06 too subtle to read as a
    // real second surface once the starting colour is already close to
    // white: a light theme's `surface` and `background` sit only ~1.1-1.3:1
    // apart to begin with (that's inherent to a light, low-saturation
    // palette, not a bug), so `surfaceRaised` needs the bigger step to read
    // as "a distinct card", not "the same cream with a rounding error".
    surfaceRaised: mix(base.surface, isDark ? 0.12 : -0.12),
    border: base.border,
    text: base.text,
    textMuted: base.textMuted,
    // Dimmer than textMuted, blended toward black on dark themes / toward
    // white on light themes so it recedes further in whichever direction
    // "further from the page" already means for this theme.
    textFaint: mix(base.textMuted, isDark ? -0.35 : 0.35),
    accent: base.accent,
    accentText: base.accentText,
    // Status colours are drawn straight from this theme's OWN ANSI palette
    // so they always look native to it, never like a foreign accent.
    ok: terminal.green,
    warn: terminal.yellow,
    danger: terminal.red,
    idle: base.textMuted,
    info: terminal.blue,
  };
}

/**
 * The built-in catalogue: "Void" (vibespace's own original look, carried over
 * unchanged from Phases 0-3), then long-established community editor and
 * terminal palettes — Dracula, Synthwave, Nord, Gruvbox, Tokyo Night,
 * Solarized and friends — plus five light options (Solarized Light, and
 * four more added in the light-theme pass: Gruvbox Light, One Light,
 * Catppuccin Latte, Ayu Light — each the real light counterpart to a dark
 * theme already in this list). 30 total.
 *
 * These are widely-used palettes from the wider ecosystem, not any single
 * product's proprietary set; each is our own transcription of a public
 * palette into the `ThemeDef` shape below.
 */
const THEME_DEFS: ThemeDef[] = [
  {
    id: "void",
    name: "Void",
    isDark: true,
    base: {
      background: "#0f1115",
      surface: "#1a1d24",
      border: "#2a2e37",
      text: "#e6e6e6",
      textMuted: "#9aa0a6",
      accent: "#2a6df4",
      accentText: "#ffffff",
    },
    terminal: {
      background: "#0f1115",
      foreground: "#e6e6e6",
      cursor: "#e6e6e6",
      cursorAccent: "#0f1115",
      selectionBackground: "#3a3f4b",
      black: "#1a1d24",
      red: "#f28b82",
      green: "#81c995",
      yellow: "#fdd663",
      blue: "#8ab4f8",
      magenta: "#c58af9",
      cyan: "#78d9ec",
      white: "#e6e6e6",
      brightBlack: "#5f6368",
      brightRed: "#f6aea9",
      brightGreen: "#a8dab5",
      brightYellow: "#fde293",
      brightBlue: "#aecbfa",
      brightMagenta: "#d7aefb",
      brightCyan: "#a1e4f5",
      brightWhite: "#ffffff",
    },
  },
  {
    id: "neon-tokyo",
    name: "Neon Tokyo",
    isDark: true,
    base: {
      background: "#0a0014",
      surface: "#150221",
      border: "#331a4d",
      text: "#f2e9ff",
      textMuted: "#9d7cc9",
      accent: "#ff2bd6",
      accentText: "#0a0014",
    },
    terminal: {
      background: "#0a0014",
      foreground: "#f2e9ff",
      cursor: "#ff2bd6",
      cursorAccent: "#0a0014",
      selectionBackground: "#3d1a5c",
      black: "#150221",
      red: "#ff2b6d",
      green: "#05f7a1",
      yellow: "#f7e935",
      blue: "#2be0ff",
      magenta: "#ff2bd6",
      cyan: "#05e5f7",
      white: "#f2e9ff",
      brightBlack: "#4d3366",
      brightRed: "#ff6b9d",
      brightGreen: "#6bffce",
      brightYellow: "#fff36b",
      brightBlue: "#7becff",
      brightMagenta: "#ff7bec",
      brightCyan: "#7bf3ff",
      brightWhite: "#ffffff",
    },
  },
  {
    id: "synthwave",
    name: "Synthwave",
    isDark: true,
    base: {
      background: "#1a1023",
      surface: "#241934",
      border: "#3e2a5c",
      text: "#f4eee8",
      textMuted: "#a68fc9",
      accent: "#ff7edb",
      accentText: "#1a1023",
    },
    terminal: {
      background: "#241b2f",
      foreground: "#f4eee8",
      cursor: "#ff7edb",
      cursorAccent: "#241b2f",
      selectionBackground: "#463465",
      black: "#241b2f",
      red: "#fe4450",
      green: "#72f1b8",
      yellow: "#fede5d",
      blue: "#03edf9",
      magenta: "#ff7edb",
      cyan: "#03edf9",
      white: "#f4eee8",
      brightBlack: "#495495",
      brightRed: "#ff7a93",
      brightGreen: "#b6ffe0",
      brightYellow: "#ffe9a0",
      brightBlue: "#7dfdfe",
      brightMagenta: "#ffb8ec",
      brightCyan: "#7dfdfe",
      brightWhite: "#ffffff",
    },
  },
  {
    id: "dracula",
    name: "Dracula",
    isDark: true,
    base: {
      background: "#282a36",
      surface: "#21222c",
      border: "#44475a",
      text: "#f8f8f2",
      textMuted: "#6272a4",
      accent: "#bd93f9",
      accentText: "#282a36",
    },
    terminal: {
      background: "#282a36",
      foreground: "#f8f8f2",
      cursor: "#f8f8f2",
      cursorAccent: "#282a36",
      selectionBackground: "#44475a",
      black: "#21222c",
      red: "#ff5555",
      green: "#50fa7b",
      yellow: "#f1fa8c",
      blue: "#bd93f9",
      magenta: "#ff79c6",
      cyan: "#8be9fd",
      white: "#f8f8f2",
      brightBlack: "#6272a4",
      brightRed: "#ff6e6e",
      brightGreen: "#69ff94",
      brightYellow: "#ffffa5",
      brightBlue: "#d6acff",
      brightMagenta: "#ff92df",
      brightCyan: "#a4ffff",
      brightWhite: "#ffffff",
    },
  },
  {
    id: "nord",
    name: "Nord",
    isDark: true,
    base: {
      background: "#2e3440",
      surface: "#3b4252",
      border: "#4c566a",
      text: "#eceff4",
      textMuted: "#d8dee9",
      accent: "#88c0d0",
      accentText: "#2e3440",
    },
    terminal: {
      background: "#2e3440",
      foreground: "#d8dee9",
      cursor: "#d8dee9",
      cursorAccent: "#2e3440",
      selectionBackground: "#434c5e",
      black: "#3b4252",
      red: "#bf616a",
      green: "#a3be8c",
      yellow: "#ebcb8b",
      blue: "#81a1c1",
      magenta: "#b48ead",
      cyan: "#88c0d0",
      white: "#e5e9f0",
      brightBlack: "#4c566a",
      brightRed: "#bf616a",
      brightGreen: "#a3be8c",
      brightYellow: "#ebcb8b",
      brightBlue: "#81a1c1",
      brightMagenta: "#b48ead",
      brightCyan: "#8fbcbb",
      brightWhite: "#eceff4",
    },
  },
  {
    id: "gruvbox-dark",
    name: "Gruvbox Dark",
    isDark: true,
    base: {
      background: "#282828",
      surface: "#3c3836",
      border: "#504945",
      text: "#ebdbb2",
      textMuted: "#a89984",
      accent: "#fe8019",
      accentText: "#282828",
    },
    terminal: {
      background: "#282828",
      foreground: "#ebdbb2",
      cursor: "#ebdbb2",
      cursorAccent: "#282828",
      selectionBackground: "#504945",
      black: "#282828",
      red: "#cc241d",
      green: "#98971a",
      yellow: "#d79921",
      blue: "#458588",
      magenta: "#b16286",
      cyan: "#689d6a",
      white: "#a89984",
      brightBlack: "#928374",
      brightRed: "#fb4934",
      brightGreen: "#b8bb26",
      brightYellow: "#fabd2f",
      brightBlue: "#83a598",
      brightMagenta: "#d3869b",
      brightCyan: "#8ec07c",
      brightWhite: "#ebdbb2",
    },
  },
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    isDark: true,
    base: {
      background: "#002b36",
      surface: "#073642",
      border: "#586e75",
      text: "#93a1a1",
      textMuted: "#657b83",
      accent: "#268bd2",
      accentText: "#002b36",
    },
    terminal: {
      background: "#002b36",
      foreground: "#839496",
      cursor: "#839496",
      cursorAccent: "#002b36",
      selectionBackground: "#073642",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#002b36",
      brightRed: "#cb4b16",
      brightGreen: "#586e75",
      brightYellow: "#657b83",
      brightBlue: "#839496",
      brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1",
      brightWhite: "#fdf6e3",
    },
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    isDark: true,
    base: {
      background: "#1a1b26",
      surface: "#24283b",
      border: "#414868",
      text: "#c0caf5",
      textMuted: "#565f89",
      accent: "#7aa2f7",
      accentText: "#1a1b26",
    },
    terminal: {
      background: "#1a1b26",
      foreground: "#c0caf5",
      cursor: "#c0caf5",
      cursorAccent: "#1a1b26",
      selectionBackground: "#33467c",
      black: "#15161e",
      red: "#f7768e",
      green: "#9ece6a",
      yellow: "#e0af68",
      blue: "#7aa2f7",
      magenta: "#bb9af7",
      cyan: "#7dcfff",
      white: "#a9b1d6",
      brightBlack: "#414868",
      brightRed: "#f7768e",
      brightGreen: "#9ece6a",
      brightYellow: "#e0af68",
      brightBlue: "#7aa2f7",
      brightMagenta: "#bb9af7",
      brightCyan: "#7dcfff",
      brightWhite: "#c0caf5",
    },
  },
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    isDark: true,
    base: {
      background: "#1e1e2e",
      surface: "#181825",
      border: "#313244",
      text: "#cdd6f4",
      textMuted: "#a6adc8",
      accent: "#cba6f7",
      accentText: "#1e1e2e",
    },
    terminal: {
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      cursor: "#f5e0dc",
      cursorAccent: "#1e1e2e",
      selectionBackground: "#585b70",
      black: "#45475a",
      red: "#f38ba8",
      green: "#a6e3a1",
      yellow: "#f9e2af",
      blue: "#89b4fa",
      magenta: "#f5c2e7",
      cyan: "#94e2d5",
      white: "#bac2de",
      brightBlack: "#585b70",
      brightRed: "#f38ba8",
      brightGreen: "#a6e3a1",
      brightYellow: "#f9e2af",
      brightBlue: "#89b4fa",
      brightMagenta: "#f5c2e7",
      brightCyan: "#94e2d5",
      brightWhite: "#a6adc8",
    },
  },
  {
    id: "one-dark",
    name: "One Dark",
    isDark: true,
    base: {
      background: "#282c34",
      surface: "#21252b",
      border: "#3e4451",
      text: "#abb2bf",
      textMuted: "#5c6370",
      accent: "#61afef",
      accentText: "#282c34",
    },
    terminal: {
      background: "#282c34",
      foreground: "#abb2bf",
      cursor: "#abb2bf",
      cursorAccent: "#282c34",
      selectionBackground: "#3e4451",
      black: "#282c34",
      red: "#e06c75",
      green: "#98c379",
      yellow: "#e5c07b",
      blue: "#61afef",
      magenta: "#c678dd",
      cyan: "#56b6c2",
      white: "#abb2bf",
      brightBlack: "#5c6370",
      brightRed: "#e06c75",
      brightGreen: "#98c379",
      brightYellow: "#e5c07b",
      brightBlue: "#61afef",
      brightMagenta: "#c678dd",
      brightCyan: "#56b6c2",
      brightWhite: "#ffffff",
    },
  },
  {
    id: "monokai",
    name: "Monokai",
    isDark: true,
    base: {
      background: "#272822",
      surface: "#1e1f1c",
      border: "#49483e",
      text: "#f8f8f2",
      textMuted: "#75715e",
      accent: "#a6e22e",
      accentText: "#272822",
    },
    terminal: {
      background: "#272822",
      foreground: "#f8f8f2",
      cursor: "#f8f8f0",
      cursorAccent: "#272822",
      selectionBackground: "#49483e",
      black: "#272822",
      red: "#f92672",
      green: "#a6e22e",
      yellow: "#e6db74",
      blue: "#66d9ef",
      magenta: "#ae81ff",
      cyan: "#a1efe4",
      white: "#f8f8f2",
      brightBlack: "#75715e",
      brightRed: "#f92672",
      brightGreen: "#a6e22e",
      brightYellow: "#e6db74",
      brightBlue: "#66d9ef",
      brightMagenta: "#ae81ff",
      brightCyan: "#a1efe4",
      brightWhite: "#f9f8f5",
    },
  },
  {
    id: "ayu-dark",
    name: "Ayu Dark",
    isDark: true,
    base: {
      background: "#0a0e14",
      surface: "#0d1017",
      border: "#1c212b",
      text: "#b3b1ad",
      textMuted: "#626a73",
      accent: "#e6b450",
      accentText: "#0a0e14",
    },
    terminal: {
      background: "#0a0e14",
      foreground: "#b3b1ad",
      cursor: "#e6b450",
      cursorAccent: "#0a0e14",
      selectionBackground: "#273747",
      black: "#01060e",
      red: "#ea6c73",
      green: "#91b362",
      yellow: "#f9af4f",
      blue: "#53bdfa",
      magenta: "#fae994",
      cyan: "#90e1c6",
      white: "#c7c7c7",
      brightBlack: "#686868",
      brightRed: "#f07178",
      brightGreen: "#c2d94c",
      brightYellow: "#ffb454",
      brightBlue: "#59c2ff",
      brightMagenta: "#ffee99",
      brightCyan: "#95e6cb",
      brightWhite: "#ffffff",
    },
  },
  {
    id: "rose-pine",
    name: "Rosé Pine",
    isDark: true,
    base: {
      background: "#191724",
      surface: "#1f1d2e",
      border: "#403d52",
      text: "#e0def4",
      textMuted: "#908caa",
      accent: "#c4a7e7",
      accentText: "#191724",
    },
    terminal: {
      background: "#191724",
      foreground: "#e0def4",
      cursor: "#e0def4",
      cursorAccent: "#191724",
      selectionBackground: "#403d52",
      black: "#26233a",
      red: "#eb6f92",
      green: "#31748f",
      yellow: "#f6c177",
      blue: "#9ccfd8",
      magenta: "#c4a7e7",
      cyan: "#ebbcba",
      white: "#e0def4",
      brightBlack: "#6e6a86",
      brightRed: "#eb6f92",
      brightGreen: "#31748f",
      brightYellow: "#f6c177",
      brightBlue: "#9ccfd8",
      brightMagenta: "#c4a7e7",
      brightCyan: "#ebbcba",
      brightWhite: "#e0def4",
    },
  },
  {
    id: "everforest",
    name: "Everforest",
    isDark: true,
    base: {
      background: "#2d353b",
      surface: "#343f44",
      border: "#475258",
      text: "#d3c6aa",
      textMuted: "#859289",
      accent: "#a7c080",
      accentText: "#2d353b",
    },
    terminal: {
      background: "#2d353b",
      foreground: "#d3c6aa",
      cursor: "#d3c6aa",
      cursorAccent: "#2d353b",
      selectionBackground: "#475258",
      black: "#4b565c",
      red: "#e67e80",
      green: "#a7c080",
      yellow: "#dbbc7f",
      blue: "#7fbbb3",
      magenta: "#d699b6",
      cyan: "#83c092",
      white: "#d3c6aa",
      brightBlack: "#859289",
      brightRed: "#e67e80",
      brightGreen: "#a7c080",
      brightYellow: "#dbbc7f",
      brightBlue: "#7fbbb3",
      brightMagenta: "#d699b6",
      brightCyan: "#83c092",
      brightWhite: "#fdf6e3",
    },
  },
  {
    id: "kanagawa",
    name: "Kanagawa",
    isDark: true,
    base: {
      background: "#1f1f28",
      surface: "#16161d",
      border: "#363646",
      text: "#dcd7ba",
      textMuted: "#727169",
      accent: "#7e9cd8",
      accentText: "#1f1f28",
    },
    terminal: {
      background: "#1f1f28",
      foreground: "#dcd7ba",
      cursor: "#c8c093",
      cursorAccent: "#1f1f28",
      selectionBackground: "#2d4f67",
      black: "#090618",
      red: "#c34043",
      green: "#76946a",
      yellow: "#c0a36e",
      blue: "#7e9cd8",
      magenta: "#957fb8",
      cyan: "#6a9589",
      white: "#c8c093",
      brightBlack: "#727169",
      brightRed: "#e82424",
      brightGreen: "#98bb6c",
      brightYellow: "#e6c384",
      brightBlue: "#7fb4ca",
      brightMagenta: "#938aa9",
      brightCyan: "#7aa89f",
      brightWhite: "#dcd7ba",
    },
  },
  {
    id: "night-owl",
    name: "Night Owl",
    isDark: true,
    base: {
      background: "#011627",
      surface: "#01111d",
      border: "#1d3b53",
      text: "#d6deeb",
      textMuted: "#637777",
      accent: "#82aaff",
      accentText: "#011627",
    },
    terminal: {
      background: "#011627",
      foreground: "#d6deeb",
      cursor: "#80a4c2",
      cursorAccent: "#011627",
      selectionBackground: "#1d3b53",
      black: "#011627",
      red: "#ef5350",
      green: "#22da6e",
      yellow: "#addb67",
      blue: "#82aaff",
      magenta: "#c792ea",
      cyan: "#21c7a8",
      white: "#d6deeb",
      brightBlack: "#575656",
      brightRed: "#ef5350",
      brightGreen: "#22da6e",
      brightYellow: "#ffeb95",
      brightBlue: "#82aaff",
      brightMagenta: "#c792ea",
      brightCyan: "#7fdbca",
      brightWhite: "#ffffff",
    },
  },
  {
    id: "material-ocean",
    name: "Material Ocean",
    isDark: true,
    base: {
      background: "#0f111a",
      surface: "#121420",
      border: "#2a2e42",
      text: "#8f93a2",
      textMuted: "#676e95",
      accent: "#82aaff",
      accentText: "#0f111a",
    },
    terminal: {
      background: "#0f111a",
      foreground: "#8f93a2",
      cursor: "#ffcc00",
      cursorAccent: "#0f111a",
      selectionBackground: "#2a2e42",
      black: "#0f111a",
      red: "#ff5370",
      green: "#c3e88d",
      yellow: "#ffcb6b",
      blue: "#82aaff",
      magenta: "#c792ea",
      cyan: "#89ddff",
      white: "#8f93a2",
      brightBlack: "#464b5d",
      brightRed: "#ff5370",
      brightGreen: "#c3e88d",
      brightYellow: "#ffcb6b",
      brightBlue: "#82aaff",
      brightMagenta: "#c792ea",
      brightCyan: "#89ddff",
      brightWhite: "#ffffff",
    },
  },
  {
    id: "cobalt2",
    name: "Cobalt2",
    isDark: true,
    base: {
      background: "#193549",
      surface: "#122738",
      border: "#1f4662",
      text: "#ffffff",
      textMuted: "#a2b6c5",
      accent: "#ffc600",
      accentText: "#193549",
    },
    terminal: {
      background: "#193549",
      foreground: "#ffffff",
      cursor: "#ffc600",
      cursorAccent: "#193549",
      selectionBackground: "#1f4662",
      black: "#000000",
      red: "#ff2222",
      green: "#a5ff90",
      yellow: "#ffc600",
      blue: "#338fff",
      magenta: "#ff5ec4",
      cyan: "#79e8fb",
      white: "#ffffff",
      brightBlack: "#565656",
      brightRed: "#f8531a",
      brightGreen: "#b6ff96",
      brightYellow: "#ffe870",
      brightBlue: "#9dcaff",
      brightMagenta: "#ff9dd8",
      brightCyan: "#b5f4fc",
      brightWhite: "#ffffff",
    },
  },
  {
    id: "panda",
    name: "Panda",
    isDark: true,
    base: {
      background: "#292a2b",
      surface: "#24262e",
      border: "#414452",
      text: "#e6e6e6",
      textMuted: "#676b79",
      accent: "#19f9d8",
      accentText: "#292a2b",
    },
    terminal: {
      background: "#292a2b",
      foreground: "#e6e6e6",
      cursor: "#19f9d8",
      cursorAccent: "#292a2b",
      selectionBackground: "#414452",
      black: "#292a2b",
      red: "#ff2c6d",
      green: "#19f9d8",
      yellow: "#ffb86c",
      blue: "#6fc1ff",
      magenta: "#ff75b5",
      cyan: "#45fef1",
      white: "#e6e6e6",
      brightBlack: "#676b79",
      brightRed: "#ff85b1",
      brightGreen: "#b6ffee",
      brightYellow: "#ffe6b3",
      brightBlue: "#b8e0ff",
      brightMagenta: "#ffb3d8",
      brightCyan: "#b1fff6",
      brightWhite: "#ffffff",
    },
  },
  {
    id: "horizon",
    name: "Horizon",
    isDark: true,
    base: {
      background: "#1c1e26",
      surface: "#232530",
      border: "#2e303e",
      text: "#e0e0e0",
      textMuted: "#6c6f93",
      accent: "#e95678",
      accentText: "#1c1e26",
    },
    terminal: {
      background: "#1c1e26",
      foreground: "#e0e0e0",
      cursor: "#e95678",
      cursorAccent: "#1c1e26",
      selectionBackground: "#2e303e",
      black: "#16161c",
      red: "#e95678",
      green: "#29d398",
      yellow: "#fab795",
      blue: "#26bbd9",
      magenta: "#ee64ae",
      cyan: "#59e1e3",
      white: "#e0e0e0",
      brightBlack: "#6c6f93",
      brightRed: "#ec6a88",
      brightGreen: "#3fdaa4",
      brightYellow: "#fbc3a7",
      brightBlue: "#3fc4de",
      brightMagenta: "#f075b8",
      brightCyan: "#6be4e6",
      brightWhite: "#f0f0f0",
    },
  },
  {
    id: "oceanic-next",
    name: "Oceanic Next",
    isDark: true,
    base: {
      background: "#1b2b34",
      surface: "#16242c",
      border: "#343d46",
      text: "#c0c5ce",
      textMuted: "#65737e",
      accent: "#6699cc",
      accentText: "#1b2b34",
    },
    terminal: {
      background: "#1b2b34",
      foreground: "#c0c5ce",
      cursor: "#c0c5ce",
      cursorAccent: "#1b2b34",
      selectionBackground: "#4f5b66",
      black: "#1b2b34",
      red: "#ec5f67",
      green: "#99c794",
      yellow: "#fac863",
      blue: "#6699cc",
      magenta: "#c594c5",
      cyan: "#5fb3b3",
      white: "#c0c5ce",
      brightBlack: "#65737e",
      brightRed: "#ec5f67",
      brightGreen: "#99c794",
      brightYellow: "#fac863",
      brightBlue: "#6699cc",
      brightMagenta: "#c594c5",
      brightCyan: "#5fb3b3",
      brightWhite: "#d8dee9",
    },
  },
  {
    id: "palenight",
    name: "Palenight",
    isDark: true,
    base: {
      background: "#292d3e",
      surface: "#232635",
      border: "#444267",
      text: "#d0d0e1",
      textMuted: "#676e95",
      accent: "#c792ea",
      accentText: "#292d3e",
    },
    terminal: {
      background: "#292d3e",
      foreground: "#d0d0e1",
      cursor: "#ffcc00",
      cursorAccent: "#292d3e",
      selectionBackground: "#444267",
      black: "#292d3e",
      red: "#f07178",
      green: "#c3e88d",
      yellow: "#ffcb6b",
      blue: "#82aaff",
      magenta: "#c792ea",
      cyan: "#89ddff",
      white: "#d0d0e1",
      brightBlack: "#676e95",
      brightRed: "#ff8b92",
      brightGreen: "#ddffa7",
      brightYellow: "#ffe585",
      brightBlue: "#9cc4ff",
      brightMagenta: "#e1acff",
      brightCyan: "#a3f7ff",
      brightWhite: "#ffffff",
    },
  },
  {
    id: "moonlight",
    name: "Moonlight",
    isDark: true,
    base: {
      background: "#212337",
      surface: "#191a2a",
      border: "#383a52",
      text: "#c8d3f5",
      textMuted: "#7a88cf",
      accent: "#82aaff",
      accentText: "#212337",
    },
    terminal: {
      background: "#212337",
      foreground: "#c8d3f5",
      cursor: "#82aaff",
      cursorAccent: "#212337",
      selectionBackground: "#383a52",
      black: "#1b1d2b",
      red: "#ff757f",
      green: "#c3e88d",
      yellow: "#ffc777",
      blue: "#82aaff",
      magenta: "#c099ff",
      cyan: "#86e1fc",
      white: "#828bb8",
      brightBlack: "#444a73",
      brightRed: "#ff98a4",
      brightGreen: "#c7fb6d",
      brightYellow: "#ffd8ab",
      brightBlue: "#9ab8ff",
      brightMagenta: "#caabff",
      brightCyan: "#b4f9f8",
      brightWhite: "#c8d3f5",
    },
  },
  {
    id: "city-lights",
    name: "City Lights",
    isDark: true,
    base: {
      background: "#1d252c",
      surface: "#171d23",
      border: "#2c3941",
      text: "#b7c5d3",
      textMuted: "#41505e",
      accent: "#5ec4ff",
      accentText: "#1d252c",
    },
    terminal: {
      background: "#1d252c",
      foreground: "#b7c5d3",
      cursor: "#b7c5d3",
      cursorAccent: "#1d252c",
      selectionBackground: "#2c3941",
      black: "#384552",
      red: "#d95468",
      green: "#8bd49c",
      yellow: "#ebbf83",
      blue: "#539afc",
      magenta: "#b62d65",
      cyan: "#70e1e8",
      white: "#b7c5d3",
      brightBlack: "#41505e",
      brightRed: "#e27a8f",
      brightGreen: "#abe0af",
      brightYellow: "#f0cc9f",
      brightBlue: "#6a9cf4",
      brightMagenta: "#c75d8a",
      brightCyan: "#90e6f7",
      brightWhite: "#d1d9e0",
    },
  },
  {
    id: "andromeda",
    name: "Andromeda",
    isDark: true,
    base: {
      background: "#23262e",
      surface: "#1e2025",
      border: "#363944",
      text: "#d5ced9",
      textMuted: "#666a73",
      accent: "#00e8c6",
      accentText: "#23262e",
    },
    terminal: {
      background: "#23262e",
      foreground: "#d5ced9",
      cursor: "#00e8c6",
      cursorAccent: "#23262e",
      selectionBackground: "#363944",
      black: "#23262e",
      red: "#ee5d43",
      green: "#96e072",
      yellow: "#ffe66d",
      blue: "#00e8c6",
      magenta: "#ff00aa",
      cyan: "#7cdfff",
      white: "#d5ced9",
      brightBlack: "#666a73",
      brightRed: "#ff6b5c",
      brightGreen: "#b3f6a0",
      brightYellow: "#ffef9c",
      brightBlue: "#67e8db",
      brightMagenta: "#ff5cc0",
      brightCyan: "#a2ecff",
      brightWhite: "#ffffff",
    },
  },
  {
    id: "solarized-light",
    name: "Solarized Light",
    isDark: false,
    // Light-theme audit: the original `base` here reused Solarized's own
    // `base2`/`base1` (#eee8d5/#93a1a1) verbatim for `surface`/`border` —
    // faithful to the source palette, but #93a1a1 on #fdf6e3 measures
    // 2.48:1, well under the ~3:1 a UI boundary needs to actually read as a
    // boundary (see themes.test.ts's "light themes meet contrast targets"
    // for the check that would have caught this). `border`/`textMuted`/
    // `accent` below are darkened just enough to clear AA while keeping
    // Solarized's recognisable cream/teal/blue identity — `text` and
    // `background` (the two colours that were already high-contrast) are
    // untouched, and the `terminal` palette (below) is untouched too, since
    // its own 16 ANSI slots were never the problem.
    base: {
      background: "#fdf6e3",
      surface: "#e9e1c9",
      border: "#4c6363",
      text: "#073642",
      textMuted: "#5a6e75",
      accent: "#1a6fa8",
      accentText: "#fdf6e3",
    },
    terminal: {
      background: "#fdf6e3",
      foreground: "#657b83",
      cursor: "#586e75",
      cursorAccent: "#fdf6e3",
      selectionBackground: "#eee8d5",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#002b36",
      brightRed: "#cb4b16",
      brightGreen: "#586e75",
      brightYellow: "#657b83",
      brightBlue: "#839496",
      brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1",
      brightWhite: "#fdf6e3",
    },
  },
  // --- Light themes (4 more, added alongside the Solarized Light fix) ----
  // Each pairs with a dark theme already above (Gruvbox Dark, One Dark,
  // Catppuccin Mocha, Ayu Dark) — real, established light variants of
  // schemes this catalogue already carries the dark half of, not an
  // invented one-off set. Same "our own transcription, not a pixel-exact
  // copy" spirit as every other entry in this file (see this file's own
  // top-of-catalogue comment): base hues are drawn from each scheme's real
  // published palette, but `border`/`textMuted`/`accent` are tuned to clear
  // AA against a light canvas specifically (a straight port of a published
  // "light mode" palette does NOT automatically clear WCAG AA — see the
  // Solarized Light comment above for the same lesson applied there).
  {
    id: "gruvbox-light",
    name: "Gruvbox Light",
    isDark: false,
    base: {
      background: "#fbf1c7",
      surface: "#e5d5ab",
      border: "#6b5f54",
      text: "#282828",
      textMuted: "#65594e",
      accent: "#af3a03",
      accentText: "#fbf1c7",
    },
    terminal: {
      // Gruvbox's ANSI accents (red/green/yellow/blue/magenta/cyan, both
      // normal and bright) are the same hex in light and dark mode by
      // design — only background/foreground/black/white/cursor differ.
      // Same "one 16-colour set, swap which end is background" convention
      // Solarized Dark/Light already use in this file.
      background: "#fbf1c7",
      foreground: "#3c3836",
      cursor: "#282828",
      cursorAccent: "#fbf1c7",
      selectionBackground: "#ebdbb2",
      black: "#282828",
      red: "#cc241d",
      green: "#98971a",
      yellow: "#d79921",
      blue: "#458588",
      magenta: "#b16286",
      cyan: "#689d6a",
      white: "#a89984",
      brightBlack: "#928374",
      brightRed: "#9d0006",
      brightGreen: "#79740e",
      brightYellow: "#b57614",
      brightBlue: "#076678",
      brightMagenta: "#8f3f71",
      brightCyan: "#427b58",
      brightWhite: "#f9f5d7",
    },
  },
  {
    id: "one-light",
    name: "One Light",
    isDark: false,
    base: {
      background: "#fafafa",
      surface: "#e6e6e8",
      border: "#6c6f79",
      text: "#383a42",
      textMuted: "#696c77",
      accent: "#2f5fc7",
      accentText: "#ffffff",
    },
    terminal: {
      background: "#fafafa",
      foreground: "#383a42",
      cursor: "#383a42",
      cursorAccent: "#fafafa",
      selectionBackground: "#e5e5e6",
      black: "#383a42",
      red: "#ca1243",
      green: "#50a14f",
      yellow: "#c18401",
      blue: "#4078f2",
      magenta: "#a626a4",
      cyan: "#0184bc",
      white: "#a0a1a7",
      brightBlack: "#696c77",
      brightRed: "#e45649",
      brightGreen: "#50a14f",
      brightYellow: "#c18401",
      brightBlue: "#4078f2",
      brightMagenta: "#a626a4",
      brightCyan: "#0184bc",
      brightWhite: "#f9f9f9",
    },
  },
  {
    id: "catppuccin-latte",
    name: "Catppuccin Latte",
    isDark: false,
    base: {
      background: "#eff1f5",
      surface: "#dfe2ea",
      border: "#666a82",
      text: "#4c4f69",
      textMuted: "#5c5f77",
      accent: "#1657d1",
      accentText: "#ffffff",
    },
    terminal: {
      background: "#eff1f5",
      foreground: "#4c4f69",
      cursor: "#dc8a78",
      cursorAccent: "#eff1f5",
      selectionBackground: "#bcc0cc",
      black: "#5c5f77",
      red: "#d20f39",
      green: "#40a02b",
      yellow: "#df8e1d",
      blue: "#1e66f5",
      magenta: "#ea76cb",
      cyan: "#179299",
      white: "#acb0be",
      brightBlack: "#6c6f85",
      brightRed: "#d20f39",
      brightGreen: "#40a02b",
      brightYellow: "#df8e1d",
      brightBlue: "#1e66f5",
      brightMagenta: "#ea76cb",
      brightCyan: "#179299",
      brightWhite: "#dce0e8",
    },
  },
  {
    id: "ayu-light",
    name: "Ayu Light",
    isDark: false,
    base: {
      background: "#fafafa",
      surface: "#eeeef0",
      border: "#666b72",
      text: "#3c4048",
      textMuted: "#5f6570",
      accent: "#b34e05",
      accentText: "#ffffff",
    },
    terminal: {
      background: "#fafafa",
      foreground: "#5c6166",
      // Ayu's signature bright-orange cursor — a flourish that only needs
      // to read clearly as a cursor block, not clear AA text contrast, so
      // it stays the vivid `#fa8d3e` rather than the darkened `accent`
      // above (which exists specifically for UI text/border/fill duty).
      cursor: "#fa8d3e",
      cursorAccent: "#fafafa",
      selectionBackground: "#e3e4e6",
      black: "#5c6166",
      red: "#f51818",
      green: "#86b300",
      yellow: "#f2ae49",
      blue: "#399ee6",
      magenta: "#a37acc",
      cyan: "#4cbf99",
      white: "#abb0b6",
      brightBlack: "#828c99",
      brightRed: "#ff6666",
      brightGreen: "#a6cc70",
      brightYellow: "#ffcc66",
      brightBlue: "#73b8ff",
      brightMagenta: "#c2a3e0",
      brightCyan: "#8cd9c0",
      brightWhite: "#f0f0f0",
    },
  },
];

/**
 * The catalogue every other module in the app actually imports: each
 * `ThemeDef`'s hand-picked `base` expanded, via `deriveUi`, into a complete
 * 14-field `UIPalette`. Doing this expansion once here (rather than inline
 * in each `ThemeDef`) is what keeps `THEME_DEFS` above readable — 30 themes
 * × 7 base fields, not 30 × 14.
 */
export const THEMES: Theme[] = THEME_DEFS.map((def) => ({
  id: def.id,
  name: def.name,
  isDark: def.isDark,
  ui: deriveUi(def.base, def.terminal, def.isDark),
  terminal: def.terminal,
}));

/** Fallback theme id used when nothing's been picked or a saved id is stale. */
export const DEFAULT_THEME_ID = "void";

/** Looks up a theme by id, falling back to the default if `id` is unknown
 * (e.g. a localStorage value left over from a theme that got renamed or
 * removed in a later release). */
export function getThemeById(id: string | null | undefined): Theme {
  const found = THEMES.find((t) => t.id === id);
  if (found) return found;
  // The default theme is always present in THEMES, so this never falls
  // through to `THEMES[0]` — but that fallback exists anyway as a last
  // resort in case DEFAULT_THEME_ID itself is ever mistyped.
  return THEMES.find((t) => t.id === DEFAULT_THEME_ID) ?? THEMES[0];
}

const THEME_STORAGE_KEY = "vibespace.theme";
// The pre-rename key this project shipped under as vibedeck — read as a
// fallback so a returning user's saved theme isn't lost on upgrade; see
// `legacyStorage.ts`'s top comment for the full "why" shared by all eight
// of this app's persisted preferences.
const LEGACY_THEME_STORAGE_KEY = "vibedeck.theme";

/** Reads the persisted theme id, or null if none is stored / storage isn't
 * available (e.g. a browser with localStorage disabled). */
export function loadStoredThemeId(): string | null {
  return readWithLegacyFallback(THEME_STORAGE_KEY, LEGACY_THEME_STORAGE_KEY);
}

/** Persists the chosen theme id so it survives a page reload. */
export function saveThemeId(id: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, id);
  } catch {
    // Storage full or disabled — the theme still applies for this session,
    // it just won't be remembered next time. Not worth surfacing to the user.
  }
}

/** Maps every `UIPalette` field to the CSS custom property that carries it. */
const CSS_VAR_NAMES: Record<keyof UIPalette, string> = {
  background: "--vd-bg",
  surface: "--vd-surface",
  surfaceRaised: "--vd-surface-raised",
  border: "--vd-border",
  text: "--vd-text",
  textMuted: "--vd-text-muted",
  textFaint: "--vd-text-faint",
  accent: "--vd-accent",
  accentText: "--vd-accent-text",
  ok: "--vd-ok",
  warn: "--vd-warn",
  danger: "--vd-danger",
  idle: "--vd-idle",
  info: "--vd-info",
};

/**
 * Applies a theme's UI palette to `:root` as CSS custom properties. Every
 * component's inline styles read these (`"var(--vd-bg)"` etc.) instead of a
 * hard-coded hex value, so calling this is the ONLY thing that needs to
 * happen for the whole app's chrome to re-colour — no per-component state.
 * Terminal panes are separate: see `Terminal.tsx`, which applies
 * `theme.terminal` directly to each live xterm instance.
 */
export function applyThemeCssVars(theme: Theme): void {
  const root = document.documentElement;
  for (const key of Object.keys(CSS_VAR_NAMES) as (keyof UIPalette)[]) {
    root.style.setProperty(CSS_VAR_NAMES[key], theme.ui[key]);
  }
  // Phase 9b's swarm canvas needs a "reviewer" role colour, and
  // docs/DESIGN.md §2 gives it as one flat literal (`#c084fc`) rather than a
  // per-theme token — no theme's `UIPalette` defines a "reviewer" colour of
  // its own, unlike coordinator/builder/scout, which reuse the existing
  // warn/ok/info status tokens. Setting it here, once, keeps that one
  // literal in a single place while still letting every component read it
  // as `var(--vd-role-reviewer)` instead of a hard-coded hex (see
  // `swarm/logic.ts`'s `roleColorVar`).
  root.style.setProperty("--vd-role-reviewer", "#c084fc");
  // Elevation shadows (tokens.ts's SHADOW/LIGHT_SHADOW): the ONE piece of
  // this file's CSS-var output that isn't a straight UIPalette field —
  // every component reads `SHADOW_VAR.sm/md/lg` ("var(--vd-shadow-sm)" etc,
  // see tokens.ts) instead of choosing between the two constants itself, so
  // switching themes re-tunes every box-shadow in the app the same way
  // switching accent colour re-tunes every border. See LIGHT_SHADOW's own
  // doc comment for why dark and light need genuinely different values, not
  // just a recolour.
  const shadow = theme.isDark ? SHADOW : LIGHT_SHADOW;
  root.style.setProperty("--vd-shadow-sm", shadow.sm);
  root.style.setProperty("--vd-shadow-md", shadow.md);
  root.style.setProperty("--vd-shadow-lg", shadow.lg);
}
