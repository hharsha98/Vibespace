/**
 * Resolves an xterm cell's colour (default / 16-colour palette / 256-colour
 * palette / true-colour RGB) to a CSS colour string, for `BlocksView.tsx`'s
 * xterm-buffer-to-`LineLike` adapter (see `lineRuns.ts`'s top comment for
 * why that adapter is kept separate from the pure `lineToRuns` itself).
 *
 * Pure function of its inputs — no xterm.js import, no DOM — so it's cheap
 * to unit test directly (`xtermPalette.test.ts`) even though the file that
 * actually CALLS it (`BlocksView.tsx`) isn't itself unit-testable under
 * CI's headless ubuntu-latest runner.
 *
 * docs/COLLAPSIBLE-BLOCKS.md: "Styling fidelity is good, not perfect." The
 * 16 base colours come from the ACTIVE THEME (`Theme.terminal`, the same
 * palette xterm itself is rendering with) so Live and Blocks views agree.
 * Indices 16-255 use the standard fixed xterm 256-colour cube/greyscale
 * ramp — vibedeck's themes don't customise those (only the 16 base ANSI
 * slots + background/foreground/cursor, per `themes.ts`'s `TerminalPalette`
 * — see that file), so replicating the standard formula here matches what
 * xterm itself renders.
 */
import type { TerminalPalette } from "../themes/themes.js";

/** Which of xterm's three colour representations a cell's fg/bg is using —
 * mirrors `IBufferCell.isFgDefault()`/`isFgPalette()`/`isFgRGB()` (and the
 * bg equivalents), collapsed into one tag the caller passes in after
 * checking those three booleans. */
export type XtermColorMode = "default" | "palette" | "rgb";

const ANSI_16_KEYS: readonly (keyof TerminalPalette)[] = [
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

/** The 6 intensity levels the standard xterm 256-colour cube (indices
 * 16-231) steps each of R/G/B through — NOT evenly spaced (0, 51, 102, ...)
 * — this exact sequence is the long-standing xterm convention every
 * terminal emulator's 256-colour palette agrees on. */
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const;

function paletteColor(index: number, theme: TerminalPalette): string {
  if (index < 16) {
    return theme[ANSI_16_KEYS[index]];
  }
  if (index < 232) {
    const n = index - 16;
    const r = CUBE_LEVELS[Math.floor(n / 36)];
    const g = CUBE_LEVELS[Math.floor((n % 36) / 6)];
    const b = CUBE_LEVELS[n % 6];
    return `rgb(${r}, ${g}, ${b})`;
  }
  // 232-255: a 24-step greyscale ramp, darkest to lightest.
  const gray = 8 + (index - 232) * 10;
  return `rgb(${gray}, ${gray}, ${gray})`;
}

/**
 * Resolves one cell colour to a CSS string, or `null` for "default" (which
 * `BlocksView.tsx` leaves unstyled so it inherits the card's own
 * foreground/background rather than hard-coding a colour that might not
 * match the active theme).
 */
export function resolveXtermColor(mode: XtermColorMode, value: number, theme: TerminalPalette): string | null {
  switch (mode) {
    case "default":
      return null;
    case "rgb": {
      const r = (value >> 16) & 0xff;
      const g = (value >> 8) & 0xff;
      const b = value & 0xff;
      return `rgb(${r}, ${g}, ${b})`;
    }
    case "palette":
      return paletteColor(value, theme);
  }
}
