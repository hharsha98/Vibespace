import { useMemo, useState } from "react";
import OverlayPalette, { fuzzyMatch } from "./OverlayPalette.js";

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

/**
 * The `Cmd+K` command palette: a centered overlay with a fuzzy-filterable
 * list of every action the app knows how to run. The overlay chrome itself
 * (backdrop, panel, input, list, arrow/Enter/Escape navigation) lives in
 * `OverlayPalette.tsx`, shared with Phase 6's Cmd+P quick-open — this
 * component only owns fuzzy-filtering `commands` and mapping them to the
 * shape `OverlayPalette` renders.
 */
export default function CommandPalette({ commands, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(
    () => commands.filter((c) => fuzzyMatch(query, c.label) || fuzzyMatch(query, c.category ?? "")),
    [commands, query]
  );

  return (
    <OverlayPalette
      items={filtered.map((c) => ({ id: c.id, category: c.category, label: c.label, trailing: c.shortcut, run: c.run }))}
      query={query}
      onQueryChange={setQuery}
      placeholder="Type a command…"
      emptyMessage="No matching commands."
      onClose={onClose}
      onRun={(item) => item.run()}
    />
  );
}
