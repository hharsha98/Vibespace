import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import type { IDecoration, IMarker } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { ImageAddon } from "@xterm/addon-image";
import type { AgentId, ClientMessage, ServerMessage } from "@vibedeck/shared";
import { AGENT_SPECS } from "@vibedeck/shared";
import { isMacPlatform, matchShortcut } from "../keys/keymap.js";
import { isCopyShortcut } from "./copyShortcut.js";
import { fitIfVisible } from "./fitIfVisible.js";
import type { Theme } from "../themes/themes.js";
import type { Direction } from "../grid/tree.js";
import { useTerminalPrefs } from "../settings/terminalPrefs.js";
import { notifyAgentIdle } from "../settings/notificationPrefs.js";
import { MOTION, RADIUS, SHADOW_VAR } from "../shell/tokens.js";
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
  /** The active workspace's id, or null in the (should-be-rare) case no
   * workspace is active — same prop PaneView.tsx already threads down for
   * `POST /api/sessions`. Terminal.tsx uses this for two BridgeSpace
   * parity features that are both inherently workspace-scoped: pasting a
   * screenshot (item 2 — the image has to be saved SOMEWHERE inside a real
   * workspace) and command history (item 4 — history is persisted and
   * fetched per workspace). Both features simply no-op without one: see
   * the paste handler's and the history-fetch effect's own comments below. */
  workspaceId: string | null;
  /** The active theme — its `.terminal` palette colours this instance,
   * live, whenever the user switches themes (see the effect below); it's
   * not just used at creation time. */
  theme: Theme;
  /**
   * Whether THIS pane is the focused one (PaneView.tsx's own `isFocused`,
   * threaded straight through) — drives the terminal's OWN chrome (the
   * Live/Blocks toggle, the bottom prompt bar) dimming slightly when the
   * pane isn't focused, the same "inactive pane recedes" idiom tiling
   * terminals (tmux, WezTerm) use for their pane chrome. Deliberately NOT a
   * glow or an accent recolour — docs/DESIGN.md §5 is explicit that the
   * pane's 1px accent border (drawn one level up, by PaneView.tsx) is the
   * ONLY focus AFFORDANCE; this is a secondary, purely-opacity reinforcement
   * of that same fact on the chrome Terminal.tsx itself owns, not a second
   * competing cue.
   */
  isFocused: boolean;
  /**
   * Called after the user picks "Close" from the right-click menu and the
   * session has actually been killed server-side (DELETE /api/sessions/:id
   * succeeded). The parent decides what to do next (e.g. drop it from a
   * session list) — this component doesn't own that state.
   */
  onClose?: () => void;
  /**
   * Phase 9.5c, PARITY #9: fired with "row" (side by side) or "column"
   * (stacked) when the right-click menu's "Split right"/"Split down" entry
   * is picked. Optional (not every caller of `<Terminal>` needs a split
   * affordance — there is exactly one today, PaneView.tsx, which passes the
   * SAME `onSplit` handler its own header icons already call, so this menu
   * never duplicates the split logic itself, only offers another way to
   * reach it).
   */
  onSplit?: (direction: Direction) => void;
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

/** Reads `file`'s bytes as a base64 string, via the `FileReader` `data:`
 * URL API (`readAsDataURL`) — the simplest way to get base64 out of a
 * `File`/`Blob` without a Buffer polyfill in the browser. A `data:` URL is
 * `data:<mimeType>;base64,<the actual base64>`, so this just slices off
 * everything up to (and including) the first comma. */
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read pasted image"));
    reader.readAsDataURL(file);
  });
}

/** BridgeSpace parity item 2: uploads a pasted image to
 * `POST /api/files/paste-image` (see `files/routes.ts`) and returns the
 * workspace-relative path it was written to, or `null` if the upload
 * failed (network error, server refusal — an unsupported MIME type, an
 * oversized image, ...). Deliberately fails soft: a failed screenshot
 * paste should leave the pane exactly as it was, never throw into React or
 * leave half-typed garbage in the pty. */
async function uploadPastedImage(file: File, workspaceId: string): Promise<string | null> {
  try {
    const dataBase64 = await readFileAsBase64(file);
    const res = await fetch("/api/files/paste-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, mimeType: file.type, dataBase64 }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      console.warn("vibedeck: failed to upload pasted image", body.error ?? res.statusText);
      return null;
    }
    const body = (await res.json()) as { path: string };
    return body.path;
  } catch (err) {
    console.warn("vibedeck: failed to upload pasted image", err);
    return null;
  }
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
export default function Terminal({
  sessionId,
  agentId,
  workspaceId,
  theme,
  isFocused,
  onClose,
  onSplit,
}: TerminalProps) {
  // Live-reactive terminal display prefs (font size, cursor style/blink,
  // scrollback) — see terminalPrefs.ts's top comment for why this reads
  // from a shared external store instead of a prop. Read once here (used
  // at XTerm creation, below) and again by the separate live-apply effect
  // near the theme-sync effect, which is what makes a change apply to a
  // pane that's already open, not just to ones created afterward.
  const terminalPrefs = useTerminalPrefs();
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
  // Phase 9.5c, PARITY #12: true while the user has scrolled the LIVE view
  // up away from the bottom. Deliberately its own boolean (not derived from
  // some other piece of state) — see the main effect's `updateScrollState`
  // for where it's actually computed, from xterm's own buffer, not a
  // separate DOM scroll listener (per this phase's instruction to integrate
  // with Terminal.tsx's existing scroll-handling machinery rather than
  // adding a competing one).
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

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

  // --- Command history (BridgeSpace parity item 4) ------------------------
  // The workspace's history pool, newest-first, fed straight to PromptBar
  // (which does its own prefix-matching — see commandHistory.ts). Fetched
  // once per workspace below, then kept in sync locally: every submitted
  // prompt is prepended here immediately (optimistic — no round trip needed
  // before it shows up as a future suggestion), same-shaped dedupe as the
  // server's own `CommandHistoryStore.record` (move-to-front on a repeat,
  // never a second copy), while the real POST below persists it for next
  // time/other panes in the same workspace.
  const [history, setHistory] = useState<string[]>([]);

  useEffect(() => {
    if (!workspaceId) {
      setHistory([]);
      return;
    }
    let cancelled = false;
    fetch(`/api/command-history?workspaceId=${encodeURIComponent(workspaceId)}`)
      .then((res) => (res.ok ? (res.json() as Promise<{ commands: string[] }>) : null))
      .then((body) => {
        if (!cancelled && body) setHistory(body.commands);
      })
      .catch((err: unknown) => {
        console.warn("vibedeck: failed to load command history", err);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  /** Records `text` as a history entry: optimistically, in local state
   * (immediately available to PromptBar's own suggestions), and for real,
   * via a fire-and-forget POST (persisted for next session / other panes
   * in the same workspace). No-ops with no active workspace — there is
   * nowhere workspace-scoped to persist it, and PromptBar's suggestions
   * are meaningless without a workspace's history to draw from anyway. */
  const recordHistory = (text: string) => {
    if (!workspaceId) return;
    setHistory((prev) => [text, ...prev.filter((c) => c !== text)]);
    fetch("/api/command-history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, command: text }),
    }).catch((err: unknown) => {
      console.warn("vibedeck: failed to record command history", err);
    });
  };

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
    const wasWorking = queueStateRef.current.status === "working";
    const result = setAgentStatus(queueStateRef.current, status);
    queueStateRef.current = result.state;
    setQueueStateForRender(result.state);
    if (result.send !== null) {
      recordPendingCommand(result.send);
      sendToSocket(result.send + "\r");
    } else if (status === "idle" && wasWorking) {
      // A real working -> idle transition with nothing queued behind it to
      // flush (the `if` branch above) — see notificationPrefs.ts's top
      // comment for exactly what this notification does and doesn't
      // guarantee (exact for shell panes, a heuristic for agent TUIs).
      // Skipped when a queued prompt was just sent instead: that pane is
      // about to go straight back to "working," so notifying would just be
      // noise for something the user already queued up themselves.
      notifyAgentIdle(AGENT_SPECS[agentId].displayName);
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
    recordHistory(text);
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
      // Starting values only — read once, from whatever `terminalPrefs`
      // was current when this effect ran (mount, or a session switch).
      // Later changes are pushed live via the separate effect near the
      // theme-sync one below, same "read once at creation, sync live via a
      // dedicated effect" split `theme` already uses on this same object.
      cursorBlink: terminalPrefs.cursorBlink,
      cursorStyle: terminalPrefs.cursorStyle,
      scrollback: terminalPrefs.scrollback,
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
      fontSize: terminalPrefs.fontSize,
      lineHeight: 1.2,
      // `theme` here is just this terminal's starting colours — it's read
      // once, from whatever theme was active when this effect ran (mount,
      // or a session switch). Later theme changes are pushed live via the
      // separate `theme.terminal` sync effect below, which is what keeps
      // an ALREADY-OPEN terminal in sync with the picker instead of only
      // colouring newly-created ones.
      theme: theme.terminal,
      // BridgeSpace parity item 3: "copyable drag-selection inside
      // mouse-tracking TUIs". When a full-screen app (claude, htop, vim...)
      // turns on mouse tracking, xterm forwards mouse events to it instead
      // of running its own selection — there is genuinely nothing to copy
      // by default. xterm.js's own `shouldForceSelection` already bypasses
      // that and runs a REAL selection instead whenever a modifier is
      // held: Shift, on every non-Mac platform, completely unconditionally
      // (nothing to opt into there). On Mac it's Option/Alt, but ONLY once
      // this option is turned on — it defaults to false because Option is
      // also used for word-boundary cursor movement and composing special
      // characters, so xterm doesn't claim it for selection unless asked.
      // We ask: Option-drag-to-select is the documented, discoverable
      // escape hatch for exactly this situation, matching how iTerm2 and
      // Terminal.app both already handle it, so it's the least surprising
      // choice for anyone dragging inside a mouse-tracking TUI on a Mac.
      // See copyShortcut.ts's top comment for the other half (the Cmd/
      // Ctrl+C keyboard shortcut that reads the resulting selection).
      macOptionClickForcesSelection: true,
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
    const isMac = isMacPlatform();
    term.attachCustomKeyEventHandler((event) => {
      // BridgeSpace parity item 3, part 2: Cmd/Ctrl+C copies the current
      // selection (including one made by Option/Shift-dragging inside a
      // mouse-tracking TUI, per the `macOptionClickForcesSelection` option
      // above) instead of reaching the pty as a literal Ctrl+C. This app
      // never bound this chord to anything before — the right-click "Copy"
      // menu item (`handleCopy`) was the only way in — so this is pure
      // addition, gated by `isCopyShortcut` on there actually BEING a
      // selection, so a shell mid-command always keeps its real Ctrl+C.
      if (isCopyShortcut({ key: event.key, metaKey: event.metaKey, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey, hasSelection: term.hasSelection(), isMac })) {
        void navigator.clipboard.writeText(term.getSelection());
        return false; // Handled — never also send ^C to the pty.
      }
      return matchShortcut(event, isMac) === null;
    });

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    term.loadAddon(fitAddon);

    const searchAddon = new SearchAddon();
    searchAddonRef.current = searchAddon;
    term.loadAddon(searchAddon);

    const webLinksAddon = new WebLinksAddon();
    term.loadAddon(webLinksAddon);

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

    // --- Scroll-to-bottom indicator (Phase 9.5c, PARITY #12) -------------
    // `viewportY` is the buffer line currently at the TOP of the visible
    // viewport; `baseY` is where that would be if the view were pinned to
    // the live bottom (it advances as new lines get pushed in). The two are
    // equal exactly when the user is following live output — this reads
    // straight off xterm's own buffer, the same source of truth
    // `currentBufferLine()` above already uses, rather than a separate DOM
    // scroll listener on the container (which would have to independently
    // reconstruct "am I at the bottom" from raw pixel offsets).
    const updateScrollIndicator = (): void => {
      const buffer = term.buffer.active;
      setShowScrollToBottom(buffer.viewportY < buffer.baseY);
    };
    // Covers the user actually dragging the scrollbar / using PageUp etc.
    const onScroll = term.onScroll(updateScrollIndicator);

    // WebGL rendering is much faster, but its driver support is patchy —
    // some machines/browsers throw when creating the context — and, per the
    // module-level comment above, the browser's *total* WebGL context
    // budget is shared across every pane in the grid. `holdsWebglSlot`
    // tracks whether *this* terminal currently counts against that budget,
    // so we decrement `activeWebglTerminals` exactly once no matter which
    // of the two paths releases it (context loss vs. component unmount).
    let holdsWebglSlot = false;
    // Hoisted above the `try` below (rather than `const`-declared inside
    // it) so the cleanup function at the bottom of this effect can reach
    // it too — see that cleanup's own comment for why it now disposes this
    // addon explicitly instead of only ever relying on `term.dispose()` to
    // cascade to it.
    let webglAddon: WebglAddon | undefined;
    if (activeWebglTerminals < MAX_WEBGL_TERMINALS) {
      try {
        // A separate `const` (not the outer `let webglAddon` directly)
        // inside this closure: TS can't narrow a captured `let` across a
        // closure boundary (it could theoretically be reassigned before the
        // callback runs), so referencing the outer variable inside
        // `onContextLoss`'s callback would type as possibly-undefined even
        // though it's always defined by the time this callback can fire.
        const addon = new WebglAddon();
        webglAddon = addon;
        term.loadAddon(addon);
        activeWebglTerminals++;
        holdsWebglSlot = true;
        addon.onContextLoss(() => {
          console.warn(
            `vibedeck: WebGL context lost for session ${sessionId}; falling back to default renderer`
          );
          // Disposing the addon (rather than the whole terminal) is the
          // documented xterm.js recovery path: xterm detaches the WebGL
          // renderer and reverts this terminal to its default renderer,
          // so the pane keeps repainting instead of going dark.
          addon.dispose();
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

    // Phase 9.5c, PARITY #11: inline image preview (sixel / iTerm2 inline
    // images / Kitty graphics). Independent of the WebGL budget above — it
    // doesn't hold a scarce shared browser resource the way a WebGL context
    // does, so every pane gets it, not just the first MAX_WEBGL_TERMINALS.
    // Still wrapped in try/catch, same defensive posture as the WebGL addon
    // above: this is a community addon, not core xterm.js, and a failure to
    // construct/activate it (an unsupported browser API, some other
    // environment quirk) must degrade to "no inline images in this pane,"
    // never break the terminal itself.
    // Hoisted for the same reason `webglAddon` above is: the cleanup
    // function needs to reach it to dispose it explicitly, before
    // `term.dispose()` — see that cleanup's own comment.
    let imageAddon: ImageAddon | undefined;
    try {
      imageAddon = new ImageAddon({
        // Default is 128MB per addon instance; with up to 16 panes each
        // potentially holding an ImageAddon, the worst case at the
        // default would be 2GB. 32MB/pane keeps that worst case (16 ×
        // 32MB = 512MB) more reasonable while still comfortably fitting
        // any single sixel/iTerm2 image a terminal session is likely to
        // print.
        storageLimit: 32,
      });
      term.loadAddon(imageAddon);
    } catch (err) {
      console.warn("vibedeck: image addon failed to load, inline images will not render", err);
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
        term.write(message.history, updateScrollIndicator);
        term.focus();
        // Now that we know the actual container size (from fit() above),
        // tell the server so the pty's idea of the terminal size matches
        // what's on screen, rather than whatever it was created with.
        if (term.cols !== message.cols || term.rows !== message.rows) {
          send({ type: "resize", sessionId, cols: term.cols, rows: term.rows });
        }
      } else if (message.type === "output") {
        // `write`'s optional callback fires once xterm has actually parsed
        // and applied this chunk — recomputing the indicator THERE (rather
        // than synchronously right after the call, or relying solely on
        // `onScroll` above) is what catches the case `onScroll` alone
        // wouldn't: new output arriving while the user is scrolled up,
        // where `baseY` moves but `viewportY` (the user's own scroll
        // position) deliberately doesn't, and xterm doesn't always fire a
        // scroll event for that on every terminal/renderer combination.
        term.write(message.data, updateScrollIndicator);
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
        fitIfVisible(container, fitAddon);
      }, 50);
    });
    resizeObserver.observe(container);

    return () => {
      clearTimeout(resizeTimer);
      clearTimeout(idleTimerRef.current);
      resizeObserver.disconnect();
      onData.dispose();
      onResize.dispose();
      onScroll.dispose();
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
      // Dispose every renderer/rendering-adjacent addon BEFORE the terminal
      // core (`term.dispose()` below) — this is the actual latent bug this
      // block fixes. It's tempting to assume `term.dispose()` alone is
      // enough, since xterm.js's own `Terminal.dispose()` DOES cascade to
      // every addon still loaded on it... but tracing through xterm.js's
      // source (`browser/public/Terminal.ts`) shows its constructor
      // registers the terminal's own core BEFORE its `AddonManager`
      // (`this._core = this._register(new TerminalCore(...)); this._addonManager
      // = this._register(new AddonManager())`), and its base `Disposable`
      // class tears down everything it registered in REGISTRATION order —
      // so that cascade disposes the core FIRST and every addon SECOND,
      // the exact wrong order. WebglAddon's own renderer, in particular,
      // holds live references into the core's render/decoration/theme
      // services (see `@xterm/addon-webgl`'s `WebglRenderer`) and tears
      // down a WebGL context + canvas — running that teardown against a
      // core that's already torn down its own DOM/services is exactly the
      // "renderer teardown breakage" class of bug. Disposing these
      // ourselves, HERE, while `term` is still fully alive, sidesteps the
      // internal ordering entirely: by the time `term.dispose()` runs
      // below, its `AddonManager` has nothing left in it (each addon's own
      // dispose() unregisters itself — see `AddonManager.loadAddon`'s
      // wrapped dispose), so there's no double-free and no addon ever runs
      // its teardown against an already-disposed core.
      //
      // `fitAddon`/`searchAddon` aren't renderer addons and don't share
      // this specific hazard, but they're included here too for the same
      // "dispose what you loaded, in a controlled order, before the thing
      // it's attached to goes away" discipline — and it costs nothing,
      // since `.dispose()` is idempotent (AddonManager guards against
      // double-dispose, e.g. `webglAddon` here may already be disposed by
      // the `onContextLoss` handler above; calling it again is a no-op).
      fitAddon.dispose();
      searchAddon.dispose();
      webLinksAddon.dispose();
      imageAddon?.dispose();
      webglAddon?.dispose();
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

  // Push terminal display prefs into this terminal LIVE — same idiom as the
  // theme-sync effect just above: xterm re-reads these options and repaints
  // immediately on assignment, no dispose/recreate needed, so a pane that
  // was already open when Settings.tsx saved a change picks it up right
  // away, not just panes created afterward (the explicit "must actually
  // apply live" requirement for this preference).
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = terminalPrefs.fontSize;
    term.options.cursorStyle = terminalPrefs.cursorStyle;
    term.options.cursorBlink = terminalPrefs.cursorBlink;
    term.options.scrollback = terminalPrefs.scrollback;
    // A font-size change resizes every cell, so the number of columns/rows
    // that fit the pane's UNCHANGED pixel footprint changes too — re-fit so
    // xterm (and, via its own `onResize` handler above, the server-side
    // pty) picks up the new grid dimensions immediately, the same re-fit
    // the ResizeObserver below already triggers whenever the container
    // itself resizes.
    //
    // Guarded, because these preferences live in the SETTINGS view — so at
    // the moment they change, this terminal is virtually always the hidden
    // view, and a hidden container measures zero. Fitting against that
    // computes a degenerate grid and ships it to the real pty as a resize:
    // observed live as a terminal stuck at ~11 columns with the shell
    // prompt wrapped in half and typing no longer echoing. The pane
    // re-fits correctly on its own when it becomes visible again, via the
    // ResizeObserver above (0 -> real size is itself a resize).
    const container = containerRef.current;
    const fitAddon = fitAddonRef.current;
    if (container && fitAddon) fitIfVisible(container, fitAddon);
  }, [terminalPrefs]);

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

  // --- Paste a screenshot into an agent pane (BridgeSpace parity item 2) --
  // Pressing Cmd/Ctrl+V with an IMAGE on the clipboard (a screenshot,
  // typically) can't usefully paste as terminal input — agent CLIs (claude,
  // cursor-agent, codex) read an image by its file PATH, not a bitmap typed
  // as escape-sequence garbage, and xterm.js has no concept of an inline
  // image paste at all. So: when the native browser `paste` event's
  // clipboard holds an image, we intercept it BEFORE xterm's own paste
  // handling ever sees it, upload the bytes to the server
  // (`uploadPastedImage`, defined at module scope above), and type the
  // resulting workspace-relative path into the pty as though the user had
  // typed it — same "type a path, don't paste content" idiom `handleDrop`
  // below already uses for a dragged file. A plain TEXT paste never enters
  // the `if (!imageItem)` branch at all and falls straight through to
  // xterm's own handling, completely unchanged.
  //
  // This is a CAPTURE-phase listener, not the usual bubble phase, and that
  // is load-bearing: xterm.js's `CoreBrowserTerminal` registers its OWN
  // paste listeners on `term.textarea`/`term.element` (both descendants of
  // `container`) in the default bubble phase (see that file's `_bindEvents`
  // if you go looking) — a bubble-phase listener on `container` would fire
  // AFTER those, too late to ever stop them. Capture phase runs
  // container-then-descendants, BEFORE the event reaches its target, so
  // this always gets first look, and `stopPropagation()` here reliably
  // prevents xterm's own paste handler from running at all.
  //
  // Deliberately NOT agent-conditional — see this feature's own report for
  // the full reasoning, but in short: a shell pane still benefits from
  // having a real, resolvable path typed in (to `open` it, `cat` it, pass
  // it to a command about to be typed...), so every agentId gets identical
  // behaviour here, no `if (agentId === ...)` branch anywhere in this effect.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onPaste = (event: ClipboardEvent) => {
      const items = event.clipboardData?.items;
      if (!items) return;
      const imageItem = Array.from(items).find(
        (item) => item.kind === "file" && item.type.startsWith("image/")
      );
      if (!imageItem) return; // No image on the clipboard — let xterm paste the text normally.

      event.preventDefault();
      event.stopPropagation();

      if (!workspaceId) {
        // No active workspace to save the image next to, and therefore
        // nothing sensible to type into the pty either — same honest
        // "can't do this without a workspace" degrade the git-branch chip
        // (PaneView.tsx) already uses elsewhere in this app.
        console.warn("vibedeck: pasted image, but this pane has no active workspace to save it under");
        return;
      }

      const file = imageItem.getAsFile();
      if (!file) return;

      void uploadPastedImage(file, workspaceId).then((path) => {
        if (!path) return; // uploadPastedImage already warned; nothing left to do.
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
      });
    };

    container.addEventListener("paste", onPaste, true);
    return () => container.removeEventListener("paste", onPaste, true);
  }, [sessionId, workspaceId]);

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

  // Phase 9.5c, PARITY #9: "Split right"/"Split down" call the exact same
  // `onSplit` prop PaneView.tsx's own header icons call — see that prop's
  // doc comment. Both are no-ops if `onSplit` wasn't supplied (defensive;
  // in practice PaneView.tsx always supplies it today).
  const handleSplitRight = () => {
    setContextMenu(null);
    onSplit?.("row");
  };
  const handleSplitDown = () => {
    setContextMenu(null);
    onSplit?.("column");
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
         * itself only existing for shell panes. Terminal-chrome pass: this
         * is real chrome now, not a bare rectangle floating over xterm — a
         * theme-reactive shadow (SHADOW_VAR, same lift every other floating
         * control in the app gets) and the same isFocused dim treatment the
         * prompt bar below gets, so the whole pane's own chrome recedes
         * together when focus moves elsewhere. Still no glow anywhere —
         * opacity only. */}
        <div
          style={{
            position: "absolute",
            top: 8,
            left: 8,
            zIndex: 10,
            display: "flex",
            background: "var(--vd-surface)",
            border: "1px solid var(--vd-border)",
            borderRadius: RADIUS.sm,
            boxShadow: SHADOW_VAR.sm,
            overflow: "hidden",
            opacity: isFocused ? 1 : 0.7,
            transition: `opacity ${MOTION.fast} ${MOTION.easing}`,
          }}
        >
          <ViewModeButton label="Live" active={viewMode === "live"} onClick={() => setViewMode("live")} />
          <ViewModeButton label="Blocks" active={viewMode === "blocks"} onClick={() => setViewMode("blocks")} />
        </div>

        {/* Phase 9.5c, PARITY #12: only in Live view — Blocks view is a
            separate renderer (docs/COLLAPSIBLE-BLOCKS.md) with its own
            scrolling, and this indicator's whole job is describing xterm's
            OWN buffer position, which is meaningless there. */}
        {showScrollToBottom && viewMode === "live" && (
          <button
            type="button"
            onClick={() => termRef.current?.scrollToBottom()}
            title="Scroll to bottom"
            className="vd-fade-in"
            style={{
              position: "absolute",
              bottom: 12,
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: 10,
              display: "flex",
              alignItems: "center",
              gap: 4,
              background: "var(--vd-surface-raised)",
              color: "var(--vd-text)",
              border: "1px solid var(--vd-border)",
              borderRadius: 12,
              padding: "4px 10px",
              fontSize: 11,
              cursor: "pointer",
              boxShadow: SHADOW_VAR.md,
            }}
          >
            <DownArrowIcon />
            Scroll to bottom
          </button>
        )}

        {showSearch && viewMode === "live" && (
          <div
            className="vd-fade-in"
            style={{
              position: "absolute",
              top: 8,
              right: 8,
              display: "flex",
              gap: 4,
              background: "var(--vd-surface)",
              border: "1px solid var(--vd-border)",
              borderRadius: RADIUS.sm,
              padding: 6,
              zIndex: 10,
              boxShadow: SHADOW_VAR.sm,
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
            className="vd-scale-in"
            style={{
              position: "fixed",
              top: contextMenu.y,
              left: contextMenu.x,
              background: "var(--vd-surface)",
              border: "1px solid var(--vd-border)",
              borderRadius: RADIUS.md,
              padding: "4px 0",
              margin: 0,
              listStyle: "none",
              minWidth: 140,
              zIndex: 20,
              boxShadow: SHADOW_VAR.lg,
            }}
          >
            <ContextMenuItem label="Copy" onClick={handleCopy} />
            <ContextMenuItem label="Paste" onClick={handlePaste} />
            <ContextMenuItem label="Clear" onClick={handleClear} />
            <ContextMenuItem label="Split right" onClick={handleSplitRight} />
            <ContextMenuItem label="Split down" onClick={handleSplitDown} />
            <ContextMenuItem label="Close" onClick={handleCloseSession} />
          </ul>
        )}
      </div>

      <PromptBar
        status={queueState.status}
        queuedCount={queueState.queue.length}
        agentDisplayName={AGENT_SPECS[agentId].displayName}
        isFocused={isFocused}
        history={history}
        onSubmit={handlePromptSubmit}
        onClearQueue={handleClearQueue}
        onEscape={() => termRef.current?.focus()}
      />
    </div>
  );
}

/** A small down-chevron, inline SVG — the scroll-to-bottom indicator's
 * glyph, no icon library (same convention as every other icon in this
 * codebase). */
function DownArrowIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path d="M2.5 4.5L6 8L9.5 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
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
        transition: `background-color ${MOTION.fast} ${MOTION.easing}, color ${MOTION.fast} ${MOTION.easing}`,
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
