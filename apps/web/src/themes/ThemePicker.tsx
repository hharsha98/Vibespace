import { useEffect, useRef } from "react";
import { THEMES } from "./themes.js";
import { MOTION, SHADOW_VAR } from "../shell/tokens.js";

interface ThemePickerProps {
  currentThemeId: string;
  onSelect: (themeId: string) => void;
  onClose: () => void;
}

/**
 * A small overlay listing every built-in theme as a clickable swatch.
 * Reachable from the header's "Theme" button and from `Cmd+Shift+T`.
 * Picking a theme selects it and closes the picker in one action — there's
 * no separate "confirm" step, since switching is instant and harmless to
 * undo (just pick another one).
 */
export default function ThemePicker({ currentThemeId, onSelect, onClose }: ThemePickerProps) {
  const panelRef = useRef<HTMLDivElement>(null);

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

  const darkThemes = THEMES.filter((t) => t.isDark);
  const lightThemes = THEMES.filter((t) => !t.isDark);

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
        className="vd-scale-in"
        style={{
          width: "min(480px, 90vw)",
          maxHeight: "70vh",
          overflowY: "auto",
          background: "var(--vd-surface-raised)",
          border: "1px solid var(--vd-border)",
          borderRadius: 10,
          boxShadow: SHADOW_VAR.lg,
          padding: 12,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "0.5rem",
          }}
        >
          <strong style={{ color: "var(--vd-text)", fontSize: "0.9rem" }}>Theme</strong>
          <button onClick={onClose} style={closeButtonStyle} title="Close (Esc)">
            ✕
          </button>
        </div>

        <ThemeSection label="Dark" themes={darkThemes} currentThemeId={currentThemeId} onSelect={onSelect} />
        <ThemeSection label="Light" themes={lightThemes} currentThemeId={currentThemeId} onSelect={onSelect} />
      </div>
    </div>
  );
}

/** Exported (not just used by the overlay above) so Settings.tsx (Phase
 * 9.5c, PARITY #45) can render the exact same swatch grid inline, mirroring
 * — not duplicating — the nav-bar theme picker's own rendering, per that
 * phase's "move or mirror it" instruction. */
export function ThemeSection({
  label,
  themes,
  currentThemeId,
  onSelect,
}: {
  label: string;
  themes: typeof THEMES;
  currentThemeId: string;
  onSelect: (id: string) => void;
}) {
  if (themes.length === 0) return null;
  return (
    <div style={{ marginBottom: "0.5rem" }}>
      <div style={{ fontSize: "0.7rem", color: "var(--vd-text-muted)", margin: "0.4rem 0.25rem" }}>{label}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 6 }}>
        {themes.map((theme) => (
          <button
            key={theme.id}
            onClick={() => onSelect(theme.id)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "0.4rem 0.6rem",
              borderRadius: 6,
              border: `1px solid ${theme.id === currentThemeId ? "var(--vd-accent)" : "var(--vd-border)"}`,
              background: theme.id === currentThemeId ? "var(--vd-accent)" : "transparent",
              color: theme.id === currentThemeId ? "var(--vd-accent-text)" : "var(--vd-text)",
              cursor: "pointer",
              fontSize: "0.8rem",
              textAlign: "left",
              // Motion pass: picking a theme (or just hovering a swatch)
              // now eases instead of snapping between selected/unselected.
              transition: `background-color ${MOTION.fast} ${MOTION.easing}, border-color ${MOTION.fast} ${MOTION.easing}, color ${MOTION.fast} ${MOTION.easing}`,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 14,
                height: 14,
                borderRadius: "50%",
                flexShrink: 0,
                background: theme.terminal.background,
                border: `1px solid ${theme.terminal.foreground}`,
              }}
            />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {theme.name}
            </span>
          </button>
        ))}
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
