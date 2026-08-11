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
  it("has at least 25 themes", () => {
    expect(THEMES.length).toBeGreaterThanOrEqual(25);
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

  it("gives every theme a complete UI palette with valid hex colours", () => {
    const uiFields = ["background", "surface", "border", "text", "textMuted", "accent", "accentText"] as const;
    for (const theme of THEMES) {
      for (const field of uiFields) {
        const value = theme.ui[field];
        expect(value, `${theme.name}.ui.${field} should be a non-empty string`).toBeTruthy();
        expect(HEX_COLOR.test(value), `${theme.name}.ui.${field} = "${value}" is not a valid hex colour`).toBe(
          true
        );
      }
    }
  });

  it("includes at least one light theme alongside the dark-first majority", () => {
    const lightThemes = THEMES.filter((t) => !t.isDark);
    const darkThemes = THEMES.filter((t) => t.isDark);
    expect(lightThemes.length).toBeGreaterThanOrEqual(1);
    expect(darkThemes.length).toBeGreaterThan(lightThemes.length);
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
