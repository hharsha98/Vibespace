import { describe, expect, it } from "vitest";
import { DEFAULT_THEME_ID, THEMES, getThemeById, type TerminalPalette } from "./themes.js";

/** Every field a complete terminal palette must define — the 16 ANSI slots
 * plus the four non-ANSI ones. Listed explicitly (rather than derived from
 * the TS type, which doesn't exist at runtime) so this test still catches a
 * half-filled palette even if `TerminalPalette`'s fields were ever
 * loosened to optional. */
const REQUIRED_TERMINAL_FIELDS: (keyof TerminalPalette)[] = [
  "background",
  "foreground",
  "cursor",
  "selectionBackground",
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
];

/** A valid CSS hex colour: #rgb, #rgba, #rrggbb, or #rrggbbaa. */
const HEX_COLOR = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

describe("THEMES", () => {
  it("has at least 30 themes", () => {
    expect(THEMES.length).toBeGreaterThanOrEqual(30);
  });

  it("gives every theme a unique id", () => {
    const ids = THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every theme a unique name", () => {
    const names = THEMES.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("defines every one of the 16 ANSI colours plus background/foreground/cursor for every theme", () => {
    for (const theme of THEMES) {
      for (const field of REQUIRED_TERMINAL_FIELDS) {
        const value = theme.terminal[field];
        expect(value, `${theme.name}.terminal.${field} should be a non-empty string`).toBeTruthy();
        expect(
          HEX_COLOR.test(value),
          `${theme.name}.terminal.${field} = "${value}" is not a valid hex colour`
        ).toBe(true);
      }
    }
  });

  // Every field of UIPalette (see themes.ts) — listed explicitly, same
  // reasoning as REQUIRED_TERMINAL_FIELDS above: this is the test that
  // would catch a theme left half-migrated onto the full Phase 4.5 token
  // set (e.g. an entry missing `surfaceRaised` or one of the status
  // colours) even if the TS type were ever loosened to allow it.
  const REQUIRED_UI_FIELDS = [
    "background",
    "surface",
    "surfaceRaised",
    "border",
    "text",
    "textMuted",
    "textFaint",
    "accent",
    "accentText",
    "ok",
    "warn",
    "danger",
    "idle",
    "info",
  ] as const;

  it("gives every theme a complete UI palette with valid hex colours", () => {
    for (const theme of THEMES) {
      for (const field of REQUIRED_UI_FIELDS) {
        const value = theme.ui[field];
        expect(value, `${theme.name}.ui.${field} should be a non-empty string`).toBeTruthy();
        expect(HEX_COLOR.test(value), `${theme.name}.ui.${field} = "${value}" is not a valid hex colour`).toBe(
          true
        );
      }
    }
  });

  it("includes a real set of light themes alongside the dark-first majority", () => {
    // Was "at least 1" before the light-theme pass (Solarized Light, alone,
    // was the exact "token gesture, not a real choice" bug this pass fixes)
    // — now at least 5 (Solarized Light + Gruvbox Light + One Light +
    // Catppuccin Latte + Ayu Light), still comfortably outnumbered by the
    // dark catalogue per this app's dark-first identity.
    const lightThemes = THEMES.filter((t) => !t.isDark);
    const darkThemes = THEMES.filter((t) => t.isDark);
    expect(lightThemes.length).toBeGreaterThanOrEqual(5);
    expect(darkThemes.length).toBeGreaterThan(lightThemes.length);
  });
});

// --- Light-theme contrast (the class of bug that shipped Solarized Light
// with a 1.14:1 surface-vs-background and a 2.48:1 border-vs-background —
// both silently "valid hex colours" by every check above, and both
// invisible in an actual screenshot) -----------------------------------
//
// A small, dependency-free WCAG relative-luminance/contrast-ratio
// implementation, deliberately NOT imported from themes.ts's own private
// `hexToRgb` (that function isn't exported, and re-deriving the maths here
// keeps this test honest — it isn't allowed to share a bug with the code it
// exists to catch).

function hexToRgbForContrast(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const num = parseInt(full.slice(0, 6), 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgbForContrast(hex).map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The standard WCAG 2.x contrast-ratio formula: (L1 + 0.05) / (L2 + 0.05),
 * lighter over darker, always >= 1. */
function wcagContrast(hexA: string, hexB: string): number {
  const lA = relativeLuminance(hexA);
  const lB = relativeLuminance(hexB);
  const lighter = Math.max(lA, lB);
  const darker = Math.min(lA, lB);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("light theme contrast (WCAG AA, roughly)", () => {
  const lightThemes = THEMES.filter((t) => !t.isDark);

  it("has at least one light theme to check (guards against this suite silently checking nothing)", () => {
    expect(lightThemes.length).toBeGreaterThan(0);
  });

  it("keeps primary text at >= 4.5:1 against both the canvas and the raised card surface", () => {
    for (const theme of lightThemes) {
      const { background, surface, surfaceRaised, text } = theme.ui;
      expect(wcagContrast(text, background), `${theme.name}: text vs background`).toBeGreaterThanOrEqual(4.5);
      expect(wcagContrast(text, surface), `${theme.name}: text vs surface`).toBeGreaterThanOrEqual(4.5);
      expect(wcagContrast(text, surfaceRaised), `${theme.name}: text vs surfaceRaised`).toBeGreaterThanOrEqual(
        4.5
      );
    }
  });

  it("keeps secondary (muted) text at >= 4.5:1 against the canvas — this is what 'Ready'/status-line text reads at", () => {
    for (const theme of lightThemes) {
      const { background, textMuted } = theme.ui;
      expect(wcagContrast(textMuted, background), `${theme.name}: textMuted vs background`).toBeGreaterThanOrEqual(
        4.5
      );
    }
  });

  it("keeps secondary (muted) text at >= 3:1 against the raised card surface it appears on", () => {
    for (const theme of lightThemes) {
      const { surfaceRaised, textMuted } = theme.ui;
      expect(
        wcagContrast(textMuted, surfaceRaised),
        `${theme.name}: textMuted vs surfaceRaised`
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps borders at >= 3:1 against the background — the exact bug that shipped an invisible Solarized Light border", () => {
    for (const theme of lightThemes) {
      const { background, border } = theme.ui;
      expect(wcagContrast(border, background), `${theme.name}: border vs background`).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps the accent at >= 4.5:1 against accentText — the primary-button label must stay legible", () => {
    for (const theme of lightThemes) {
      const { accent, accentText } = theme.ui;
      expect(wcagContrast(accent, accentText), `${theme.name}: accent vs accentText`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("gives surfaceRaised genuine separation from background — catches the 1.14:1 'cards vanish into the canvas' bug directly", () => {
    for (const theme of lightThemes) {
      const { background, surfaceRaised } = theme.ui;
      expect(
        wcagContrast(surfaceRaised, background),
        `${theme.name}: surfaceRaised vs background`
      ).toBeGreaterThanOrEqual(1.35);
    }
  });
});

describe("getThemeById", () => {
  it("finds a theme by its exact id", () => {
    expect(getThemeById("dracula").name).toBe("Dracula");
  });

  it("falls back to the default theme for an unknown id", () => {
    expect(getThemeById("not-a-real-theme").id).toBe(DEFAULT_THEME_ID);
  });

  it("falls back to the default theme for null/undefined", () => {
    expect(getThemeById(null).id).toBe(DEFAULT_THEME_ID);
    expect(getThemeById(undefined).id).toBe(DEFAULT_THEME_ID);
  });
});
