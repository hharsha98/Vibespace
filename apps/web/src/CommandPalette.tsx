import { useEffect, useMemo, useRef, useState } from "react";

/** One entry the palette can run. `App.tsx` builds the full list (every
 * keyboard action, every workspace, every layout template, every theme,
 * every "start agent" option) — this component only knows how to filter,
 * navigate, and run whatever it's handed. */
export interface PaletteCommand {
  id: string;
  label: string;
  /** Shown as a small prefix badge, e.g. "Workspace", "Layout", "Theme". Omit for plain actions. */
  category?: string;
  /** Pre-formatted shortcut string (e.g. "⌘K"), shown right-aligned. */
  shortcut?: string;
  run: () => void;
}

interface CommandPaletteProps {
  commands: PaletteCommand[];
  onClose: () => void;
}

/** Case-insensitive subsequence match — "cwd" matches "Close Workspace
 * Dialog" — good enough fuzzy filtering without pulling in a library for
 * what's fundamentally a short, fixed list of commands. */
function fuzzyMatch(query: string, text: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

/**
 * The `Cmd+K` command palette: a centered overlay with a fuzzy-filterable
 * list of every action the app knows how to run. Plain DOM/React only — no
 * `<dialog>`, no `window.prompt`/`confirm` — both because those freeze
 * automated/browser-tool interaction and because a `<dialog>`'s built-in
 * focus trapping doesn't play well with restoring focus to a specific pane
 * on close (see the effect below).
 */
export default function CommandPalette({ commands, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(
    () => commands.filter((c) => fuzzyMatch(query, c.label) || fuzzyMatch(query, c.category ?? "")),
    [commands, query]
  );

  // Focus the search input the moment the palette opens, and restore focus
  // to whatever had it before (typically a terminal pane) once the palette
  // closes — so pressing Escape or running a command drops the user right
  // back into typing where they left off, instead of leaving focus stuck
  // on a now-unmounted input.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => {
      previouslyFocused?.focus();
    };
  }, []);

  // Keep the selected row in range as filtering shrinks the list.
  useEffect(() => {
    setSelectedIndex((i) => Math.min(i, Math.max(filtered.length - 1, 0)));
  }, [filtered.length]);

  const runSelected = () => {
    const command = filtered[selectedIndex];
    if (!command) return;
    onClose();
    command.run();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
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
      // the panel itself, see stopPropagation below) closes the palette.
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
        style={{
          width: "min(560px, 90vw)",
          maxHeight: "60vh",
          display: "flex",
          flexDirection: "column",
          background: "var(--vd-surface)",
          border: "1px solid var(--vd-border)",
          borderRadius: 8,
          boxShadow: "0 12px 40px rgba(0, 0, 0, 0.5)",
          overflow: "hidden",
        }}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Type a command…"
          style={{
            padding: "0.75rem 1rem",
            background: "transparent",
            color: "var(--vd-text)",
            border: "none",
            borderBottom: "1px solid var(--vd-border)",
            fontSize: "0.95rem",
            outline: "none",
          }}
        />
        <ul style={{ listStyle: "none", margin: 0, padding: "4px 0", overflowY: "auto" }}>
          {filtered.length === 0 && (
            <li style={{ padding: "0.6rem 1rem", color: "var(--vd-text-muted)", fontSize: "0.85rem" }}>
              No matching commands.
            </li>
          )}
          {filtered.map((command, index) => (
            <li
              key={command.id}
              // Selecting with the mouse should feel the same as arrowing to
              // a row: hover updates the highlighted row, click runs it.
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => {
                onClose();
                command.run();
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "0.5rem 1rem",
                cursor: "pointer",
                background: index === selectedIndex ? "var(--vd-accent)" : "transparent",
                color: index === selectedIndex ? "var(--vd-accent-text)" : "var(--vd-text)",
                fontSize: "0.85rem",
              }}
            >
              {command.category && (
                <span
                  style={{
                    fontSize: "0.7rem",
                    padding: "1px 6px",
                    borderRadius: 3,
                    background:
                      index === selectedIndex ? "rgba(255,255,255,0.25)" : "var(--vd-border)",
                    color: index === selectedIndex ? "inherit" : "var(--vd-text-muted)",
                    flexShrink: 0,
                  }}
                >
                  {command.category}
                </span>
              )}
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {command.label}
              </span>
              {command.shortcut && (
                <span
                  style={{
                    fontSize: "0.75rem",
                    opacity: 0.8,
                    flexShrink: 0,
                    fontFamily: "monospace",
                  }}
                >
                  {command.shortcut}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
