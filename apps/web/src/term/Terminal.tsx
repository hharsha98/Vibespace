import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import type { IDecoration, IMarker } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import type { AgentId, ClientMessage, ServerMessage } from "@vibedeck/shared";
import { AGENT_SPECS } from "@vibedeck/shared";
import { isMacPlatform, matchShortcut } from "../keys/keymap.js";
import type { Theme } from "../themes/themes.js";
import { BlockTracker, parseOsc133 } from "./blocks.js";
import { createPendingCommand, type PendingCommand } from "./pendingCommand.js";
import {
  notifyBlocksChanged,
  registerBlockTracker,
  registerScrollHandler,
  unregisterBlockTracker,
  unregisterScrollHandler,
  useSessionBlocks,
} from "./blockStore.js";
import BlocksView from "./BlocksView.js";
import PromptBar from "./PromptBar.js";
import {
  AGENT_ACTIVITY_IDLE_MS,
  clearQueue,
  createPromptQueueState,
  isRecentActivityBusy,
  setAgentStatus,
  submitPrompt,
  type AgentStatus,
  type PromptQueueState,
} from "./promptQueue.js";
import "@xterm/xterm/css/xterm.css";

interface TerminalProps {
  /** Which server-side session this terminal attaches to. */
  sessionId: string;
  /** Which agent this session is running — "shell" gets the EXACT prompt-
   * bar busy signal (an open OSC 133 block) and a real Blocks view; every
   * other agent (claude/cursor-agent/codex, full-screen TUIs with no
   * markers) falls back to the output-activity heuristic for the prompt
   * bar and an honest "needs shell integration" message in Blocks view.
   * See the "Command blocks" and "Per-pane prompt bar" module comments
   * below. */
  agentId: AgentId;
  /** The active theme — its `.terminal` palette colours this instance,
   * live, whenever the user switches themes (see the effect below); it's
   * not just used at creation time. */
  theme: Theme;
  /**
   * Called after the user picks "Close" from the right-click menu and the
   * session has actually been killed server-side (DELETE /api/sessions/:id
   * succeeded). The parent decides what to do next (e.g. drop it from a
   * session list) — this component doesn't own that state.
   */
  onClose?: () => void;
}

/** Escape spaces in a dropped file's path, the way a shell expects (`a b` -> `a\ b`). */
function shellEscapeSpaces(path: string): string {
  return path.replace(/ /g, "\\ ");
}

/** Turn window.location into the ws(s):// URL for this session's stream. */
function buildWebSocketUrl(sessionId: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/sessions/${sessionId}/ws`;
}

interface ContextMenuState {
  x: number;
  y: number;
}

// --- WebGL context budget -----------------------------------------------
//
// Browsers cap the number of *simultaneous* WebGL contexts a page may hold
// open — typically somewhere around 8 to 16, and it varies by browser. Once
// that cap is hit, creating another context either fails outright, or (more
// dangerously) the browser silently force-loses the *oldest* context to
// make room. In a pane grid where every terminal wants WebGL, that second
// behaviour is nasty: early panes go blank and stop repainting with no
// error visible anywhere, because their context was killed out from under
// them by a browser-internal budget we don't control.
//
// We defend against this two ways, both required:
//   1. A hard module-level cap (`MAX_WEBGL_TERMINALS`) on how many of *our*
//      terminals may hold a WebGL context at once, comfortably under the
//      browser's own limit. Terminals created beyond the cap skip WebGL
//      entirely and use xterm's default (canvas/DOM) renderer — slower on
//      huge output bursts, but always renders.
//   2. Listening for `onContextLoss` on every WebGL addon we DO create. If
//      the browser yanks a context out from under us anyway (e.g. because
//      some other tab/page also ate into the shared budget), we dispose
//      the addon — which xterm.js treats as "fall back to the default
//      renderer" — instead of leaving that pane frozen and dead.
//
// Do not remove this cap thinking "modern browsers can handle more" — the
// point isn't today's exact number, it's that *some* finite number exists
// and terminals must degrade gracefully past it rather than going dark.
const MAX_WEBGL_TERMINALS = 8;
let activeWebglTerminals = 0;

// --- Command blocks (Phase 5) -------------------------------------------
//
// A shell pane's pty (see apps/server/src/pty/shell-integration) emits OSC
// 133 escape sequences bracketing each command it runs. Every OTHER agent
// (claude, cursor-agent, codex — full-screen TUIs, not shells) simply never
// emits them, so all of the code below is dormant/no-op for those panes:
// the OSC handler just never fires, no blocks are ever created, and
// nothing about their rendering changes. That's the "degrade silently"
// requirement — there's no branch anywhere that checks "is this a shell
// pane?" because there doesn't need to be one.

/** One gutter decoration's live state — its `IMarker` (the buffer line it
 * tracks, surviving scrollback trimming) and its currently-rendered
 * `IDecoration` (the actual coloured bar). Kept as a pair because updating
 * a decoration's colour means disposing the old one and creating a fresh
 * one at the SAME marker (xterm.js decorations don't support changing
 * their background colour in place after creation). */
interface GutterEntry {
  marker: IMarker;
  decoration: IDecoration;
  /** A second marker, registered when the block's "D" (finished) OSC 133
   * marker fires (or when a stale open block is force-closed by a new "C",
   * see the OSC handler below) — null while the block is still running, or
   * for a block that will never get one (a bare-D-less interrupt, still
   * being closed out best-effort). This is BlocksView.tsx's only reliable
   * way to know a finished block's CURRENT end line: xterm re-indexes every
   * remaining buffer line downward each time it trims scrollback, so the
   * `endLine` number recorded on the `CommandBlock` itself (true the moment
   * it was recorded) silently drifts wrong after any trim — a live
   * `IMarker` auto-adjusts instead of drifting, and flips `isDisposed` once
   * its own line is trimmed away. See BlocksView.tsx's `buildBlockRender`. */
  endMarker: IMarker | null;
}

/** Maps a block's state to the DESIGN.md status-colour CSS variable its
 * gutter bar (and the Blocks tab's status dot) should use: running reads as
 * "working / attention" (`--vd-warn`), ok as `--vd-ok`, failed as
 * `--vd-danger` — see docs/DESIGN.md §2's status-colour table. */
function colorForBlockState(state: "running" | "ok" | "failed"): string {
  switch (state) {
    case "running":
      return "var(--vd-warn)";
    case "ok":
      return "var(--vd-ok)";
    case "failed":
      return "var(--vd-danger)";
  }
}

/** Styles a decoration's rendered element as a thin 2px colour bar. xterm.js
 * hands us this element ALREADY positioned to the right row and column
 * (`position: absolute; top: <row offset>px; left: <col offset>px; ...`,
 * recomputed on every one of its own render passes) — we must only ever
 * ADD to that (colour, width, no-pointer-events), never touch `position`/
 * `top`/`bottom`/`left` ourselves. An earlier version of this function DID
 * hardcode `top`/`bottom`/`left`/`position`, which clobbered xterm's own
 * row placement and put every single bar at row 0 — caught by hand-testing
 * (two commands' bars both rendering on the terminal's very first line). */
function styleGutterBar(el: HTMLElement, color: string): void {
  el.style.width = "2px";
  el.style.backgroundColor = color;
  el.style.pointerEvents = "none";
}

/**
 * A real, server-backed terminal. Renders one xterm.js instance wired up to
 * a WebSocket that streams a pty's input/output. Closing this component
 * (switching sessions, unmounting) only closes the *view* — the pty itself
 * keeps running on the server until explicitly killed (see `onClose`).
 */
export default function Terminal({ sessionId, agentId, theme, onClose }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  // This pane's command-block state (Phase 5) — created fresh in the main
  // mount effect below, and reachable here too so `handleClear` (a
  // component-level function, outside that effect) can reset it when the
  // user clears the terminal. See the "Command blocks" module comment
  // above for why every other agent's pane just never touches any of this.
  const blockTrackerRef = useRef<BlockTracker | null>(null);
  const gutterDecorationsRef = useRef<Map<string, GutterEntry>>(new Map());
  // The prompt bar's "authoritative command text" box — set
  // by `recordPendingCommand` below (called from `handlePromptSubmit` and
  // `applyAgentStatus`, both OUTSIDE the main mount effect) and consumed by
  // the OSC 133 "C" handler (INSIDE that effect). A ref, not a plain
  // closure variable, for exactly the same reason `blockTrackerRef` is: it
  // has to be reachable from both sides of that boundary. See
  // pendingCommand.ts's top comment for the consume-once semantics that
  // make this safe.
  const pendingCommandRef = useRef<PendingCommand | null>(null);

  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // --- Blocks view (Phase 9.5a, part 2) -----------------------------------
  // "live" (default) is xterm exactly as before; "blocks" swaps in
  // BlocksView.tsx's own HTML renderer below, built from this same
  // session's block list — reactive via useSessionBlocks so BlocksView
  // re-renders whenever Terminal.tsx's OSC 133 handler reports a new/closed
  // block, the same store RightDock's own Blocks tab already reads from.
  const [viewMode, setViewMode] = useState<"live" | "blocks">("live");
  const sessionBlocks = useSessionBlocks(sessionId);

  // --- Per-pane prompt bar (Phase 9.5a, part 1) ---------------------------
  // See promptQueue.ts's top comment for the full design; this component's
  // job is just wiring its pure transitions to real busy-detection (exact
  // OSC 133 for shell panes, a heuristic for agent TUI panes — see the OSC
  // handler and the websocket "output" case below) and to the socket.
  //
  // `queueStateRef` is the single source of truth (always current, readable
  // synchronously from any handler below); `queueState` (via
  // `setQueueStateForRender`) exists ONLY to make React re-render
  // PromptBar's props — it's never read to decide anything. This split
  // matters: React 18 StrictMode (see main.tsx) deliberately invokes a
  // *function* passed to `setState` TWICE in development, specifically to
  // catch impure updaters. An earlier version of this code put the actual
  // `sendToSocket` side effect INSIDE such a function — which StrictMode
  // then ran twice, sending every submitted/flushed prompt into the pty
  // TWICE (caught by hand-testing: typing one prompt into the bar ran it
  // twice in the terminal). Reading/writing the ref keeps every state
  // transition + its one-time side effect in a single, plain, non-updater
  // call site, so there is nothing left for a double-invoke to duplicate.
  const queueStateRef = useRef<PromptQueueState>(createPromptQueueState());
  const [queueState, setQueueStateForRender] = useState<PromptQueueState>(queueStateRef.current);
  // Agent-TUI heuristic bookkeeping (unused, and never updated, for shell
  // panes — those get the exact OSC 133 signal instead).
  const lastOutputAtRef = useRef<number | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /** Writes `data` straight into this pane's pty over the socket — the same
   * "input" message `term.onData` sends (see the main effect below), just
   * reachable from outside that effect too (the prompt bar and the agent-
   * TUI heuristic both need to reach the socket without depending on
   * whichever `send` closure the mount effect happens to have captured). */
  const sendToSocket = (data: string) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "input", sessionId, data } satisfies ClientMessage));
    }
  };

  /** Records `text` — about to be written into the pty via
   * the prompt bar, either sent immediately or just flushed from the queue
   * (see this function's two callers below) — as the command the OSC 133
   * "C" that follows should be attributed to, instead of falling back to
   * `captureCommandText()`'s best-effort buffer scrape. Skips multi-line or
   * effectively-blank text: PromptBar's `<input>` already trims outer
   * whitespace before calling `onSubmit`, but a paste could still smuggle
   * in embedded newlines, and recording a mangled multi-line "command"
   * would be worse than falling back to the existing scrape. */
  const recordPendingCommand = (text: string) => {
    if (text.trim().length === 0 || text.includes("\n") || text.includes("\r")) return;
    pendingCommandRef.current?.set(text);
  };

  /** Applies a busy/idle transition to this pane's prompt queue and, if
   * that transition flushed a queued prompt, writes it into the pty right
   * away — "\r", the same carriage return xterm itself sends for Enter. */
  const applyAgentStatus = (status: AgentStatus) => {
    const result = setAgentStatus(queueStateRef.current, status);
    queueStateRef.current = result.state;
    setQueueStateForRender(result.state);
    if (result.send !== null) {
      recordPendingCommand(result.send);
      sendToSocket(result.send + "\r");
    }
  };

  // Agent TUI busy heuristic (claude/cursor-agent/codex — never used for
  // "shell" panes, which get the exact OSC 133 signal in the OSC handler
  // below instead). Output seen within AGENT_ACTIVITY_IDLE_MS counts as
  // busy; this is a HEURISTIC and will sometimes be wrong — see
  // promptQueue.ts's own comment on `isRecentActivityBusy` for why.
  const scheduleIdleCheck = () => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => {
      if (isRecentActivityBusy(lastOutputAtRef.current, Date.now())) {
        // More output arrived right at the edge of the window — check again later.
        scheduleIdleCheck();
      } else {
        applyAgentStatus("idle");
      }
    }, AGENT_ACTIVITY_IDLE_MS);
  };

  const recordAgentActivity = () => {
    lastOutputAtRef.current = Date.now();
    applyAgentStatus("working");
    scheduleIdleCheck();
  };

  /** The prompt bar's submit handler — idle sends immediately, busy queues
   * it (see promptQueue.ts's `submitPrompt`). */
  const handlePromptSubmit = (text: string) => {
    const result = submitPrompt(queueStateRef.current, text);
    queueStateRef.current = result.state;
    setQueueStateForRender(result.state);
    if (result.send !== null) {
      recordPendingCommand(result.send);
      sendToSocket(result.send + "\r");
    }
  };

  const handleClearQueue = () => {
    const next = clearQueue(queueStateRef.current);
    queueStateRef.current = next;
    setQueueStateForRender(next);
  };

  // The main setup/teardown effect: create the terminal, wire it to the
  // socket, and clean everything up on unmount. Deliberately re-runs only
  // when `sessionId` changes — switching sessions tears down the old view
  // entirely and builds a fresh one that reattaches to the new session.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new XTerm({
      cursorBlink: true,
      scrollback: 10000,
      // Phase 5's gutter decorations (`registerMarker`/`registerDecoration`)
      // are still a "proposed" (unstable) part of xterm.js's public API —
      // without this flag, calling either of them throws SYNCHRONOUSLY from
      // inside the OSC 133 handler below, which aborts xterm's parser
      // mid-chunk and silently swallows whatever real output shared that
      // same write() call (discovered exactly this way: `ls`'s own output
      // vanished because it arrived in the same chunk as the "C" marker
      // that triggered the throw). Both APIs are used read-only here (a
      // colour bar, never edited afterward), so opting in is safe.
      allowProposedApi: true,
      fontFamily: "'SF Mono', Menlo, Monaco, 'Cascadia Code', 'Fira Code', monospace",
      // docs/DESIGN.md §3's type scale: terminals are 13px monospace at
      // 1.2 line-height — a step denser than the 14px/1.0 this shipped
      // with pre-Phase-4.5.
      fontSize: 13,
      lineHeight: 1.2,
      // `theme` here is just this terminal's starting colours — it's read
      // once, from whatever theme was active when this effect ran (mount,
      // or a session switch). Later theme changes are pushed live via the
      // separate `theme.terminal` sync effect below, which is what keeps
      // an ALREADY-OPEN terminal in sync with the picker instead of only
      // colouring newly-created ones.
      theme: theme.terminal,
    });
    termRef.current = term;

    // Shortcuts vibedeck owns (Cmd+D, Cmd+K, Cmd+1..9, ...) must reach the
    // app, not the shell — but xterm.js, by default, decides for itself
    // what to do with every keydown it receives, including forwarding some
    // modified combos to the pty. `attachCustomKeyEventHandler` runs BEFORE
    // xterm's own handling and lets us veto: returning `false` tells xterm
    // "don't touch this one," so it never reaches `onData` at all. This is
    // the second half of the two-layer defense — `useKeyboardShortcuts`'s
    // window-capture listener (see that file's top comment) already calls
    // `preventDefault()` on these before they'd reach this textarea in the
    // first place; this is the belt-and-suspenders backstop in case some
    // browser/OS combination still hands xterm the event.
    term.attachCustomKeyEventHandler((event) => matchShortcut(event, isMacPlatform()) === null);

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    term.loadAddon(fitAddon);

    const searchAddon = new SearchAddon();
    searchAddonRef.current = searchAddon;
    term.loadAddon(searchAddon);

    term.loadAddon(new WebLinksAddon());

    // --- Command blocks (Phase 5) ---------------------------------------
    // A fresh BlockTracker per mount (per `sessionId`, since this whole
    // effect re-runs on session change) — see the module-level "Command
    // blocks" comment above for the full picture. Registered into the
    // shared blockStore immediately (even before any markers arrive) so
    // the Blocks tab can tell "this pane has shell integration but hasn't
    // run anything yet" apart from "no tracker was ever created" if it
    // ever needs that distinction.
    const blockTracker = new BlockTracker();
    blockTrackerRef.current = blockTracker;
    registerBlockTracker(sessionId, blockTracker);

    // Mutable bookkeeping the OSC handler below needs between marker
    // events (which line "B" fired on, which block is currently open) —
    // plain closure variables are enough here (unlike blockTrackerRef /
    // gutterDecorationsRef above, nothing outside this effect needs to
    // reach these).
    let promptEndLine: number | null = null;
    let promptEndCol: number | null = null;
    let lastOpenBlockId: string | null = null;
    // Fresh per mount, same lifetime as `blockTracker` above — see
    // `pendingCommandRef`'s own comment for why this needs to be reachable
    // both here (consumed by the "C" case below) and from the component-
    // level `recordPendingCommand` (set there, outside this effect).
    const pendingCommand = createPendingCommand();
    pendingCommandRef.current = pendingCommand;

    const currentBufferLine = (): number => term.buffer.active.baseY + term.buffer.active.cursorY;

    /** Best-effort capture of the command text typed at the prompt: the
     * "B" marker told us exactly where the prompt ends (both the line and
     * the column), so the rest of that same line, from that column
     * onward, is what the user typed. This is genuinely best-effort — it
     * assumes the command stayed on one line and the cursor didn't get
     * moved backward mid-edit (e.g. arrow-key editing, multi-line paste)
     * — so any doubt returns `null` rather than a wrong guess. */
    const captureCommandText = (): string | null => {
      if (promptEndLine === null || promptEndCol === null) return null;
      const bufferLine = term.buffer.active.getLine(promptEndLine);
      if (!bufferLine) return null;
      const fullLine = bufferLine.translateToString(true);
      const typed = fullLine.slice(promptEndCol).trim();
      return typed.length > 0 ? typed : null;
    };

    /** Disposes an existing gutter bar for `blockId` (if any) and draws a
     * fresh one at `marker` in `color` — decorations can't change colour
     * in place, so "recolour" always means dispose-and-recreate. */
    const setGutterBar = (blockId: string, marker: IMarker, color: string): void => {
      const existing = gutterDecorationsRef.current.get(blockId);
      existing?.decoration.dispose();

      const decoration = term.registerDecoration({ marker, x: 0, width: 1 });
      if (!decoration) {
        // registerDecoration can return undefined (e.g. the marker's line
        // has already scrolled out of the buffer) — nothing to draw, but
        // this must never throw or break block tracking itself.
        gutterDecorationsRef.current.delete(blockId);
        return;
      }
      decoration.onRender((el) => styleGutterBar(el, color));
      // Preserve an already-set endMarker across a recolour (dispose-and-
      // recreate of the DECORATION only, per this function's own doc
      // comment) — recolouring must never forget a block's finished-at
      // marker.
      gutterDecorationsRef.current.set(blockId, { marker, decoration, endMarker: existing?.endMarker ?? null });
    };

    const recolorGutterBar = (blockId: string, state: "running" | "ok" | "failed"): void => {
      const entry = gutterDecorationsRef.current.get(blockId);
      if (!entry) return;
      setGutterBar(blockId, entry.marker, colorForBlockState(state));
    };

    // The actual OSC 133 handler: xterm.js calls this with everything
    // between `\x1b]133;` and the terminator, for EVERY OSC 133 sequence
    // the pty sends. Returning `true` tells xterm "I handled this — do not
    // print the raw escape text into the terminal," which is what keeps
    // `133;C`-style garbage from ever appearing on screen. This is
    // registered unconditionally (every pane, not just "shell" ones) — a
    // pane that never emits OSC 133 simply never calls this, which is
    // exactly the "degrade silently" behaviour the phase requires.
    const oscHandler = term.parser.registerOscHandler(133, (data: string) => {
      const event = parseOsc133(data);
      if (!event) return false; // Not one of ours — let xterm's default handling apply.

      const line = currentBufferLine();

      switch (event.marker) {
        case "A":
          blockTracker.onPromptStart(line);
          break;

        case "B":
          promptEndLine = line;
          promptEndCol = term.buffer.active.cursorX;
          blockTracker.onPromptEnd(line);
          break;

        case "C": {
          // Two Cs with no D between them: BlockTracker itself closes the
          // stale block out as "failed" (see blocks.ts), but IT can't touch
          // the DOM — recolour that block's gutter bar to match here, AND
          // give it an end marker at the interrupt point (the same thing a
          // real "D" would register just below) so BlocksView.tsx has a
          // live end line to read instead of falling all the way back to
          // "whatever the buffer's end currently is".
          if (lastOpenBlockId) {
            recolorGutterBar(lastOpenBlockId, "failed");
            const staleEntry = gutterDecorationsRef.current.get(lastOpenBlockId);
            if (staleEntry) staleEntry.endMarker = term.registerMarker(0) ?? null;
          }

          // A prompt-bar submission (immediate or just flushed from the
          // queue — see `recordPendingCommand`) is the
          // AUTHORITATIVE command text when there is one pending; the
          // buffer scrape below is only ever a fallback for text typed
          // directly into the terminal. `consume()` clears it right here,
          // so a later directly-typed command never inherits this string.
          const pendingText = pendingCommand.consume();
          blockTracker.onCommandStart(line, Date.now(), pendingText ?? captureCommandText());
          const opened = blockTracker.list().at(-1);
          if (opened) {
            lastOpenBlockId = opened.id;
            const marker = term.registerMarker(0);
            if (marker) setGutterBar(opened.id, marker, colorForBlockState("running"));
          }
          notifyBlocksChanged(sessionId);
          // Shell panes get the EXACT busy signal here: an OSC 133 "C" IS a
          // command starting to run. See the module-level "Per-pane prompt
          // bar" comment for why agent TUI panes use a different (heuristic)
          // path instead, in the websocket "output" handler below.
          if (agentId === "shell") applyAgentStatus("working");
          break;
        }

        case "D": {
          blockTracker.onCommandEnd(event.exitCode, line, Date.now());
          if (lastOpenBlockId) {
            const closed = blockTracker.list().find((b) => b.id === lastOpenBlockId);
            if (closed) recolorGutterBar(closed.id, closed.state);
            const entry = gutterDecorationsRef.current.get(lastOpenBlockId);
            if (entry) entry.endMarker = term.registerMarker(0) ?? null;
          }
          lastOpenBlockId = null;
          notifyBlocksChanged(sessionId);
          // The exact counterpart to the "working" transition above: an
          // OSC 133 "D" IS the command finishing.
          if (agentId === "shell") applyAgentStatus("idle");
          break;
        }
      }

      return true;
    });

    // The other half of "click a block, jump the terminal there" (see
    // blockStore.ts) — scrolling to an absolute buffer line and refocusing
    // so the user can immediately start scrolling/typing from there.
    registerScrollHandler(sessionId, (targetLine) => {
      term.scrollToLine(targetLine);
      term.focus();
    });

    // WebGL rendering is much faster, but its driver support is patchy —
    // some machines/browsers throw when creating the context — and, per the
    // module-level comment above, the browser's *total* WebGL context
    // budget is shared across every pane in the grid. `holdsWebglSlot`
    // tracks whether *this* terminal currently counts against that budget,
    // so we decrement `activeWebglTerminals` exactly once no matter which
    // of the two paths releases it (context loss vs. component unmount).
    let holdsWebglSlot = false;
    if (activeWebglTerminals < MAX_WEBGL_TERMINALS) {
      try {
        const webglAddon = new WebglAddon();
        term.loadAddon(webglAddon);
        activeWebglTerminals++;
        holdsWebglSlot = true;
        webglAddon.onContextLoss(() => {
          console.warn(
            `vibedeck: WebGL context lost for session ${sessionId}; falling back to default renderer`
          );
          // Disposing the addon (rather than the whole terminal) is the
          // documented xterm.js recovery path: xterm detaches the WebGL
          // renderer and reverts this terminal to its default renderer,
          // so the pane keeps repainting instead of going dark.
          webglAddon.dispose();
          if (holdsWebglSlot) {
            holdsWebglSlot = false;
            activeWebglTerminals--;
          }
        });
      } catch (err) {
        console.warn("vibedeck: WebGL addon failed to load, falling back to default renderer", err);
      }
    } else {
      console.info(
        `vibedeck: WebGL terminal cap (${MAX_WEBGL_TERMINALS}) reached — session ${sessionId} uses the default renderer`
      );
    }

    term.open(container);
    fitAddon.fit();

    const socket = new WebSocket(buildWebSocketUrl(sessionId));
    socketRef.current = socket;

    const send = (message: ClientMessage) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
      }
    };

    socket.addEventListener("message", (event: MessageEvent<string>) => {
      const message = JSON.parse(event.data) as ServerMessage;

      if (message.type === "ready") {
        term.write(message.history);
        term.focus();
        // Now that we know the actual container size (from fit() above),
        // tell the server so the pty's idea of the terminal size matches
        // what's on screen, rather than whatever it was created with.
        if (term.cols !== message.cols || term.rows !== message.rows) {
          send({ type: "resize", sessionId, cols: term.cols, rows: term.rows });
        }
      } else if (message.type === "output") {
        term.write(message.data);
        // Agent TUI panes (never "shell", which gets the exact OSC 133
        // signal above) have no busy/idle markers at all — this heuristic
        // ("output arrived recently" = busy) is the best available signal.
        // See promptQueue.ts's own comment on why it will sometimes be
        // wrong, and AGENT_ACTIVITY_IDLE_MS for the threshold.
        if (agentId !== "shell") recordAgentActivity();
      } else if (message.type === "exit") {
        term.write(`\r\n\x1b[2m[process exited with code ${message.code}]\x1b[0m\r\n`);
      }
    });

    const onData = term.onData((data) => {
      send({ type: "input", sessionId, data });
    });

    const onResize = term.onResize(({ cols, rows }) => {
      send({ type: "resize", sessionId, cols, rows });
    });

    // Refit whenever the container's own size changes (e.g. window resize,
    // or in Phase 2, a pane being resized in the grid). Debounced so a drag
    // resize doesn't spam the pty with resize messages on every frame.
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const resizeObserver = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        fitAddon.fit();
      }, 50);
    });
    resizeObserver.observe(container);

    return () => {
      clearTimeout(resizeTimer);
      clearTimeout(idleTimerRef.current);
      resizeObserver.disconnect();
      onData.dispose();
      onResize.dispose();
      // Closing this socket only detaches this view — the SessionManager
      // on the server keeps the pty running so we (or another tab) can
      // reattach later and replay the scrollback.
      socket.close();
      // Release this terminal's WebGL budget slot, if it still has one
      // (context loss may have already released it — `holdsWebglSlot`
      // guards against double-decrementing the shared counter).
      if (holdsWebglSlot) {
        holdsWebglSlot = false;
        activeWebglTerminals--;
      }
      // Command blocks (Phase 5): dispose every gutter bar's decoration AND
      // both its markers (start + the Phase 9.5a `endMarker` — neither is
      // disposed by term.dispose() automatically), forget this pane's
      // tracker/scroll-handler in the shared stores so a now-gone view
      // stops answering for this sessionId, and stop receiving OSC 133
      // callbacks.
      for (const { marker, decoration, endMarker } of gutterDecorationsRef.current.values()) {
        decoration.dispose();
        marker.dispose();
        endMarker?.dispose();
      }
      gutterDecorationsRef.current.clear();
      oscHandler.dispose();
      unregisterScrollHandler(sessionId);
      unregisterBlockTracker(sessionId);
      blockTrackerRef.current = null;
      pendingCommandRef.current = null;
      // term.dispose() also disposes any still-loaded addons (including
      // the WebGL one, if context loss hasn't already disposed it).
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
      socketRef.current = null;
    };
  }, [sessionId]);

  // Push theme changes into this terminal LIVE — this is what makes
  // switching themes recolour a terminal that's already open and streaming
  // output, not just ones created afterward. xterm.js re-reads
  // `term.options.theme` and repaints as soon as it's reassigned; no
  // dispose/recreate needed. Deliberately a separate effect from the main
  // setup one above (which intentionally only reruns on `sessionId`) so a
  // theme switch never tears down and reconnects the WebSocket.
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = theme.terminal;
    }
  }, [theme]);

  // Cmd/Ctrl+F opens the in-terminal search box instead of the browser's.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setShowSearch(true);
      } else if (event.key === "Escape") {
        setShowSearch(false);
      }
    };

    container.addEventListener("keydown", onKeyDown);
    return () => container.removeEventListener("keydown", onKeyDown);
  }, []);

  // Close the context menu on any click elsewhere.
  useEffect(() => {
    if (!contextMenu) return;
    const onClickAway = () => setContextMenu(null);
    document.addEventListener("click", onClickAway);
    return () => document.removeEventListener("click", onClickAway);
  }, [contextMenu]);

  const handleContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY });
  };

  const handleCopy = () => {
    const selection = termRef.current?.getSelection();
    if (selection) {
      void navigator.clipboard.writeText(selection);
    }
    setContextMenu(null);
  };

  const handlePaste = () => {
    navigator.clipboard
      .readText()
      .then((text) => {
        termRef.current?.paste(text);
      })
      .catch((err: unknown) => {
        console.warn("vibedeck: couldn't read clipboard for paste", err);
      });
    setContextMenu(null);
  };

  const handleClear = () => {
    termRef.current?.clear();
    // Every tracked block's line numbers refer to buffer positions that
    // `term.clear()` just made meaningless — forget them (and their gutter
    // bars) rather than leave stale entries that "jump to block" would
    // scroll to the wrong place for.
    blockTrackerRef.current?.clear();
    for (const { marker, decoration, endMarker } of gutterDecorationsRef.current.values()) {
      decoration.dispose();
      marker.dispose();
      endMarker?.dispose();
    }
    gutterDecorationsRef.current.clear();
    notifyBlocksChanged(sessionId);
    setContextMenu(null);
  };

  const handleCloseSession = () => {
    setContextMenu(null);
    fetch(`/api/sessions/${sessionId}`, { method: "DELETE" })
      .then(() => onClose?.())
      .catch((err: unknown) => {
        console.warn("vibedeck: failed to close session", err);
      });
  };

  // Dropping a file onto the terminal pastes its path as text (space-
  // escaped, since shells otherwise treat spaces as argument separators)
  // instead of letting the browser navigate to/open the file.
  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (!file) return;

    // `.path` is only populated in Electron-style environments; regular
    // browsers never expose a dropped file's absolute filesystem path for
    // security reasons, so we fall back to just the file name.
    const path = (file as File & { path?: string }).path ?? file.name;
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          type: "input",
          sessionId,
          data: shellEscapeSpaces(path),
        } satisfies ClientMessage)
      );
    }
  };

  const handleDragOver = (event: React.DragEvent) => {
    event.preventDefault();
  };

  const runSearch = (direction: "next" | "previous") => {
    const searchAddon = searchAddonRef.current;
    if (!searchAddon || !searchQuery) return;
    if (direction === "next") {
      searchAddon.findNext(searchQuery);
    } else {
      searchAddon.findPrevious(searchQuery);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", background: "var(--vd-bg)" }}>
      <div
        style={{ position: "relative", flex: 1, minHeight: 0 }}
        onContextMenu={handleContextMenu}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
      >
        {/* Live view: xterm exactly as before. Kept mounted (never
         * unmounted) even while Blocks view is showing, just visually
         * hidden — the pty's output must keep landing in xterm's buffer
         * the whole time, both so Live view is instantly up to date when
         * you switch back, and because BlocksView.tsx itself reads directly
         * out of this same buffer. */}
        <div
          ref={containerRef}
          tabIndex={0}
          style={{ width: "100%", height: "100%", display: viewMode === "live" ? "block" : "none" }}
        />

        {viewMode === "blocks" && termRef.current && (
          <BlocksView
            term={termRef.current}
            agentId={agentId}
            blocks={sessionBlocks}
            lineMarkers={gutterDecorationsRef.current}
            theme={theme}
          />
        )}

        {/* Live/Blocks toggle (docs/COLLAPSIBLE-BLOCKS.md) — always shown,
         * even for agent TUI panes, so clicking "Blocks" there surfaces the
         * honest "needs shell integration" message instead of the toggle
         * itself only existing for shell panes. */}
        <div
          style={{
            position: "absolute",
            top: 8,
            left: 8,
            zIndex: 10,
            display: "flex",
            background: "var(--vd-surface)",
            border: "1px solid var(--vd-border)",
            borderRadius: 6,
            overflow: "hidden",
          }}
        >
          <ViewModeButton label="Live" active={viewMode === "live"} onClick={() => setViewMode("live")} />
          <ViewModeButton label="Blocks" active={viewMode === "blocks"} onClick={() => setViewMode("blocks")} />
        </div>

        {showSearch && viewMode === "live" && (
          <div
            style={{
              position: "absolute",
              top: 8,
              right: 8,
              display: "flex",
              gap: 4,
              background: "var(--vd-surface)",
              border: "1px solid var(--vd-border)",
              borderRadius: 6,
              padding: 6,
              zIndex: 10,
            }}
          >
            <input
              autoFocus
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") runSearch(e.shiftKey ? "previous" : "next");
                if (e.key === "Escape") setShowSearch(false);
              }}
              placeholder="Search…"
              style={{
                background: "var(--vd-bg)",
                color: "var(--vd-text)",
                border: "1px solid var(--vd-border)",
                borderRadius: 4,
                padding: "2px 6px",
                fontSize: 13,
              }}
            />
            <button onClick={() => runSearch("previous")} style={searchButtonStyle} title="Previous">
              ↑
            </button>
            <button onClick={() => runSearch("next")} style={searchButtonStyle} title="Next">
              ↓
            </button>
            <button onClick={() => setShowSearch(false)} style={searchButtonStyle} title="Close">
              ✕
            </button>
          </div>
        )}

        {contextMenu && (
          <ul
            style={{
              position: "fixed",
              top: contextMenu.y,
              left: contextMenu.x,
              background: "var(--vd-surface)",
              border: "1px solid var(--vd-border)",
              borderRadius: 6,
              padding: "4px 0",
              margin: 0,
              listStyle: "none",
              minWidth: 140,
              zIndex: 20,
              boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
            }}
          >
            <ContextMenuItem label="Copy" onClick={handleCopy} />
            <ContextMenuItem label="Paste" onClick={handlePaste} />
            <ContextMenuItem label="Clear" onClick={handleClear} />
            <ContextMenuItem label="Close" onClick={handleCloseSession} />
          </ul>
        )}
      </div>

      <PromptBar
        status={queueState.status}
        queuedCount={queueState.queue.length}
        agentDisplayName={AGENT_SPECS[agentId].displayName}
        onSubmit={handlePromptSubmit}
        onClearQueue={handleClearQueue}
        onEscape={() => termRef.current?.focus()}
      />
    </div>
  );
}

function ViewModeButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: active ? "var(--vd-accent)" : "transparent",
        color: active ? "var(--vd-accent-text)" : "var(--vd-text-faint)",
        border: "none",
        cursor: "pointer",
        fontSize: 11,
        padding: "4px 8px",
      }}
    >
      {label}
    </button>
  );
}

const searchButtonStyle: React.CSSProperties = {
  background: "transparent",
  color: "var(--vd-text)",
  border: "none",
  cursor: "pointer",
  fontSize: 13,
  padding: "2px 6px",
};

function ContextMenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <li
      onClick={onClick}
      style={{
        padding: "6px 14px",
        cursor: "pointer",
        color: "var(--vd-text)",
        fontSize: 13,
      }}
    >
      {label}
    </li>
  );
}
