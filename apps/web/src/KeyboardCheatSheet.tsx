import { useEffect, useRef } from "react";
import { KEYMAP, formatShortcut, isMacPlatform } from "./keys/keymap.js";

interface KeyboardCheatSheetProps {
  onClose: () => void;
}

/**
 * The `?`-button overlay: every keyboard shortcut, in one place, so the
 * keyboard-first workflow this phase adds is actually discoverable instead
 * of only living in this file's source code. Escape closes it, same as
 * every other overlay in the app.
 */
export default function KeyboardCheatSheet({ onClose }: KeyboardCheatSheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const isMac = isMacPlatform();

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => {
      previouslyFocused?.focus();
    };
  }, []);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        style={{
          width: "min(440px, 90vw)",
          maxHeight: "75vh",
          overflowY: "auto",
          background: "var(--vd-surface)",
          border: "1px solid var(--vd-border)",
          borderRadius: 8,
          boxShadow: "0 12px 40px rgba(0, 0, 0, 0.5)",
          padding: "1rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <strong style={{ color: "var(--vd-text)", fontSize: "0.95rem" }}>Keyboard shortcuts</strong>
          <button onClick={onClose} style={closeButtonStyle} title="Close (Esc)">
            ✕
          </button>
        </div>

        <p style={{ color: "var(--vd-text-muted)", fontSize: "0.8rem", margin: "0 0 0.75rem" }}>
          Press <code style={codeStyle}>{isMac ? "⌘K" : "Ctrl+K"}</code> any time to open the command
          palette — every action below (plus workspaces, layouts, and themes) is searchable there too.
        </p>

        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {KEYMAP.filter((s) => s.paneIndex === undefined || s.paneIndex === 0).map((shortcut) => (
            <li
              key={shortcut.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                padding: "0.35rem 0",
                borderBottom: "1px solid var(--vd-border)",
                fontSize: "0.82rem",
              }}
            >
              <span style={{ color: "var(--vd-text)" }}>
                {shortcut.paneIndex === 0 ? "Focus pane 1–9" : shortcut.label}
              </span>
              <span style={{ fontFamily: "monospace", color: "var(--vd-text-muted)", flexShrink: 0 }}>
                {shortcut.paneIndex === 0
                  ? isMac
                    ? "⌘1 … ⌘9"
                    : "Ctrl+1 … Ctrl+9"
                  : formatShortcut(shortcut, isMac)}
              </span>
            </li>
          ))}
          <li
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              padding: "0.35rem 0",
              fontSize: "0.82rem",
            }}
          >
            <span style={{ color: "var(--vd-text)" }}>Search in terminal</span>
            <span style={{ fontFamily: "monospace", color: "var(--vd-text-muted)" }}>
              {isMac ? "⌘F" : "Ctrl+F"}
            </span>
          </li>
        </ul>
      </div>
    </div>
  );
}

const closeButtonStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--vd-text-muted)",
  cursor: "pointer",
  fontSize: 12,
};

const codeStyle: React.CSSProperties = {
  background: "var(--vd-border)",
  padding: "1px 5px",
  borderRadius: 3,
  fontFamily: "monospace",
};
