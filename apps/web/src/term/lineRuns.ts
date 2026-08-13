/**
 * Pure helpers behind the Blocks view's HTML renderer (Phase 9.5a, part 2 —
 * docs/COLLAPSIBLE-BLOCKS.md): turning one terminal line's cells into a
 * short list of same-styled "runs" (so a 200-column line becomes a handful
 * of `<span>`s instead of 200), plus the "cap enormous blocks" math.
 *
 * Deliberately pure and DOM/xterm-free: `lineToRuns` takes a minimal
 * `LineLike` structure — not a real `@xterm/xterm` `IBufferLine` — so
 * `lineRuns.test.ts` can build one out of plain arrays under Node/vitest,
 * with no terminal instance anywhere. The REAL adapter that turns an actual
 * xterm buffer line into a `LineLike` (reading `getCell`, resolving palette
 * colours against the active theme, etc.) lives in `BlocksView.tsx`, which
 * is DOM/xterm-dependent and therefore untested under CI's headless
 * ubuntu-latest runner — see that file's top comment.
 */

/** One terminal cell, reduced to exactly what the Blocks view needs to
 * render it: the character(s) it holds, its style flags, and its resolved
 * colours as CSS-ready strings (or `null` for "the terminal's default",
 * which the renderer leaves unstyled so it inherits the card's own
 * foreground/background instead of hard-coding a colour). */
export interface CellLike {
  /** The cell's character(s) — normally one, but can be a combined
   * grapheme (e.g. an emoji with a modifier). Empty string for a truly
   * blank cell, which `lineToRuns` treats as a single space. */
  chars: string;
  /** `1` for a normal cell, `2` for the leading half of a wide (e.g. CJK)
   * character, `0` for that character's trailing half — mirrors
   * `IBufferCell.getWidth()`. A width-0 cell contributes nothing of its
   * own; its content is already part of the preceding width-2 cell. */
  width: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  /** Resolved CSS colour (e.g. `"rgb(255, 0, 0)"`), or `null` for "use the
   * terminal's default foreground" — never a raw ANSI palette index. */
  fg: string | null;
  bg: string | null;
}

/** A minimal stand-in for `@xterm/xterm`'s `IBufferLine`, just the two
 * operations `lineToRuns` actually needs. */
export interface LineLike {
  /** Number of columns this line has cells for. */
  length: number;
  /** The cell at column `x`, or `undefined` past the line's real content
   * (mirrors `IBufferLine.getCell`, which returns `undefined` beyond
   * `length`). */
  cellAt(x: number): CellLike | undefined;
}

/** One contiguous run of cells sharing identical styling — what actually
 * becomes a single `<span>` in the Blocks view. */
export interface StyledRun {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  fg: string | null;
  bg: string | null;
}

function sameStyle(a: StyledRun, b: CellLike): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.inverse === b.inverse &&
    a.fg === b.fg &&
    a.bg === b.bg
  );
}

/**
 * Coalesces one line's cells into styled runs, column by column. Width-0
 * cells (the trailing half of a wide character) are skipped — their
 * content already lives in the preceding cell's `chars`.
 *
 * xterm pads every row out to the terminal's full column count with blank
 * cells, so without trimming, EVERY line would render a wall of trailing
 * literal spaces (and copy that way too). The trailing spaces on the
 * line's LAST run are stripped — but only when that run has no background
 * colour and isn't inverse-video, i.e. only when the blank padding
 * wouldn't actually be visible as a coloured bar if left untrimmed (see
 * the "does NOT trim... highlighted blank" test). If trimming empties the
 * run entirely, it's dropped, so a wholly-blank line produces no runs.
 */
export function lineToRuns(line: LineLike): StyledRun[] {
  const runs: StyledRun[] = [];
  let current: StyledRun | null = null;

  for (let x = 0; x < line.length; x++) {
    const cell = line.cellAt(x);
    if (!cell || cell.width === 0) continue;

    const chars = cell.chars.length > 0 ? cell.chars : " ";

    if (current && sameStyle(current, cell)) {
      current.text += chars;
      continue;
    }

    current = {
      text: chars,
      bold: cell.bold,
      italic: cell.italic,
      underline: cell.underline,
      inverse: cell.inverse,
      fg: cell.fg,
      bg: cell.bg,
    };
    runs.push(current);
  }

  const last = runs[runs.length - 1];
  if (last && last.bg === null && !last.inverse) {
    const trimmed = last.text.replace(/ +$/, "");
    if (trimmed.length === 0) {
      runs.pop();
    } else {
      last.text = trimmed;
    }
  }

  return runs;
}

// --- Capping enormous blocks ---------------------------------------------
//
// docs/COLLAPSIBLE-BLOCKS.md: "A build log can be 50,000 lines; that many
// DOM nodes will kill the tab. Render the first and last 500 lines with a
// 'show all N lines' control between them."

/** Default per-side line cap — see the module comment above. */
export const DEFAULT_BLOCK_LINE_CAP = 500;

/** A block's line count fits under `2 * cap`, so no capping is needed —
 * every line renders. */
export interface UncappedPlan {
  capped: false;
}

/** A block's line count exceeds `2 * cap` — render only the first
 * `headLines` and last `tailLines` (both equal to `cap`, unless the caller
 * used a smaller custom cap), with `hiddenLines` lines omitted between
 * them. */
export interface CappedPlan {
  capped: true;
  headLines: number;
  tailLines: number;
  hiddenLines: number;
}

export type BlockCapPlan = UncappedPlan | CappedPlan;

/**
 * Pure planning function for the head/tail cap: given a block's total line
 * count, decide whether it needs capping and, if so, how many lines go in
 * each visible slice. Never touches xterm or the DOM — `BlocksView.tsx` is
 * the one that actually reads/renders the resulting line ranges.
 */
export function planBlockCap(totalLines: number, cap: number = DEFAULT_BLOCK_LINE_CAP): BlockCapPlan {
  if (totalLines <= cap * 2) return { capped: false };
  return {
    capped: true,
    headLines: cap,
    tailLines: cap,
    hiddenLines: totalLines - cap * 2,
  };
}

// --- Block line-range resolution ------------------------------------------
//
// Pulled out of BlocksView.tsx's `buildBlockRender` for the same reason as
// `lineToRuns`/`planBlockCap` above: pure, no xterm/DOM involved, so the
// exclusive-end-marker math below (a real bug found by hand-testing) is
// covered under plain Node/vitest instead of only ever being exercised in a
// real browser.

export interface BlockRangeInput {
  /** The block's start marker's CURRENT line (`markers.marker.line`). */
  startLine: number;
  /** `block.endLine !== null` — the block has finished (an OSC 133 "D" was
   * seen for it), as opposed to still running. */
  finished: boolean;
  /** The live end marker's CURRENT line, or `null` if there's no usable
   * live end marker (never registered, or since disposed/evicted). Only
   * consulted when `finished` is true. */
  endMarkerLine: number | null;
  /** `term.buffer.active.length - 1` — the fallback end line used for a
   * finished block whose end marker is gone. */
  bufferLastLine: number;
  /** `term.buffer.active.baseY + term.buffer.active.cursorY` — used only
   * while the block is still running (`finished: false`). */
  cursorLine: number;
}

/**
 * Resolves a block's `[startLine, endLine]` range — the lines to actually
 * read out of xterm's buffer.
 *
 * The one non-obvious piece: a FINISHED block's end marker line is
 * EXCLUSIVE, not inclusive. zsh's precmd fires OSC 133 "D" after the
 * command has finished but before the next prompt is drawn, and
 * Terminal.tsx registers the end marker at the cursor's position right
 * then — which is exactly where the NEXT prompt is about to be written,
 * not part of this command's own output. Subtracting 1 excludes it; a
 * command that produced no output at all (its end marker lands on the same
 * line `startLine` already points at) then correctly yields `endLine <
 * startLine`, which callers should render as an empty block rather than
 * clamping the range and showing the next prompt's line as if it were this
 * block's content.
 */
export function resolveBlockRange(input: BlockRangeInput): { startLine: number; endLine: number } {
  const endLine = input.finished
    ? input.endMarkerLine !== null
      ? input.endMarkerLine - 1
      : input.bufferLastLine
    : // Still running, no "D" yet: render everything written so far, up to
      // wherever the cursor currently is.
      input.cursorLine;
  return { startLine: input.startLine, endLine };
}
