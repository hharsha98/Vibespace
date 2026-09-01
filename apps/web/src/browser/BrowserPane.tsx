import { useEffect, useRef, useState } from "react";
import { EMPTY_SURFACE_BACKGROUND, EmptyState, IconButton } from "../shell/ui.js";
import { FONT, RADIUS, SPACE } from "../shell/tokens.js";
import { normalizeAndValidateUrl } from "./url.js";

/**
 * A pane that shows a web page instead of a terminal — the real use case is
 * a dev server (`http://localhost:3000`) open beside the agent that's
 * building it, in the same split grid as every other pane.
 *
 * Rendered as a plain `<iframe>`. That works identically in the ordinary
 * browser build and inside the Tauri desktop shell's webview, so there's
 * one implementation here, not two — a native Tauri child webview
 * (`tauri::WebviewWindowBuilder`) would render more faithfully (its own
 * process, no `sandbox` ceiling, real devtools) but is a materially bigger
 * change: a second per-platform code path, window/child-webview lifecycle
 * management tied to this pane's own mount/unmount, and IPC to keep its
 * position in sync with Allotment's resizable splits. Worth revisiting if
 * the iframe's limits (below) turn out to matter in practice; not built
 * here.
 *
 * This component does not own its `url` — the same "the tree is the source
 * of truth, not component state" rule `sessionId` already follows for a
 * terminal pane (see `grid/tree.ts`'s `attachBrowser`). `url === ""` is the
 * "nothing typed yet" state: PaneView.tsx's empty-pane picker creates a
 * browser pane with an empty url the instant "Open a browser" is clicked
 * (see that file), and this component shows `EmptyBrowserPane` until a
 * first navigation calls `onNavigate` with something real.
 *
 * --- Honest limits (see also README.md's own "Browser panes" section) ---
 * Many public sites refuse to render inside ANY frame at all, via an
 * `X-Frame-Options` or `Content-Security-Policy: frame-ancestors` response
 * header — that is the SITE's choice (an anti-clickjacking measure), not a
 * bug here, and there is no way around it from inside the frame; "Open in
 * system browser" is the only real fallback. And because the framed page
 * is cross-origin from vibespace's own UI, this pane can never see inside
 * it — no devtools, no console capture, nothing beyond "did it load".
 */

/** How long a navigation may sit with no `load` event before this pane
 * calls it "slow" and points at the system-browser button. Deliberately
 * generous — a cold dev-server compile or a slow network shouldn't trip
 * this on every normal load. NOTE: this is NOT a frame-refusal detector —
 * see the `slow` state's own comment below for why. */
const SLOW_LOAD_MS = 10_000;

interface BrowserPaneProps {
  /** This pane's current URL, or `""` if nothing has been navigated to yet. */
  url: string;
  /** Persists a navigation back into this pane's `GridNode` (via App.tsx's
   * `handleBrowserNavigate` -> `grid/tree.ts`'s `attachBrowser`) — this
   * component only ever proposes a URL change, it never owns the value. */
  onNavigate: (url: string) => void;
}

export default function BrowserPane({ url, onNavigate }: BrowserPaneProps) {
  const [inputValue, setInputValue] = useState(url);
  const [error, setError] = useState<string | null>(null);
  // Best-effort "this is taking a while" signal — NOT frame-refusal
  // detection. A cross-origin iframe's `load` event fires the same way
  // whether the page rendered or was silently refused by its own
  // X-Frame-Options/CSP header (the exact finding files/Preview.tsx's own
  // top comment already documents for the app's other embedded-browser
  // view), so "load never fired" cannot reliably mean "blocked" — it just
  // as easily means nothing happened yet because it evaluated instantly.
  // What this DOES catch honestly: a genuinely slow or unreachable host,
  // where the browser is still waiting on a response after ten seconds.
  const [slow, setSlow] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const slowTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Keeps the URL bar in sync if `url` changes from OUTSIDE this component
  // — e.g. a saved workspace layout restoring this pane on a fresh page
  // load, after this component already mounted with the old value.
  useEffect(() => {
    setInputValue(url);
  }, [url]);

  // Arms (or re-arms, on reload) the slow-load timer whenever there's a URL
  // to actually wait on. Cleared either by the iframe's own `onLoad` or by
  // this effect's own cleanup, whichever comes first.
  useEffect(() => {
    if (!url) return;
    setSlow(false);
    clearTimeout(slowTimerRef.current);
    slowTimerRef.current = setTimeout(() => setSlow(true), SLOW_LOAD_MS);
    return () => clearTimeout(slowTimerRef.current);
  }, [url, reloadNonce]);

  const navigate = (raw: string) => {
    const result = normalizeAndValidateUrl(raw);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    setInputValue(result.url);
    onNavigate(result.url);
  };

  const reload = () => setReloadNonce((n) => n + 1);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: SPACE.sm,
          padding: `${SPACE.sm}px ${SPACE.sm}px`,
          borderBottom: "1px solid var(--vd-border)",
          background: "var(--vd-surface)",
          flexShrink: 0,
        }}
      >
        <IconButton title="Reload" onClick={reload}>
          <ReloadIcon />
        </IconButton>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            navigate(inputValue);
          }}
          style={{ flex: 1, minWidth: 0, display: "flex" }}
        >
          <input
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder="Enter a URL — e.g. localhost:3000"
            style={{
              flex: 1,
              minWidth: 0,
              background: "var(--vd-bg)",
              color: "var(--vd-text)",
              border: "1px solid var(--vd-border)",
              borderRadius: RADIUS.sm,
              padding: "4px 8px",
              fontSize: FONT.body,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            }}
          />
        </form>
        <IconButton
          title="Open in system browser"
          onClick={() => {
            if (url) window.open(url, "_blank", "noopener,noreferrer");
          }}
        >
          <OpenInNewIcon />
        </IconButton>
      </div>

      {error && (
        <div
          style={{
            padding: `${SPACE.xs}px ${SPACE.sm}px`,
            fontSize: FONT.meta,
            color: "var(--vd-danger)",
            background: "color-mix(in srgb, var(--vd-danger) 10%, var(--vd-bg))",
            borderBottom: "1px solid var(--vd-border)",
            flexShrink: 0,
          }}
        >
          {error}
        </div>
      )}

      {!url ? (
        <EmptyBrowserPane />
      ) : (
        <>
          {/* Always-visible, honest limits notice (see this file's top
              comment): the one thing this pane can reliably say, since a
              cross-origin `load` event fires whether the page rendered or
              was refused by its own framing headers. */}
          <div style={hintBarStyle}>
            <InfoGlyph />
            <span>
              Many sites refuse to load in a frame (X-Frame-Options / CSP) — that's the site's choice, not a
              bug here. Use "Open in system browser" if a page stays blank.
            </span>
          </div>
          {slow && (
            <div style={hintBarStyle}>
              <InfoGlyph />
              <span>
                This is taking a while — the page may be slow or unreachable. If it never appears, try "Open
                in system browser" above.
              </span>
            </div>
          )}
          <div style={{ flex: 1, minHeight: 0, background: "#fff" }}>
            <iframe
              key={reloadNonce}
              src={url}
              title="Browser pane"
              // Security (see browser/url.ts for the scheme allowlist that
              // gates everything that can ever reach this `src`):
              //
              // `sandbox` is deliberately narrow. `allow-scripts` +
              // `allow-forms` + `allow-popups` are what makes a real dev
              // server usable at all — most break completely without JS.
              // `allow-same-origin` lets the framed page keep ITS OWN
              // origin; WITHOUT it, a sandboxed iframe is forced to an
              // opaque "null" origin, which breaks same-origin fetches,
              // cookies, and localStorage the framed app relies on. Adding
              // `allow-same-origin` to a sandboxed iframe is only safe when
              // the framed page's origin can never be THIS page's own
              // origin (otherwise the two combined let the framed page
              // reach back into its parent) — which holds here: a browser
              // pane always frames a different host/port than vibespace's
              // own UI, never itself.
              //
              // `allow-top-navigation` is deliberately NOT in this list.
              // Without that exclusion, a page running inside this pane
              // could call `window.top.location = "..."` and navigate the
              // ENTIRE vibespace window away — from inside one pane, to a
              // page nobody asked to leave, which would look exactly like
              // the app crashing. Leaving it out means a hostile or just
              // buggy framed page can only ever navigate ITSELF, never its
              // host.
              sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
              referrerPolicy="no-referrer"
              onLoad={() => {
                clearTimeout(slowTimerRef.current);
                setSlow(false);
              }}
              style={{ width: "100%", height: "100%", border: "none", display: "block" }}
            />
          </div>
        </>
      )}
    </div>
  );
}

function EmptyBrowserPane() {
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: SPACE.lg,
        boxSizing: "border-box",
        background: "var(--vd-bg)",
        ...EMPTY_SURFACE_BACKGROUND,
      }}
    >
      <EmptyState
        icon={
          <span
            aria-hidden
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 40,
              height: 40,
              borderRadius: "50%",
              background: "color-mix(in srgb, var(--vd-text-faint) 16%, transparent)",
              color: "var(--vd-text-muted)",
            }}
          >
            <GlobeIcon size={20} />
          </span>
        }
        title="No page open yet"
        description="Type a URL above and press Enter — e.g. localhost:3000 for a dev server running beside this pane."
      />
    </div>
  );
}

const hintBarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: SPACE.xs + 2,
  margin: 0,
  padding: `${SPACE.xs}px ${SPACE.sm}px`,
  fontSize: 11,
  lineHeight: 1.5,
  color: "var(--vd-text)",
  background: "color-mix(in srgb, var(--vd-info) 10%, var(--vd-bg))",
  borderBottom: "1px solid var(--vd-border)",
  flexShrink: 0,
};

function ReloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d="M12 4.5A5 5 0 1 0 12.5 7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" fill="none" />
      <path d="M12 1.5v3.3h-3.3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function OpenInNewIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M6 2.5H2.5a1 1 0 0 0-1 1V11a1 1 0 0 0 1 1H10a1 1 0 0 0 1-1V7.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M7.5 1.5H12.5V6.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.3 1.7L6.7 7.3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

/** A plain "info" glyph (circled i) — same semantic colour/shape as
 * files/Preview.tsx's own `InfoGlyph`, kept as a private copy here rather
 * than importing that one: Preview.tsx is a different centre-view module
 * and neither owns the other. */
function InfoGlyph() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden
      style={{ flexShrink: 0, marginTop: 1, color: "var(--vd-info)" }}
    >
      <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="7" cy="4.6" r="0.8" fill="currentColor" />
      <path d="M7 6.6V10" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

/** A small globe glyph — this pane kind's icon, in both the empty-pane
 * picker's "Open a browser" row (PaneView.tsx) and this component's own
 * empty state. Same hand-drawn, `currentColor`, no-icon-library convention
 * as every other glyph in this codebase (PaneView.tsx's `RemoteGlyph`,
 * `BranchIcon`, ...) — exported (unlike those) since PaneView.tsx needs the
 * identical glyph for its picker row, not a re-derived copy. */
export function GlobeIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden>
      <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.1" />
      <path d="M1.5 7H12.5" stroke="currentColor" strokeWidth="1.1" />
      <path
        d="M7 1.5C8.7 3.2 8.7 10.8 7 12.5C5.3 10.8 5.3 3.2 7 1.5Z"
        stroke="currentColor"
        strokeWidth="1.1"
      />
    </svg>
  );
}
