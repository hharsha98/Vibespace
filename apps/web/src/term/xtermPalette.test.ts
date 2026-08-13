import { describe, expect, it } from "vitest";
import { resolveXtermColor } from "./xtermPalette.js";
import type { TerminalPalette } from "../themes/themes.js";

const THEME: TerminalPalette = {
  background: "#000000",
  foreground: "#ffffff",
  cursor: "#ffffff",
  cursorAccent: "#000000",
  selectionBackground: "#333333",
  black: "#111111",
  red: "#aa0000",
  green: "#00aa00",
  yellow: "#aaaa00",
  blue: "#0000aa",
  magenta: "#aa00aa",
  cyan: "#00aaaa",
  white: "#aaaaaa",
  brightBlack: "#555555",
  brightRed: "#ff5555",
  brightGreen: "#55ff55",
  brightYellow: "#ffff55",
  brightBlue: "#5555ff",
  brightMagenta: "#ff55ff",
  brightCyan: "#55ffff",
  brightWhite: "#ffffff",
};

describe("resolveXtermColor", () => {
  it("default mode always resolves to null", () => {
    expect(resolveXtermColor("default", 0, THEME)).toBeNull();
    expect(resolveXtermColor("default", 255, THEME)).toBeNull();
  });

  it("rgb mode decodes a packed 0xRRGGBB integer", () => {
    expect(resolveXtermColor("rgb", 0xff0000, THEME)).toBe("rgb(255, 0, 0)");
    expect(resolveXtermColor("rgb", 0x00ff00, THEME)).toBe("rgb(0, 255, 0)");
    expect(resolveXtermColor("rgb", 0x0000ff, THEME)).toBe("rgb(0, 0, 255)");
    expect(resolveXtermColor("rgb", 0x123456, THEME)).toBe("rgb(18, 52, 86)");
  });

  it("palette indices 0-15 resolve to the active theme's ANSI colours", () => {
    expect(resolveXtermColor("palette", 0, THEME)).toBe(THEME.black);
    expect(resolveXtermColor("palette", 1, THEME)).toBe(THEME.red);
    expect(resolveXtermColor("palette", 7, THEME)).toBe(THEME.white);
    expect(resolveXtermColor("palette", 8, THEME)).toBe(THEME.brightBlack);
    expect(resolveXtermColor("palette", 15, THEME)).toBe(THEME.brightWhite);
  });

  it("palette index 16 is the start of the 6x6x6 colour cube (pure black)", () => {
    expect(resolveXtermColor("palette", 16, THEME)).toBe("rgb(0, 0, 0)");
  });

  it("palette index 231 is the end of the colour cube (pure white)", () => {
    expect(resolveXtermColor("palette", 231, THEME)).toBe("rgb(255, 255, 255)");
  });

  it("palette indices 232-255 are a greyscale ramp", () => {
    expect(resolveXtermColor("palette", 232, THEME)).toBe("rgb(8, 8, 8)");
    expect(resolveXtermColor("palette", 255, THEME)).toBe("rgb(238, 238, 238)");
  });
});
