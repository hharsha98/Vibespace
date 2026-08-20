import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { SHADOW_VAR } from "./shell/tokens.js";

/**
 * The shared visual/interaction shell behind every "centered search overlay"
 * in vibedeck: the Cmd+K command palette (`CommandPalette.tsx`) and, as of
 * Phase 6, the Cmd+P quick-open file finder (`files/QuickOpen.tsx`). Both
 * are "type to filter a list, arrow to move, Enter to run, click also
 * runs, Escape closes" — extracted here once (per the Phase 6 spec's own
 * instruction) instead of maintaining two near-identical copies of the same
 * backdrop/panel/input/list markup and keyboard handling.
 *
 * Each caller owns its OWN filtering (fuzzy-matching command labels vs.
 * fuzzy-matching file paths are different enough not to share), and hands
 * this component the already-filtered `items` plus an `onRun` callback —
 * this component only owns the chrome and the arrow/Enter/Escape/hover
 * navigation over whatever list it's given.
 */
export interface OverlayItem {
  id: string;
  /** Small uppercase badge shown before the label, e.g. "Workspace" (palette) or a directory (quick open). Omit for none. */
  category?: string;
  label: ReactNode;
  /** Right-aligned content, e.g. a formatted shortcut. */
  trailing?: ReactNode;
}

interface OverlayPaletteProps<T extends OverlayItem> {
  items: T[];
  query: string;
  onQueryChange: (value: string) => void;
  placeholder: string;
  emptyMessage: string;
  onClose: () => void;
  onRun: (item: T) => void;
}

export default function OverlayPalette<T extends OverlayItem>({
  items,
  query,
  onQueryChange,
  placeholder,
  emptyMessage,
  onClose,
  onRun,
}: OverlayPaletteProps<T>) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the search input the moment the overlay opens, and restore focus
  // to whatever had it before (typically a terminal pane, or — as of
  // Phase 6 — the code editor) once it closes, so Escape or running an item
  // drops the user right back into typing where they left off.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => {
      previouslyFocused?.focus();
    };
  }, []);

  // Keep the selected row in range as filtering shrinks the list (the
  // caller re-renders with a new, shorter `items` array on every keystroke).
  useEffect(() => {
    setSelectedIndex((i) => Math.min(i, Math.max(items.length - 1, 0)));
  }, [items.length]);

  const runSelected = () => {
    const item = items[selectedIndex];
    if (!item) return;
    onClose();
    onRun(item);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, items.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      runSelected();
    }
  };

  return (
    <div
      // The backdrop: covers the whole viewport, click anywhere on it (not
      // the panel itself, see stopPropagation below) closes the overlay.
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.5)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "12vh",
        zIndex: 100,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="vd-scale-in"
        style={{
          width: "min(560px, 90vw)",
          maxHeight: "60vh",
          display: "flex",
          flexDirection: "column",
          // "Cards, menus, popovers" — docs/DESIGN.md §2's `--surface-raised`
          // token, and the §4 "10px overlays" radius (vs. panes' 6px).
          background: "var(--vd-surface-raised)",
          border: "1px solid var(--vd-border)",
          borderRadius: 10,
          boxShadow: SHADOW_VAR.lg,
          overflow: "hidden",
        }}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          style={{
            padding: "10px 12px",
            background: "transparent",
            color: "var(--vd-text)",
            border: "none",
            borderBottom: "1px solid var(--vd-border)",
            fontSize: 13,
            outline: "none",
          }}
        />
        <ul style={{ listStyle: "none", margin: 0, padding: "4px 0", overflowY: "auto" }}>
          {items.length === 0 && (
            <li style={{ padding: "8px 12px", color: "var(--vd-text-muted)", fontSize: 12 }}>
              {emptyMessage}
            </li>
          )}
          {items.map((item, index) => (
            <li
              key={item.id}
              // Selecting with the mouse should feel the same as arrowing to
              // a row: hover updates the highlighted row, click runs it.
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => {
                onClose();
                onRun(item);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 12px",
                cursor: "pointer",
                background: index === selectedIndex ? "var(--vd-accent)" : "transparent",
                color: index === selectedIndex ? "var(--vd-accent-text)" : "var(--vd-text)",
                fontSize: 12,
              }}
            >
              {item.category && (
                <span
                  style={{
                    fontSize: 10,
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    padding: "1px 6px",
                    borderRadius: 4,
                    // Selected row: a translucent lighten-over-accent-text
                    // (works regardless of whether accentText is black or
                    // white) instead of a hard-coded rgba white overlay.
                    background:
                      index === selectedIndex
                        ? "color-mix(in srgb, var(--vd-accent-text) 25%, transparent)"
                        : "var(--vd-border)",
                    color: index === selectedIndex ? "inherit" : "var(--vd-text-muted)",
                    flexShrink: 0,
                  }}
                >
                  {item.category}
                </span>
              )}
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {item.label}
              </span>
              {item.trailing && (
                <span
                  style={{
                    fontSize: 11,
                    opacity: 0.8,
                    flexShrink: 0,
                    fontFamily: "monospace",
                  }}
                >
                  {item.trailing}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Case-insensitive subsequence match — "cwd" matches "Close Workspace
 * Dialog" — good enough fuzzy filtering without pulling in a library, for
 * both the command palette's (short, fixed) command list and quick-open's
 * (potentially longer) file-path list. Shared here since both need exactly
 * the same matching rule for "fuzzy" to mean the same thing everywhere in
 * the app. */
export function fuzzyMatch(query: string, text: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}
