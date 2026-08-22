import { useRef, type CSSProperties, type KeyboardEvent } from "react";
import type { Workspace } from "@vibedeck/shared";
import { deriveWorkspaceTabs, nextTabIndex } from "./workspaceTabs.js";
import { FONT, RADIUS, SPACE } from "./tokens.js";

/**
 * Workspaces as a horizontal tab strip in the top bar.
 *
 * This is a deliberate return to something this project used to have and
 * then dropped: `WorkspaceRail.tsx` still describes itself as "replacing
 * Phase 0-4's horizontal tab strip". BridgeSpace kept tabs, and their
 * documentation is explicit about both halves of the layout — "Create
 * multiple workspace tabs, each with its own pane layout. Color-code tabs
 * for quick identification", while the left sidebar is described purely as
 * the file browser. So workspaces come back up here, and the sidebar goes
 * back to being about files.
 *
 * This component renders and nothing else. Every piece of workspace state —
 * which one is active, the create form, the rename value, the pending
 * delete confirmation — still lives in `App.tsx`, exactly as it did when
 * the rail owned this UI. Keeping that split is what makes this a restyle
 * rather than a rewrite of behaviour that already works.
 *
 * Colour is an identity cue, not a status one: a workspace's own `color`
 * (nullable — many never set one) tints only a small dot, never the tab's
 * text or background, so contrast never depends on which colour someone
 * picked and no choice of colour can fail a theme.
 */
export interface WorkspaceTabsProps {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  onSwitch: (id: string) => void;
  /** Opens the create form. Deliberately not "create immediately": a
   * workspace needs a name and a directory, and App.tsx already owns that
   * form and its validation. */
  onNewWorkspace: () => void;
  /** Asks to close a workspace. Routed through App.tsx's existing pending-
   * delete confirmation — closing a tab must never be instantly
   * destructive, since a workspace can own running agent sessions. */
  onRequestClose: (id: string) => void;

  /* --- Rename, on double-click -------------------------------------------
   * Renaming used to live in the left rail's workspace list. Once
   * workspaces move up here that list goes away, and rename would have gone
   * with it — an unreachable feature is a regression however tidy the
   * result looks. So the tab owns it now, on double-click: the same gesture
   * that renames a tab in most editors. All the state is still App.tsx's;
   * this only renders it. */
  renamingId: string | null;
  renameValue: string;
  onRenameValueChange: (value: string) => void;
  /** Takes the whole workspace, matching App.tsx's existing `startRename`
   * rather than inventing a second signature for it. */
  onStartRename: (workspace: Workspace) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
}

export default function WorkspaceTabs({
  workspaces,
  activeWorkspaceId,
  onSwitch,
  onNewWorkspace,
  onRequestClose,
  renamingId,
  renameValue,
  onRenameValueChange,
  onStartRename,
  onCommitRename,
  onCancelRename,
}: WorkspaceTabsProps) {
  const tabs = deriveWorkspaceTabs(workspaces);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeIndex = tabs.findIndex((t) => t.id === activeWorkspaceId);

  // WAI-ARIA's horizontal-tabs pattern, with selection following focus —
  // the same behaviour Settings.tsx's rail already implements, so the two
  // tablists in this app never behave differently from each other.
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = nextTabIndex(activeIndex < 0 ? 0 : activeIndex, event.key, tabs.length);
    if (next === null) return;
    event.preventDefault();
    onSwitch(tabs[next].id);
    tabRefs.current[next]?.focus();
  };

  return (
    <div style={stripStyle}>
      <div
        role="tablist"
        aria-label="Workspaces"
        aria-orientation="horizontal"
        onKeyDown={handleKeyDown}
        style={listStyle}
      >
        {tabs.map((tab, i) => {
          const active = tab.id === activeWorkspaceId;

          if (tab.id === renamingId) {
            return (
              <div key={tab.id} style={tabWrapStyle(true)}>
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => onRenameValueChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onCommitRename();
                    if (e.key === "Escape") onCancelRename();
                    // Arrow keys belong to the text cursor while typing, not
                    // to the tablist's roving focus, so stop them here.
                    e.stopPropagation();
                  }}
                  // Committing on blur means clicking away saves rather than
                  // silently discarding what was typed.
                  onBlur={onCommitRename}
                  aria-label={`Rename workspace ${tab.name}`}
                  style={renameInputStyle}
                />
              </div>
            );
          }

          return (
            <div key={tab.id} style={tabWrapStyle(active)}>
              <button
                onDoubleClick={() => {
                  const workspace = workspaces.find((w) => w.id === tab.id);
                  if (workspace) onStartRename(workspace);
                }}
                ref={(el) => {
                  tabRefs.current[i] = el;
                }}
                role="tab"
                aria-selected={active}
                // Roving tabindex: exactly one tab is in the tab order, so
                // Tab moves past the whole strip rather than stepping
                // through every workspace one at a time.
                tabIndex={active ? 0 : -1}
                onClick={() => onSwitch(tab.id)}
                title={tab.name}
                style={tabButtonStyle(active)}
              >
                <span style={dotStyle(tab.color)} aria-hidden />
                <span style={labelStyle}>{tab.name}</span>
              </button>
              <button
                // Not nested inside the tab button — a button cannot
                // contain another button, and nesting them breaks both
                // keyboard activation and the accessibility tree.
                onClick={() => onRequestClose(tab.id)}
                title={`Close ${tab.name}`}
                aria-label={`Close workspace ${tab.name}`}
                style={closeButtonStyle}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      <button onClick={onNewWorkspace} title="New workspace" aria-label="New workspace" style={addButtonStyle}>
        +
      </button>
    </div>
  );
}

/** `minWidth: 0` matters: without it this flex child refuses to shrink
 * below its content, and a long list of workspaces would push the rest of
 * the top bar off screen instead of scrolling within itself. */
const stripStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: SPACE.xs,
  minWidth: 0,
  flex: 1,
};

const listStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: SPACE.xs,
  minWidth: 0,
  overflowX: "auto",
  // The strip scrolls; the page must not. Hidden vertically so a horizontal
  // scrollbar can never add height to a fixed-height top bar.
  overflowY: "hidden",
  scrollbarWidth: "none",
};

function tabWrapStyle(active: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    flexShrink: 0,
    borderRadius: RADIUS.sm,
    background: active ? "var(--vd-surface-raised)" : "transparent",
    border: `1px solid ${active ? "var(--vd-border)" : "transparent"}`,
  };
}

function tabButtonStyle(active: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: SPACE.xs,
    maxWidth: 160,
    padding: "3px 4px 3px 7px",
    background: "transparent",
    border: "none",
    borderRadius: RADIUS.sm,
    color: active ? "var(--vd-text)" : "var(--vd-text-muted)",
    fontSize: FONT.body,
    fontWeight: active ? 500 : 400,
    cursor: "pointer",
    minWidth: 0,
  };
}

/** Sized to roughly match a tab so the strip doesn't jump width the moment
 * a rename starts. */
const renameInputStyle: CSSProperties = {
  width: 130,
  padding: "2px 6px",
  margin: "1px 3px",
  background: "var(--vd-bg)",
  border: "1px solid var(--vd-accent)",
  borderRadius: RADIUS.sm,
  color: "var(--vd-text)",
  fontSize: FONT.body,
  outline: "none",
};

const labelStyle: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
};

/** Falls back to the theme's faint text colour when a workspace never
 * picked one, rather than rendering an empty gap that would misalign the
 * text of coloured and uncoloured tabs against each other. */
function dotStyle(color: string | null): CSSProperties {
  return {
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: color ?? "var(--vd-text-faint)",
    flexShrink: 0,
  };
}

const closeButtonStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 16,
  height: 16,
  marginRight: 3,
  padding: 0,
  background: "transparent",
  border: "none",
  borderRadius: RADIUS.sm,
  color: "var(--vd-text-faint)",
  fontSize: 13,
  lineHeight: 1,
  cursor: "pointer",
  flexShrink: 0,
};

const addButtonStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 20,
  height: 20,
  padding: 0,
  background: "transparent",
  border: "1px solid var(--vd-border)",
  borderRadius: RADIUS.sm,
  color: "var(--vd-text-muted)",
  fontSize: 14,
  lineHeight: 1,
  cursor: "pointer",
  flexShrink: 0,
};
