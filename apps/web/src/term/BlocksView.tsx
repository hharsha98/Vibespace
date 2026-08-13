/**
 * The "Blocks" view (Phase 9.5a, part 2 — docs/COLLAPSIBLE-BLOCKS.md): a
 * second, entirely separate renderer for a shell pane's history, built by
 * reading each `CommandBlock`'s line range straight out of xterm's own
 * buffer and rendering it as plain HTML — where "collapsed" is just a CSS
 * class, something xterm.js itself can never do (it has no fold API; hiding
 * buffer lines doesn't move the ones below them up).
 *
 * This file is the DOM/xterm-dependent half of that plan and is NOT
 * unit-tested under CI's headless ubuntu-latest runner (no browser, no real
 * `IBufferLine`s to read). The parts that ARE safe and worth testing —
 * coalescing a line's cells into styled runs, and the head/tail line-cap
 * math — are pulled out into `lineRuns.ts`, which this file just calls.
 * Colour resolution (palette index / RGB -> CSS string) is similarly pulled
 * into the pure, tested `xtermPalette.ts`.
 *
 * Terminal.tsx only ever mounts this component for a SHELL pane that has at
 * least one block — see its own render logic — but this file re-checks
 * `agentId` and `blocks.length` itself anyway, so it degrades honestly
 * (never renders an empty box) even if a future caller forgets that.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Terminal as XTerm, IMarker } from "@xterm/xterm";
import type { AgentId } from "@vibedeck/shared";
import { AGENT_SPECS } from "@vibedeck/shared";
import type { CommandBlock } from "./blocks.js";
import { formatBlockDuration } from "./blocks.js";
import { lineToRuns, planBlockCap, resolveBlockRange, type LineLike, type StyledRun } from "./lineRuns.js";
import { resolveXtermColor, type XtermColorMode } from "./xtermPalette.js";
import type { Theme } from "../themes/themes.js";
import { Pill, StatusDot, type StatusKind } from "../shell/ui.js";

/** One block's start/end markers, as tracked by Terminal.tsx's
 * `gutterDecorationsRef` (the SAME markers that draw the gutter colour bar
 * — see that file's "Command blocks" comment). `IMarker.line` auto-adjusts
 * as xterm trims scrollback, and `isDisposed` flips true once the marker's
 * line has been trimmed away entirely — that's the ONLY reliable way to
 * know a block's recorded `startLine`/`endLine` numbers are still valid,
 * since xterm re-indexes remaining lines after every trim (see this file's
 * `buildBlockRender` for why raw `CommandBlock.startLine`/`endLine` are
 * never read directly here). */
export interface BlockMarkers {
  marker: IMarker;
  /** Registered when the block's "D" marker fires; null while still running. */
  endMarker: IMarker | null;
}

interface BlocksViewProps {
  term: XTerm;
  agentId: AgentId;
  blocks: CommandBlock[];
  /** Keyed by block id — Terminal.tsx passes its live `gutterDecorationsRef.current` map directly. */
  lineMarkers: Map<string, BlockMarkers>;
  theme: Theme;
}

function statusKindForBlock(state: CommandBlock["state"]): StatusKind {
  switch (state) {
    case "running":
      return "warn";
    case "ok":
      return "ok";
    case "failed":
      return "danger";
  }
}

function cellColorMode(isDefault: boolean, isRgb: boolean): XtermColorMode {
  if (isDefault) return "default";
  if (isRgb) return "rgb";
  return "palette";
}

/** Adapts one real xterm buffer line into the minimal `LineLike` shape
 * `lineToRuns` (pure, tested) actually needs — see that file's top comment
 * for why the split exists. */
function adaptLine(line: NonNullable<ReturnType<XTerm["buffer"]["active"]["getLine"]>>, theme: Theme): LineLike {
  return {
    length: line.length,
    cellAt(x) {
      const cell = line.getCell(x);
      if (!cell) return undefined;
      return {
        chars: cell.getChars(),
        width: cell.getWidth(),
        bold: cell.isBold() !== 0,
        italic: cell.isItalic() !== 0,
        underline: cell.isUnderline() !== 0,
        inverse: cell.isInverse() !== 0,
        fg: resolveXtermColor(cellColorMode(cell.isFgDefault(), cell.isFgRGB()), cell.getFgColor(), theme.terminal),
        bg: resolveXtermColor(cellColorMode(cell.isBgDefault(), cell.isBgRGB()), cell.getBgColor(), theme.terminal),
      };
    },
  };
}

type BlockRender =
  /** The block's start line has been trimmed out of xterm's scrollback
   * (past the 10,000-line cap) — there is genuinely nothing left to show,
   * and this says so rather than rendering a silently-blank card. */
  | { kind: "evicted" }
  /** No markers were ever recorded for this block at all — NOT the same
   * claim as "evicted". Terminal.tsx's `setGutterBar` deletes a block's
   * `gutterDecorationsRef` entry whenever `term.registerDecoration(...)`
   * returns undefined (its own doc comment: "the marker's line has already
   * scrolled out of the buffer" at DECORATION-creation time), which can
   * happen while the block's own OUTPUT is still perfectly present in the
   * buffer. Saying "output no longer in scrollback" here would be false —
   * docs/COLLAPSIBLE-BLOCKS.md's "be honest when scrollback is gone" rule
   * cuts both ways: don't claim eviction that didn't happen either. */
  | { kind: "not-recorded" }
  /** Start/end markers resolved but described an empty (or inverted, which
   * shouldn't happen but is handled defensively) range. */
  | { kind: "empty" }
  | {
      kind: "lines";
      head: StyledRun[][];
      /** null when every line is in `head` (no capping needed, or the user
       * clicked "show all"). */
      tail: StyledRun[][] | null;
      hiddenCount: number;
      totalLines: number;
      /** Absolute buffer lines the FULL (uncapped) range spans — used by
       * the copy button, which always copies everything regardless of
       * whether the view itself is capped. */
      copyStartLine: number;
      copyEndLine: number;
    };

/**
 * Reads a block's current line range out of `term`'s buffer and builds the
 * styled runs to render it — capped to the first/last `DEFAULT_BLOCK_LINE_CAP`
 * lines unless `forceFull` (the "show all N lines" control). Never touches
 * `block.startLine`/`block.endLine` directly: those are the numbers that
 * were true THE MOMENT they were recorded, but xterm re-indexes every
 * remaining line downward each time it trims scrollback, so only the
 * MARKERS' live `.line` (or `isDisposed`) can be trusted here.
 */
function buildBlockRender(
  term: XTerm,
  block: CommandBlock,
  markers: BlockMarkers | undefined,
  theme: Theme,
  forceFull: boolean
): BlockRender {
  if (!markers) return { kind: "not-recorded" };
  if (markers.marker.isDisposed) return { kind: "evicted" };

  const { startLine, endLine } = resolveBlockRange({
    startLine: markers.marker.line,
    finished: block.endLine !== null,
    endMarkerLine: markers.endMarker && !markers.endMarker.isDisposed ? markers.endMarker.line : null,
    bufferLastLine: term.buffer.active.length - 1,
    cursorLine: term.buffer.active.baseY + term.buffer.active.cursorY,
  });

  if (endLine < startLine) return { kind: "empty" };

  const totalLines = endLine - startLine + 1;
  const readLine = (y: number): StyledRun[] => {
    const line = term.buffer.active.getLine(y);
    return line ? lineToRuns(adaptLine(line, theme)) : [];
  };

  const plan = forceFull ? ({ capped: false } as const) : planBlockCap(totalLines);

  if (!plan.capped) {
    const head: StyledRun[][] = [];
    for (let y = startLine; y <= endLine; y++) head.push(readLine(y));
    return { kind: "lines", head, tail: null, hiddenCount: 0, totalLines, copyStartLine: startLine, copyEndLine: endLine };
  }

  const head: StyledRun[][] = [];
  for (let y = startLine; y < startLine + plan.headLines; y++) head.push(readLine(y));
  const tail: StyledRun[][] = [];
  for (let y = endLine - plan.tailLines + 1; y <= endLine; y++) tail.push(readLine(y));

  return {
    kind: "lines",
    head,
    tail,
    hiddenCount: plan.hiddenLines,
    totalLines,
    copyStartLine: startLine,
    copyEndLine: endLine,
  };
}

/** How often a still-RUNNING block's rendered content refreshes — a
 * deliberately coarse debounce (docs/COLLAPSIBLE-BLOCKS.md: "re-render on
 * output, debounced") rather than re-rendering on every single chunk of
 * streamed output, which for a chatty command would mean rebuilding this
 * block's HTML dozens of times a second. */
const RUNNING_BLOCK_REFRESH_MS = 1000;

export default function BlocksView({ term, agentId, blocks, lineMarkers, theme }: BlocksViewProps) {
  if (agentId !== "shell") {
    return (
      <BlocksEmptyState>
        Blocks view needs vibedeck's shell integration, which only runs in "shell" panes — not{" "}
        {AGENT_SPECS[agentId].displayName}. {AGENT_SPECS[agentId].displayName} is a full-screen program with no
        command markers to build blocks from; use Live view here instead.
      </BlocksEmptyState>
    );
  }

  if (blocks.length === 0) {
    return <BlocksEmptyState>No commands run yet in this pane.</BlocksEmptyState>;
  }

  // Newest first, same convention as the right dock's Blocks tab.
  const newestFirst = [...blocks].reverse();

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        overflowY: "auto",
        background: "var(--vd-bg)",
        // Extra headroom on top: Terminal.tsx floats the Live/Blocks toggle
        // over this pane at `top: 8` with a higher z-index, so a plain 8px
        // pad would leave it sitting on top of the newest block's command
        // text — the one line you most want to read.
        padding: "40px 8px 8px",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      {newestFirst.map((block) => (
        <BlockCard key={block.id} block={block} term={term} markers={lineMarkers.get(block.id)} theme={theme} />
      ))}
    </div>
  );
}

function BlockCard({
  block,
  term,
  markers,
  theme,
}: {
  block: CommandBlock;
  term: XTerm;
  markers: BlockMarkers | undefined;
  theme: Theme;
}) {
  // Auto-collapse successes, keep failures (and the in-flight block) open —
  // but once the USER manually toggles a card, stop overriding their
  // choice, even if the block later finishes and would otherwise flip it.
  const [expanded, setExpanded] = useState(block.state !== "ok");
  const [showAll, setShowAll] = useState(false);
  const userToggledRef = useRef(false);
  const prevStateRef = useRef(block.state);

  useEffect(() => {
    if (prevStateRef.current !== block.state) {
      prevStateRef.current = block.state;
      if (!userToggledRef.current) setExpanded(block.state !== "ok");
    }
  }, [block.state]);

  // The in-flight block streams — see RUNNING_BLOCK_REFRESH_MS above.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (block.state !== "running") return;
    const id = setInterval(() => setTick((t) => t + 1), RUNNING_BLOCK_REFRESH_MS);
    return () => clearInterval(id);
  }, [block.state]);

  const render = useMemo(
    () => buildBlockRender(term, block, markers, theme, showAll),
    [term, block, markers, theme, showAll, tick]
  );

  const toggleExpanded = () => {
    userToggledRef.current = true;
    setExpanded((e) => !e);
  };

  const handleCopy = () => {
    if (render.kind !== "lines") return;
    const lines: string[] = [];
    for (let y = render.copyStartLine; y <= render.copyEndLine; y++) {
      const line = term.buffer.active.getLine(y);
      // trimRight: true — matches lineToRuns' own trailing-padding trim,
      // so a copied line doesn't carry a wall of trailing spaces.
      if (line) lines.push(line.translateToString(true));
    }
    void navigator.clipboard.writeText(lines.join("\n"));
  };

  const canCopy = render.kind === "lines";

  return (
    <div
      style={{
        border: "1px solid var(--vd-border)",
        borderRadius: 6,
        background: "var(--vd-surface)",
        overflow: "hidden",
        flexShrink: 0,
      }}
    >
      <div
        onClick={toggleExpanded}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 10px",
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        <StatusDot status={statusKindForBlock(block.state)} title={block.state} />
        <code
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: 12,
            color: "var(--vd-text)",
          }}
        >
          {block.command ?? "(command not captured)"}
        </code>
        {block.state === "failed" && block.exitCode !== null && <Pill status="danger">exit {block.exitCode}</Pill>}
        <span style={{ fontSize: 10, color: "var(--vd-text-faint)", flexShrink: 0 }}>
          {block.durationMs !== null ? formatBlockDuration(block.durationMs) : "running…"}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            handleCopy();
          }}
          disabled={!canCopy}
          title={canCopy ? "Copy this block's output" : "Nothing to copy"}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--vd-text-faint)",
            cursor: canCopy ? "pointer" : "not-allowed",
            opacity: canCopy ? 1 : 0.4,
            fontSize: 11,
            padding: "2px 4px",
            flexShrink: 0,
          }}
        >
          Copy
        </button>
        <span
          aria-hidden
          style={{
            display: "inline-block",
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
            transition: "transform 120ms ease",
            color: "var(--vd-text-faint)",
            fontSize: 10,
            flexShrink: 0,
          }}
        >
          ▶
        </span>
      </div>

      {expanded && (
        <div
          style={{
            borderTop: "1px solid var(--vd-border)",
            padding: "6px 10px",
            fontFamily: "'SF Mono', Menlo, Monaco, 'Cascadia Code', 'Fira Code', monospace",
            fontSize: 12,
            lineHeight: 1.4,
            overflowX: "auto",
          }}
        >
          {render.kind === "evicted" && (
            <BodyNote>output no longer in scrollback (xterm keeps the last 10,000 lines)</BodyNote>
          )}
          {render.kind === "not-recorded" && <BodyNote>output not recorded for this block</BodyNote>}
          {render.kind === "empty" && <BodyNote>(no output)</BodyNote>}
          {render.kind === "lines" && (
            <>
              {render.head.map((runs, i) => (
                <LineRow key={`h${i}`} runs={runs} theme={theme} />
              ))}
              {render.tail && (
                <div style={{ padding: "6px 0" }}>
                  <button
                    type="button"
                    onClick={() => setShowAll(true)}
                    style={{
                      background: "var(--vd-surface-raised)",
                      border: "1px solid var(--vd-border)",
                      borderRadius: 4,
                      color: "var(--vd-text-muted)",
                      fontSize: 11,
                      padding: "3px 8px",
                      cursor: "pointer",
                    }}
                  >
                    Show all {render.totalLines} lines ({render.hiddenCount} hidden)
                  </button>
                </div>
              )}
              {render.tail?.map((runs, i) => (
                <LineRow key={`t${i}`} runs={runs} theme={theme} />
              ))}
            </>
          )}
          {block.state === "running" && (
            <BodyNote>still running — this view refreshes about once a second</BodyNote>
          )}
        </div>
      )}
    </div>
  );
}

function LineRow({ runs, theme }: { runs: StyledRun[]; theme: Theme }) {
  if (runs.length === 0) {
    // An empty line still needs to occupy a row, same as in the real
    // terminal — a non-breaking space keeps the div from collapsing to 0
    // height.
    return <div style={{ whiteSpace: "pre" }}>{" "}</div>;
  }
  return (
    <div style={{ whiteSpace: "pre" }}>
      {runs.map((run, i) => {
        // Inverse video swaps effective fg/bg, falling back to the
        // terminal's own default background/foreground for whichever side
        // was "default" (docs/COLLAPSIBLE-BLOCKS.md: reproduce inverse).
        const fg = run.inverse ? (run.bg ?? theme.terminal.background) : run.fg ?? undefined;
        const bg = run.inverse ? (run.fg ?? theme.terminal.foreground) : run.bg ?? undefined;
        return (
          <span
            key={i}
            style={{
              color: fg,
              backgroundColor: bg,
              fontWeight: run.bold ? 700 : undefined,
              fontStyle: run.italic ? "italic" : undefined,
              textDecoration: run.underline ? "underline" : undefined,
            }}
          >
            {run.text}
          </span>
        );
      })}
    </div>
  );
}

function BodyNote({ children }: { children: React.ReactNode }) {
  return <p style={{ color: "var(--vd-text-faint)", fontSize: 11, margin: "4px 0" }}>{children}</p>;
}

function BlocksEmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: "var(--vd-bg)",
      }}
    >
      <p style={{ color: "var(--vd-text-faint)", fontSize: 12, textAlign: "center", maxWidth: 360, lineHeight: 1.5 }}>
        {children}
      </p>
    </div>
  );
}
