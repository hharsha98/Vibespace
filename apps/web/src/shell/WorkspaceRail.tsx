import type { Workspace } from "@vibedeck/shared";
import { IconButton } from "./ui.js";
import FileTree from "../files/FileTree.js";

/**
 * The left rail: workspaces as a vertical list (docs/DESIGN.md §1/§5),
 * replacing Phase 0-4's horizontal tab strip. All the actual CRUD state
 * (the create form's fields, the rename-in-progress value, the pending
 * delete confirmation...) still lives in `App.tsx`, same as before this
 * phase — this component only knows how to RENDER that state and forward
 * user actions back up. That split is deliberate: Phase 4.5 is a restyle,
 * not a rewrite, so keeping the state where it already lived (and had
 * working autosave/switch/delete logic wired to it) minimizes the chance of
 * silently regressing behaviour while every pixel around it changes.
 */
export interface WorkspaceRailProps {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Running-pane count for one workspace — see App.tsx's `workspacePaneCount`
   * for how this is derived (a session's `cwd` matching the workspace's
   * `rootPath`, since sessions aren't otherwise tagged with a workspace id). */
  runningCount: (workspace: Workspace) => number;
  onSwitch: (id: string) => void;
  /** Phase 6: opens a file (workspace-relative path) in the editor —
   * forwarded straight through to `<FileTree>`, which lives inside this
   * rail below the workspace list. */
  onOpenFile: (relPath: string) => void;

  showCreateForm: boolean;
  onOpenCreateForm: () => void;
  newWorkspaceName: string;
  onNewWorkspaceNameChange: (value: string) => void;
  newWorkspacePath: string;
  onNewWorkspacePathChange: (value: string) => void;
  onCreateWorkspace: () => void;
  onCancelCreate: () => void;
  creating: boolean;
  createError: string | null;

  /** Why a delete failed, if it did — see the confirmation block below. */
  deleteError: string | null;

  pendingDeleteWorkspaceId: string | null;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;

}

const RAIL_WIDTH = 220;
const RAIL_COLLAPSED_WIDTH = 48;

export default function WorkspaceRail(props: WorkspaceRailProps) {
  const {
    workspaces,
    activeWorkspaceId,
    collapsed,
    onToggleCollapsed,
    runningCount,
    onSwitch,
    onOpenFile,
    showCreateForm,
    onOpenCreateForm,
    newWorkspaceName,
    onNewWorkspaceNameChange,
    newWorkspacePath,
    onNewWorkspacePathChange,
    onCreateWorkspace,
    onCancelCreate,
    creating,
    createError,
    deleteError,
    pendingDeleteWorkspaceId,
    onConfirmDelete,
    onCancelDelete,
  } = props;


  if (collapsed) {
    return (
      <div
        style={{
          width: RAIL_COLLAPSED_WIDTH,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 4,
          padding: "8px 0",
          borderRight: "1px solid var(--vd-border)",
          background: "var(--vd-surface)",
        }}
      >
        <IconButton title="Expand workspaces" onClick={onToggleCollapsed}>
          <ChevronIcon direction="right" />
        </IconButton>
        <IconButton title="New workspace" onClick={onOpenCreateForm}>
          <span style={{ fontSize: 14, lineHeight: 1 }}>+</span>
        </IconButton>
        <div style={{ height: 4 }} />
        {workspaces.map((workspace) => (
          <button
            key={workspace.id}
            type="button"
            onClick={() => onSwitch(workspace.id)}
            title={`${workspace.name} — ${workspace.rootPath}`}
            style={{
              width: 32,
              height: 32,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: workspace.id === activeWorkspaceId ? "var(--vd-surface-raised)" : "transparent",
              border: "none",
              borderLeft:
                workspace.id === activeWorkspaceId
                  ? `${workspace.color ? 3 : 2}px solid ${workspace.color ?? "var(--vd-accent)"}`
                  : "2px solid transparent",
              borderRadius: 4,
              cursor: "pointer",
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: runningCount(workspace) > 0 ? "var(--vd-ok)" : "var(--vd-idle)",
              }}
            />
          </button>
        ))}
      </div>
    );
  }

  return (
    <div
      style={{
        width: RAIL_WIDTH,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        borderRight: "1px solid var(--vd-border)",
        background: "var(--vd-surface)",
        // Phase 6: this column now holds TWO independently-scrolling
        // regions (the workspace list above, the file tree below) instead
        // of one big scrolling column — see the FileTree mount at the
        // bottom of this return. The outer container itself no longer
        // scrolls; each region owns its own overflow.
        overflow: "hidden",
      }}
    >
      {/* Capped at 55% height (not flex:1) so a workspace list long enough
          to need scrolling still leaves room for the file tree below it,
          rather than the file tree only appearing once you've scrolled
          all the way past every workspace. */}
      <div style={{ maxHeight: "55%", overflowY: "auto", flexShrink: 0 }}>
      {showCreateForm && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            padding: 8,
            margin: "6px 8px",
            background: "var(--vd-surface-raised)",
            borderRadius: 6,
          }}
        >
          <input
            autoFocus
            placeholder="Name"
            value={newWorkspaceName}
            onChange={(e) => onNewWorkspaceNameChange(e.target.value)}
            style={railInputStyle}
          />
          <input
            placeholder="Directory (e.g. ~/projects/foo)"
            value={newWorkspacePath}
            onChange={(e) => onNewWorkspacePathChange(e.target.value)}
            style={railInputStyle}
          />
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={onCreateWorkspace} disabled={creating} style={primaryButtonStyle}>
              Create
            </button>
            <button onClick={onCancelCreate} style={secondaryButtonStyle}>
              Cancel
            </button>
          </div>
          {createError && (
            <p style={{ color: "var(--vd-danger)", fontSize: 11, margin: 0 }}>{createError}</p>
          )}
        </div>
      )}

      {pendingDeleteWorkspaceId && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            padding: 8,
            margin: "6px 8px",
            background: "var(--vd-surface-raised)",
            borderRadius: 6,
          }}
        >
          <p style={{ fontSize: 11, color: "var(--vd-text-muted)", margin: 0 }}>
            Delete "
            {workspaces.find((w) => w.id === pendingDeleteWorkspaceId)?.name ?? pendingDeleteWorkspaceId}"?
            Running sessions keep running — only the workspace entry and its saved layout go away.
          </p>
          {/* A delete that failed used to remove the workspace from the UI
              anyway, so it looked deleted and then reappeared on the next
              launch. It now stays put and says why, right where the user
              asked for it. */}
          {deleteError && (
            <p style={{ fontSize: 11, color: "var(--vd-danger)", margin: 0 }}>{deleteError}</p>
          )}
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={onConfirmDelete} style={primaryButtonStyle}>
              Delete
            </button>
            <button onClick={onCancelDelete} style={secondaryButtonStyle}>
              Cancel
            </button>
          </div>
        </div>
      )}
      </div>

      <FileTree workspaceId={activeWorkspaceId} onOpenFile={onOpenFile} />
    </div>
  );
}

/**
 * The small swatch-grid popover opened by a workspace row's colour dot
 * (Phase 9.5c, PARITY #41) — the fixed 8-colour palette plus a "None"
 * option that clears it back to null. Closes on any outside click, same
 * "document click-away listener" pattern Terminal.tsx's own right-click
 * context menu uses (see that file's `contextMenu` effect).
 */

/** A small chevron, inline SVG (no icon library/external request) — points
 * left when the rail is expanded (click to collapse) and right when
 * collapsed (click to expand). */
function ChevronIcon({ direction }: { direction: "left" | "right" }) {
  const d = direction === "left" ? "M9 3L4.5 7L9 11" : "M5 3L9.5 7L5 11";
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d={d} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const railInputStyle: React.CSSProperties = {
  background: "var(--vd-bg)",
  color: "var(--vd-text)",
  border: "1px solid var(--vd-border)",
  borderRadius: 4,
  padding: "4px 6px",
  fontSize: 12,
  boxSizing: "border-box",
  width: "100%",
};

const primaryButtonStyle: React.CSSProperties = {
  background: "var(--vd-accent)",
  color: "var(--vd-accent-text)",
  border: "none",
  borderRadius: 4,
  padding: "4px 10px",
  fontSize: 12,
  cursor: "pointer",
  flex: 1,
};

const secondaryButtonStyle: React.CSSProperties = {
  background: "transparent",
  color: "var(--vd-text-muted)",
  border: "1px solid var(--vd-border)",
  borderRadius: 4,
  padding: "4px 10px",
  fontSize: 12,
  cursor: "pointer",
};

export { RAIL_WIDTH, RAIL_COLLAPSED_WIDTH };
