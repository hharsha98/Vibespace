/**
 * The Phase 6 code editor: tabs across the top (one per open file), a single
 * CodeMirror 6 instance underneath that swaps content on tab switch, syntax
 * highlighting by extension, Cmd+S to save, and live external-change
 * handling over the `/api/files/watch` WebSocket.
 *
 * --- Why ONE CodeMirror view, not one per tab ---
 * Mounting a fresh `EditorView` per open tab (like Terminal.tsx mounts one
 * xterm instance per pane) would work, but panes are independent, always-
 * visible grid cells — tabs are not; only one is ever on screen. A single
 * view whose STATE gets swapped via `view.setState(...)` is the standard
 * CodeMirror 6 multi-document pattern, and avoids N hidden DOM editors
 * sitting around for a file browser that's typically only showing one file
 * at a time. The trade-off: switching away from a tab and back does NOT
 * preserve that tab's undo history or scroll position (each switch rebuilds
 * a fresh `EditorState` from the tab's current text) — acceptable here
 * since nothing in the phase spec asks for per-tab undo continuity, and the
 * alternative (one view per tab, kept alive off-screen) is real added
 * complexity for a benefit nobody asked for.
 *
 * --- Why theme changes DON'T go through the same "rebuild state" path ---
 * A rebuild-on-switch is fine for tab switching (you weren't mid-edit in
 * the tab you're leaving in any way that matters — its buffer content is
 * preserved via `contentRef`, only cursor/undo/scroll resets). But rebuild-
 * on-THEME-CHANGE would reset the cursor/undo/scroll of whatever tab is
 * CURRENTLY being looked at, right as the user picks a new theme — jarring,
 * and exactly the kind of thing Terminal.tsx already solved once (see its
 * "push theme changes into this terminal LIVE" effect). So the theme lives
 * in a CodeMirror `Compartment`, reconfigured in place via
 * `view.dispatch({ effects: themeCompartment.reconfigure(...) })` — same
 * idea, CodeMirror's version of the mechanism.
 */
import { useEffect, useRef, useState } from "react";
import { EditorState, Compartment, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { python } from "@codemirror/lang-python";
import type { FileContentResponse, FileWatchEvent } from "@vibedeck/shared";
import type { Theme } from "../themes/themes.js";
import { buildCodeMirrorTheme } from "./cmTheme.js";

/** An open tab's bookkeeping. The LIVE text of a tab lives in `contentRef`
 * (a plain Map, not React state) — only `dirty`/`loading`/error/`conflict`
 * booleans live in this React-visible shape, since those are the only
 * fields the tab bar actually needs to re-render on. Re-rendering on every
 * keystroke (which a `content: string` field in React state would cause)
 * would be wasteful for no visible benefit — nothing in the tab bar shows
 * live content. */
interface TabState {
  path: string;
  loading: boolean;
  loadError: string | null;
  saveError: string | null;
  saving: boolean;
  dirty: boolean;
  /** True when the file changed on disk while this tab had unsaved edits —
   * drives the inline "changed on disk" Reload/Keep-mine bar. Cleared by
   * either action. */
  conflict: boolean;
}

export interface OpenFileRequest {
  path: string;
  /** Bumped on every request, including re-opening the same path — lets the
   * effect below tell "the user clicked this file again" apart from "props
   * re-rendered for an unrelated reason". */
  requestId: number;
}

interface EditorProps {
  workspaceId: string | null;
  theme: Theme;
  /** Set by App.tsx when the file tree or quick-open asks to open a file. */
  openRequest: OpenFileRequest | null;
}

const LANGUAGE_BY_EXTENSION: Record<string, () => import("@codemirror/state").Extension> = {
  ts: () => javascript({ typescript: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  js: () => javascript({ jsx: true }),
  jsx: () => javascript({ jsx: true }),
  mjs: () => javascript({}),
  cjs: () => javascript({}),
  json: () => json(),
  md: () => markdown(),
  markdown: () => markdown(),
  css: () => css(),
  html: () => html(),
  htm: () => html(),
  py: () => python(),
};

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
}

function languageExtensionFor(path: string) {
  const build = LANGUAGE_BY_EXTENSION[extensionOf(path)];
  return build ? [build()] : []; // Plain text fallback: no language extension at all.
}

function fileNameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

/** Turn window.location into the ws(s):// URL for the file-watch socket —
 * same pattern as Terminal.tsx's buildWebSocketUrl. */
function buildWatchUrl(workspaceId: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/files/watch?workspaceId=${encodeURIComponent(workspaceId)}`;
}

export default function Editor({ workspaceId, theme, openRequest }: EditorProps) {
  const [tabs, setTabs] = useState<TabState[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeCompartmentRef = useRef(new Compartment());

  // Refs mirroring the latest React state/props, read from inside stable
  // callbacks (the CodeMirror keymap command, the WebSocket's onmessage)
  // that must never see a stale closure over `workspaceId`/`theme`/`tabs`.
  const workspaceIdRef = useRef(workspaceId);
  const themeRef = useRef(theme);
  const activePathRef = useRef(activePath);
  const tabsRef = useRef(tabs);
  // The LIVE (possibly-unsaved) text of every open tab, and the text as it
  // was last loaded/saved — comparing the two is what "dirty" means. Plain
  // refs, not React state — see the TabState doc comment above.
  const contentRef = useRef<Map<string, string>>(new Map());
  const savedContentRef = useRef<Map<string, string>>(new Map());
  // Which tab's content the mounted EditorView is currently displaying —
  // lets load/reload completions decide whether to push their fresh
  // content into the live view (only if it's still the active tab) or just
  // update the background bookkeeping (if the user switched away while it
  // was loading).
  const viewShowingPathRef = useRef<string | null>(null);

  useEffect(() => {
    workspaceIdRef.current = workspaceId;
  }, [workspaceId]);
  useEffect(() => {
    themeRef.current = theme;
  }, [theme]);
  useEffect(() => {
    activePathRef.current = activePath;
  }, [activePath]);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  // --- Mount the (single, persistent) CodeMirror view once -----------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const state = EditorState.create({
      doc: "",
      extensions: [themeCompartmentRef.current.of(buildCodeMirrorTheme(themeRef.current))],
    });
    const view = new EditorView({ state, parent: container });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // --- Live theme switching: reconfigure the compartment in place, ---------
  // preserving whatever tab is currently on screen's cursor/scroll/undo —
  // see this file's top comment for why this is NOT a state rebuild.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeCompartmentRef.current.reconfigure(buildCodeMirrorTheme(theme)),
    });
  }, [theme]);

  // --- Save --------------------------------------------------------------
  const save = (path: string) => {
    const wsId = workspaceIdRef.current;
    if (!wsId) return;
    const content = contentRef.current.get(path) ?? "";

    setTabs((prev) => prev.map((t) => (t.path === path ? { ...t, saving: true, saveError: null } : t)));

    fetch("/api/files/content", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: wsId, path, content }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Server responded with ${res.status}`);
        }
        savedContentRef.current.set(path, content);
        setTabs((prev) =>
          prev.map((t) =>
            t.path === path ? { ...t, dirty: false, conflict: false, saving: false, saveError: null } : t
          )
        );
      })
      .catch((err: unknown) => {
        setTabs((prev) =>
          prev.map((t) =>
            t.path === path
              ? { ...t, saving: false, saveError: err instanceof Error ? err.message : "Failed to save" }
              : t
          )
        );
      });
  };

  // Stable across renders so the CodeMirror keymap command (bound once per
  // built EditorState, not re-bound on every render) always calls the
  // LATEST save implementation rather than one closed over stale props.
  const saveRef = useRef(save);
  saveRef.current = save;

  /** Builds a fresh EditorState for `path` showing `content`, with syntax
   * highlighting by extension, the live theme compartment, and a Cmd/Ctrl+S
   * binding wired to this tab's own path. `Prec.highest` ensures our
   * binding wins over CodeMirror's own default keymap (which has no "s"
   * binding anyway, but this also makes intent explicit). */
  function buildStateForPath(path: string, content: string): EditorState {
    return EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
        languageExtensionFor(path),
        themeCompartmentRef.current.of(buildCodeMirrorTheme(themeRef.current)),
        EditorView.lineWrapping,
        Prec.highest(
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                saveRef.current(path);
                return true;
              },
            },
          ])
        ),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          const doc = update.state.doc.toString();
          contentRef.current.set(path, doc);
          const nowDirty = doc !== (savedContentRef.current.get(path) ?? "");
          setTabs((prev) => {
            const tab = prev.find((t) => t.path === path);
            if (!tab || tab.dirty === nowDirty) return prev; // Avoid a re-render on every keystroke.
            return prev.map((t) => (t.path === path ? { ...t, dirty: nowDirty } : t));
          });
        }),
      ],
    });
  }

  /** Points the mounted view at `path`'s current content, IF `path` is
   * still the active tab (a load/reload can finish after the user has
   * already switched to a different tab). */
  function showInView(path: string) {
    if (activePathRef.current !== path) return;
    const view = viewRef.current;
    if (!view) return;
    const content = contentRef.current.get(path) ?? "";
    view.setState(buildStateForPath(path, content));
    viewShowingPathRef.current = path;
  }

  // --- Opening a file ------------------------------------------------------
  function openTab(path: string) {
    const wsId = workspaceIdRef.current;
    if (!wsId) return;

    if (tabsRef.current.some((t) => t.path === path)) {
      setActivePath(path);
      showInView(path);
      return;
    }

    setTabs((prev) => [
      ...prev,
      { path, loading: true, loadError: null, saveError: null, saving: false, dirty: false, conflict: false },
    ]);
    setActivePath(path);

    fetch(`/api/files/content?workspaceId=${encodeURIComponent(wsId)}&path=${encodeURIComponent(path)}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Server responded with ${res.status}`);
        }
        return (await res.json()) as FileContentResponse;
      })
      .then((body) => {
        contentRef.current.set(path, body.content);
        savedContentRef.current.set(path, body.content);
        setTabs((prev) => prev.map((t) => (t.path === path ? { ...t, loading: false } : t)));
        showInView(path);
      })
      .catch((err: unknown) => {
        setTabs((prev) =>
          prev.map((t) =>
            t.path === path
              ? { ...t, loading: false, loadError: err instanceof Error ? err.message : "Failed to load" }
              : t
          )
        );
      });
  }

  // React to the file tree / quick-open asking to open a file.
  const lastOpenRequestId = useRef(0);
  useEffect(() => {
    if (!openRequest || openRequest.requestId === lastOpenRequestId.current) return;
    lastOpenRequestId.current = openRequest.requestId;
    openTab(openRequest.path);
    // `openTab` is intentionally omitted from the deps below: it's a plain
    // function (not memoized) redefined every render, and this effect must
    // only re-run when a NEW open request arrives (tracked via `requestId`
    // above), not on every render — this project's eslint config doesn't
    // enable react-hooks/exhaustive-deps, so no suppression comment is
    // needed for that rule to accept this.
  }, [openRequest]);

  function switchToTab(path: string) {
    setActivePath(path);
    const tab = tabsRef.current.find((t) => t.path === path);
    if (tab && !tab.loading && !tab.loadError) showInView(path);
  }

  function closeTab(path: string) {
    setTabs((prev) => {
      const index = prev.findIndex((t) => t.path === path);
      if (index === -1) return prev;
      const next = prev.filter((t) => t.path !== path);
      contentRef.current.delete(path);
      savedContentRef.current.delete(path);

      if (activePathRef.current === path) {
        // Land on the tab that was to the right, or the new last tab.
        const fallback = next[index] ?? next[next.length - 1] ?? null;
        setActivePath(fallback ? fallback.path : null);
        if (fallback) {
          showInView(fallback.path);
        } else {
          viewShowingPathRef.current = null;
          viewRef.current?.setState(
            EditorState.create({
              doc: "",
              extensions: [themeCompartmentRef.current.of(buildCodeMirrorTheme(themeRef.current))],
            })
          );
        }
      }
      return next;
    });
  }

  // --- Reload (both the "Reload" bar button and a clean external change) --
  function reloadTab(path: string) {
    const wsId = workspaceIdRef.current;
    if (!wsId) return;
    fetch(`/api/files/content?workspaceId=${encodeURIComponent(wsId)}&path=${encodeURIComponent(path)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`Server responded with ${res.status}`);
        return (await res.json()) as FileContentResponse;
      })
      .then((body) => {
        contentRef.current.set(path, body.content);
        savedContentRef.current.set(path, body.content);
        setTabs((prev) =>
          prev.map((t) =>
            t.path === path ? { ...t, dirty: false, conflict: false, loadError: null } : t
          )
        );
        showInView(path);
      })
      .catch((err: unknown) => {
        console.warn("vibedeck: failed to reload file after an external change", path, err);
      });
  }

  function keepMine(path: string) {
    setTabs((prev) => prev.map((t) => (t.path === path ? { ...t, conflict: false } : t)));
  }

  // --- Live external updates: subscribe to this workspace's file-watch ----
  // socket, reload clean open tabs transparently, and flag a conflict
  // (rather than clobbering) for dirty ones — the Phase 6 done-criterion.
  useEffect(() => {
    if (!workspaceId) return;

    const socket = new WebSocket(buildWatchUrl(workspaceId));
    socket.addEventListener("message", (event: MessageEvent<string>) => {
      let message: FileWatchEvent;
      try {
        message = JSON.parse(event.data) as FileWatchEvent;
      } catch {
        return;
      }

      const openTabState = tabsRef.current.find((t) => t.path === message.path);
      if (!openTabState) return; // Not an open tab — nothing for the editor to do.

      if (message.type === "unlink") {
        if (!openTabState.dirty) {
          setTabs((prev) =>
            prev.map((t) => (t.path === message.path ? { ...t, loadError: "This file was deleted on disk." } : t))
          );
        }
        return;
      }

      if (message.type === "change") {
        if (openTabState.dirty) {
          // Don't silently clobber unsaved edits — flag it, let the bar
          // offer Reload / Keep mine.
          setTabs((prev) => prev.map((t) => (t.path === message.path ? { ...t, conflict: true } : t)));
        } else {
          reloadTab(message.path);
        }
      }
    });

    return () => {
      socket.close();
    };
    // `reloadTab` is intentionally omitted from the deps below — same
    // reasoning as the effect above: this must only reconnect when the
    // WORKSPACE changes, not on every render.
  }, [workspaceId]);

  const activeTab = tabs.find((t) => t.path === activePath) ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* Tab bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          overflowX: "auto",
          flexShrink: 0,
          borderBottom: "1px solid var(--vd-border)",
          background: "var(--vd-surface)",
        }}
      >
        {tabs.map((tab) => (
          <div
            key={tab.path}
            onClick={() => switchToTab(tab.path)}
            title={tab.path}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              height: 30,
              padding: "0 8px",
              flexShrink: 0,
              cursor: "pointer",
              fontSize: 12,
              color: tab.path === activePath ? "var(--vd-text)" : "var(--vd-text-muted)",
              background: tab.path === activePath ? "var(--vd-bg)" : "transparent",
              borderRight: "1px solid var(--vd-border)",
              borderBottom: tab.path === activePath ? "2px solid var(--vd-accent)" : "2px solid transparent",
              marginBottom: -1,
            }}
          >
            <span style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {fileNameOf(tab.path)}
            </span>
            {tab.dirty && (
              <span
                aria-hidden
                title="Unsaved changes"
                style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--vd-warn)", flexShrink: 0 }}
              />
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.path);
              }}
              title="Close"
              style={{
                background: "transparent",
                border: "none",
                cursor: "pointer",
                color: "var(--vd-text-faint)",
                fontSize: 11,
                lineHeight: 1,
                padding: 0,
                flexShrink: 0,
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {/* Conflict / save-error banners for the active tab */}
      {activeTab?.conflict && (
        <div style={conflictBarStyle}>
          <span>This file changed on disk while you had unsaved edits.</span>
          <button style={primaryBannerButtonStyle} onClick={() => reloadTab(activeTab.path)}>
            Reload
          </button>
          <button style={secondaryBannerButtonStyle} onClick={() => keepMine(activeTab.path)}>
            Keep mine
          </button>
        </div>
      )}
      {activeTab?.saveError && (
        <div style={errorBarStyle}>
          <span>Save failed: {activeTab.saveError}</span>
        </div>
      )}
      {activeTab?.loadError && (
        <div style={errorBarStyle}>
          <span>{activeTab.loadError}</span>
        </div>
      )}

      {/* The single, persistent CodeMirror mount point */}
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        <div ref={containerRef} style={{ position: "absolute", inset: 0, overflow: "auto" }} />
        {tabs.length === 0 && (
          <div style={emptyStateStyle}>
            <p style={{ margin: 0 }}>No file open.</p>
            <p style={{ margin: "4px 0 0", color: "var(--vd-text-faint)" }}>
              Click a file in the tree, or press Cmd+P to quick-open one.
            </p>
          </div>
        )}
        {activeTab?.loading && (
          <div style={emptyStateStyle}>
            <p style={{ margin: 0 }}>Loading…</p>
          </div>
        )}
      </div>
    </div>
  );
}

const conflictBarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "6px 12px",
  background: "color-mix(in srgb, var(--vd-warn) 18%, var(--vd-bg))",
  borderBottom: "1px solid var(--vd-warn)",
  fontSize: 12,
  flexShrink: 0,
};

const errorBarStyle: React.CSSProperties = {
  padding: "6px 12px",
  background: "color-mix(in srgb, var(--vd-danger) 18%, var(--vd-bg))",
  borderBottom: "1px solid var(--vd-danger)",
  fontSize: 12,
  color: "var(--vd-text)",
  flexShrink: 0,
};

const primaryBannerButtonStyle: React.CSSProperties = {
  background: "var(--vd-accent)",
  color: "var(--vd-accent-text)",
  border: "none",
  borderRadius: 4,
  padding: "3px 10px",
  fontSize: 11,
  cursor: "pointer",
};

const secondaryBannerButtonStyle: React.CSSProperties = {
  background: "transparent",
  color: "var(--vd-text-muted)",
  border: "1px solid var(--vd-border)",
  borderRadius: 4,
  padding: "3px 10px",
  fontSize: 11,
  cursor: "pointer",
};

const emptyStateStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  color: "var(--vd-text-muted)",
  fontSize: 12,
  textAlign: "center",
  background: "var(--vd-bg)",
  pointerEvents: "none",
};
