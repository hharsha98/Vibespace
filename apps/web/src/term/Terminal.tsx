import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import type { ClientMessage, ServerMessage } from "@vibedeck/shared";
import { isMacPlatform, matchShortcut } from "../keys/keymap.js";
import type { Theme } from "../themes/themes.js";
import "@xterm/xterm/css/xterm.css";

interface TerminalProps {
  /** Which server-side session this terminal attaches to. */
  sessionId: string;
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

/**
 * A real, server-backed terminal. Renders one xterm.js instance wired up to
 * a WebSocket that streams a pty's input/output. Closing this component
 * (switching sessions, unmounting) only closes the *view* — the pty itself
 * keeps running on the server until explicitly killed (see `onClose`).
 */
export default function Terminal({ sessionId, theme, onClose }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);

  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

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
    <div
      style={{ position: "relative", width: "100%", height: "100%", background: "var(--vd-bg)" }}
      onContextMenu={handleContextMenu}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      <div ref={containerRef} tabIndex={0} style={{ width: "100%", height: "100%" }} />

      {showSearch && (
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
