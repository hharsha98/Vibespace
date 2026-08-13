import { describe, expect, it } from "vitest";
import {
  DEFAULT_BLOCK_LINE_CAP,
  lineToRuns,
  planBlockCap,
  resolveBlockRange,
  type CellLike,
  type LineLike,
} from "./lineRuns.js";

/** Builds a `LineLike` out of a plain array of cells — the whole point of
 * `lineToRuns` taking a minimal structural type instead of a real xterm
 * `IBufferLine` (see lineRuns.ts's top comment). */
function makeLine(cells: CellLike[]): LineLike {
  return {
    length: cells.length,
    cellAt: (x) => cells[x],
  };
}

const PLAIN = { bold: false, italic: false, underline: false, inverse: false, fg: null, bg: null };

function cell(chars: string, overrides: Partial<CellLike> = {}): CellLike {
  return { chars, width: 1, ...PLAIN, ...overrides };
}

describe("lineToRuns", () => {
  it("coalesces a run of identically-styled cells into one span", () => {
    const line = makeLine([cell("h"), cell("i")]);
    expect(lineToRuns(line)).toEqual([{ text: "hi", ...PLAIN }]);
  });

  it("splits into separate runs when style changes", () => {
    const line = makeLine([cell("a", { bold: true }), cell("b", { bold: true }), cell("c")]);
    expect(lineToRuns(line)).toEqual([
      { text: "ab", ...PLAIN, bold: true },
      { text: "c", ...PLAIN },
    ]);
  });

  it("treats an empty cell (no chars) as a single space", () => {
    const line = makeLine([cell(""), cell("x")]);
    expect(lineToRuns(line)).toEqual([{ text: " x", ...PLAIN }]);
  });

  it("skips width-0 cells (the trailing half of a wide character)", () => {
    // A CJK character occupies two columns: a width-2 cell holding the
    // glyph, followed by a width-0 "continuation" cell that must contribute
    // nothing of its own.
    const line = makeLine([cell("字", { width: 2 }), cell("", { width: 0 }), cell("!")]);
    expect(lineToRuns(line)).toEqual([{ text: "字!", ...PLAIN }]);
  });

  it("distinguishes every style flag independently", () => {
    const line = makeLine([
      cell("a", { italic: true }),
      cell("b", { underline: true }),
      cell("c", { inverse: true }),
    ]);
    const runs = lineToRuns(line);
    expect(runs).toHaveLength(3);
    expect(runs[0]).toMatchObject({ text: "a", italic: true, underline: false });
    expect(runs[1]).toMatchObject({ text: "b", italic: false, underline: true });
    expect(runs[2]).toMatchObject({ text: "c", inverse: true });
  });

  it("distinguishes runs by resolved fg/bg colour", () => {
    const line = makeLine([
      cell("r", { fg: "rgb(255, 0, 0)" }),
      cell("g", { fg: "rgb(0, 255, 0)" }),
      cell("!", { fg: "rgb(0, 255, 0)" }),
    ]);
    const runs = lineToRuns(line);
    expect(runs).toEqual([
      { text: "r", ...PLAIN, fg: "rgb(255, 0, 0)" },
      { text: "g!", ...PLAIN, fg: "rgb(0, 255, 0)" },
    ]);
  });

  it("trims a trailing run of unstyled padding spaces", () => {
    const line = makeLine([cell("h"), cell("i"), cell(" "), cell(" "), cell(" ")]);
    expect(lineToRuns(line)).toEqual([{ text: "hi", ...PLAIN }]);
  });

  it("does NOT trim trailing spaces that carry real styling (e.g. a highlighted blank)", () => {
    const line = makeLine([cell("h"), cell(" ", { bg: "rgb(255, 0, 0)" })]);
    expect(lineToRuns(line)).toEqual([
      { text: "h", ...PLAIN },
      { text: " ", ...PLAIN, bg: "rgb(255, 0, 0)" },
    ]);
  });

  it("an entirely blank line produces no runs at all", () => {
    const line = makeLine([cell(" "), cell(" "), cell(" ")]);
    expect(lineToRuns(line)).toEqual([]);
  });

  it("handles an empty line", () => {
    expect(lineToRuns(makeLine([]))).toEqual([]);
  });

  it("skips missing cells (undefined) without throwing", () => {
    const line: LineLike = { length: 3, cellAt: (x) => (x === 1 ? cell("x") : undefined) };
    expect(() => lineToRuns(line)).not.toThrow();
    expect(lineToRuns(line)).toEqual([{ text: "x", ...PLAIN }]);
  });
});

describe("planBlockCap", () => {
  it("does not cap a block under the threshold", () => {
    expect(planBlockCap(10)).toEqual({ capped: false });
    expect(planBlockCap(DEFAULT_BLOCK_LINE_CAP * 2)).toEqual({ capped: false });
  });

  it("caps a block just over the threshold", () => {
    const plan = planBlockCap(DEFAULT_BLOCK_LINE_CAP * 2 + 1);
    expect(plan).toEqual({
      capped: true,
      headLines: DEFAULT_BLOCK_LINE_CAP,
      tailLines: DEFAULT_BLOCK_LINE_CAP,
      hiddenLines: 1,
    });
  });

  it("caps a 50,000-line build log correctly", () => {
    const plan = planBlockCap(50_000);
    expect(plan).toEqual({
      capped: true,
      headLines: 500,
      tailLines: 500,
      hiddenLines: 49_000,
    });
  });

  it("honours a custom cap", () => {
    expect(planBlockCap(25, 10)).toEqual({ capped: true, headLines: 10, tailLines: 10, hiddenLines: 5 });
    expect(planBlockCap(20, 10)).toEqual({ capped: false });
  });
});

describe("resolveBlockRange", () => {
  it("a command with no output at all: end marker lands on the same line as start, producing an empty range", () => {
    // `false`: nothing was ever written, so OSC 133 "D" fires with the
    // cursor still sitting on the exact line startLine already points at.
    const range = resolveBlockRange({
      startLine: 10,
      finished: true,
      endMarkerLine: 10,
      bufferLastLine: 999,
      cursorLine: 999,
    });
    expect(range).toEqual({ startLine: 10, endLine: 9 });
    expect(range.endLine).toBeLessThan(range.startLine); // callers must render this as { kind: "empty" }
  });

  it("a command with exactly one line of output ('echo hi'): end marker is exclusive of that one line's successor", () => {
    // "hi" is written on line 10; the cursor (and thus the end marker) is
    // one line further down, on the blank line the next prompt will occupy.
    const range = resolveBlockRange({
      startLine: 10,
      finished: true,
      endMarkerLine: 11,
      bufferLastLine: 999,
      cursorLine: 999,
    });
    expect(range).toEqual({ startLine: 10, endLine: 10 }); // exactly one body line
  });

  it("a command with 3 lines of output spans exactly those 3 lines, excluding the trailing prompt line", () => {
    const range = resolveBlockRange({
      startLine: 10,
      finished: true,
      endMarkerLine: 13,
      bufferLastLine: 999,
      cursorLine: 999,
    });
    expect(range).toEqual({ startLine: 10, endLine: 12 });
    expect(range.endLine - range.startLine + 1).toBe(3);
  });

  it("falls back to the buffer's last line when the end marker is gone (disposed/evicted), not to `cursorLine`", () => {
    const range = resolveBlockRange({
      startLine: 10,
      finished: true,
      endMarkerLine: null,
      bufferLastLine: 50,
      cursorLine: 999,
    });
    expect(range).toEqual({ startLine: 10, endLine: 50 });
  });

  it("a still-running block (no 'D' yet) renders through the current cursor line, INCLUSIVE — not the exclusive end-marker rule", () => {
    const range = resolveBlockRange({
      startLine: 10,
      finished: false,
      endMarkerLine: null,
      bufferLastLine: 999,
      cursorLine: 14,
    });
    expect(range).toEqual({ startLine: 10, endLine: 14 });
  });
});
