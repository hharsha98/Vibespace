import { useState } from "react";
import { IconButton } from "../shell/ui.js";
import { RADIUS, SPACE } from "../shell/tokens.js";

const DEFAULT_URL = "http://localhost:3000";

/**
 * A live browser preview of whatever dev server is running in the active
 * workspace (Vite, Next, etc — same idea as opening `localhost:3000` in a
 * normal browser tab, just embedded next to the terminals that started it).
 *
 * NOTE on why this can't always work: many sites (and most production
 * apps, plus some dev servers with strict defaults) send an
 * `X-Frame-Options` or `Content-Security-Policy: frame-ancestors` header
 * that tells the BROWSER to refuse to render them inside an `<iframe>` —
 * this is a security feature (anti-clickjacking), and there is no way for
 * JavaScript on this page to detect or bypass it: the browser just shows a
 * blank frame with no error event we can observe (a cross-origin iframe's
 * `load` event fires either way, and its `contentWindow` is opaque to us).
 * Rather than pretend we can detect this and show a misleading "it's
 * broken" message, the hint below is always visible — an honest,
 * permanent reminder rather than a fake diagnosis — and "Open in new tab"
 * is always one click away as the reliable fallback.
 */
export default function Preview() {
  const [url, setUrl] = useState(DEFAULT_URL);
  const [inputValue, setInputValue] = useState(DEFAULT_URL);
  const [reloadNonce, setReloadNonce] = useState(0);

  const navigate = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    setUrl(withProtocol);
    setInputValue(withProtocol);
  };

  const reload = () => {
    // Bumping the iframe's `key` forces a full remount, which reliably
    // reloads it — `iframe.contentWindow.location.reload()` throws for a
    // cross-origin frame, which most previewed dev servers are (different
    // port than vibedeck's own web UI).
    setReloadNonce((n) => n + 1);
  };

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
            placeholder={DEFAULT_URL}
            style={{
              flex: 1,
              minWidth: 0,
              background: "var(--vd-bg)",
              color: "var(--vd-text)",
              border: "1px solid var(--vd-border)",
              borderRadius: RADIUS.sm,
              padding: "4px 8px",
              fontSize: 12,
              fontFamily: "monospace",
            }}
          />
        </form>
        <IconButton title="Open in new tab" onClick={() => window.open(url, "_blank", "noopener,noreferrer")}>
          <OpenInNewIcon />
        </IconButton>
      </div>

      {/* Stage B: was a bare muted <p> — the one honest thing this view can
          always say (see this file's top comment on why a blank iframe
          can't be detected from JS) now reads as a designed notice, same
          tinted-banner idiom Editor.tsx's conflict/error bars already use,
          just in --vd-info since this isn't a warning about anything that
          went wrong. */}
      <div style={hintBarStyle}>
        <InfoGlyph />
        <span>
          Some sites refuse to be framed (X-Frame-Options / CSP) and will show blank below — use "Open in new
          tab" if so.
        </span>
      </div>

      {/*
        The one deliberate hard-coded colour in the app. DESIGN.md says
        chrome must use theme tokens — but this is not chrome, it is the
        canvas *behind someone else's web page*. Pages overwhelmingly assume
        a white backdrop, so a page with a transparent background rendered
        over our dark surface would look broken through no fault of its own.
        Do not "fix" this to a token.
      */}
      <div style={{ flex: 1, minHeight: 0, background: "#fff" }}>
        <iframe
          key={reloadNonce}
          src={url}
          title="Preview"
          style={{ width: "100%", height: "100%", border: "none", display: "block" }}
        />
      </div>
    </div>
  );
}

function ReloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M12 4.5A5 5 0 1 0 12.5 7"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        fill="none"
      />
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

/** A plain "info" glyph (circled i) for the always-visible framing-limits
 * notice — `--vd-info`, the same semantic colour every other informational
 * (non-warning, non-error) affordance in the app uses. */
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
