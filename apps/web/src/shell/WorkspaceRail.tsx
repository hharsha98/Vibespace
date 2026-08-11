import type { Workspace } from "@vibedeck/shared";
import { IconButton, ListRow } from "./ui.js";

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

  renamingId: string | null;
  renameValue: string;
  onRenameValueChange: (value: string) => void;
  onStartRename: (workspace: Workspace) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  renameError: string | null;

  pendingDeleteWorkspaceId: string | null;
  onRequestDelete: (id: string) => void;
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
    renamingId,
    renameValue,
    onRenameValueChange,
    onStartRename,
    onCommitRename,
    onCancelRename,
    renameError,
    pendingDeleteWorkspaceId,
    onRequestDelete,
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
                workspace.id === activeWorkspaceId ? "2px solid var(--vd-accent)" : "2px solid transparent",
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
        overflowY: "auto",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "8px 8px 4px",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            flex: 1,
            fontSize: 10,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--vd-text-faint)",
          }}
        >
          Workspaces
        </span>
        <IconButton title="New workspace" onClick={onOpenCreateForm}>
          <span style={{ fontSize: 14, lineHeight: 1 }}>+</span>
        </IconButton>
        <IconButton title="Collapse workspaces" onClick={onToggleCollapsed}>
          <ChevronIcon direction="left" />
        </IconButton>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "0 8px" }}>
        {workspaces.map((workspace) =>
          renamingId === workspace.id ? (
            <div
              key={workspace.id}
              style={{ display: "flex", alignItems: "center", gap: 4, padding: "2px 0" }}
            >
              <input
                autoFocus
                value={renameValue}
                onChange={(e) => onRenameValueChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onCommitRename();
                  if (e.key === "Escape") onCancelRename();
                }}
                style={{ ...railInputStyle, flex: 1 }}
              />
              <IconButton title="Save name" onClick={onCommitRename}>
                <span style={{ fontSize: 12 }}>✓</span>
              </IconButton>
              <IconButton title="Cancel rename" onClick={onCancelRename}>
                <span style={{ fontSize: 12 }}>✕</span>
              </IconButton>
            </div>
          ) : (
            <div key={workspace.id} style={{ position: "relative" }} className="vd-workspace-row-wrap">
              <ListRow
                active={workspace.id === activeWorkspaceId}
                statusKind={runningCount(workspace) > 0 ? "ok" : "idle"}
                label={workspace.name}
                title={workspace.rootPath}
                onClick={() => onSwitch(workspace.id)}
                trailing={
                  // Stop the click from bubbling up to the ListRow's own
                  // onClick (which switches the active workspace) — without
                  // this, clicking rename/delete ALSO switches to that row's
                  // workspace as a side effect, since these buttons render
                  // inside the row's clickable area. The pre-Phase-4.5
                  // tab-strip version of this UI had the same guard, just
                  // written inline on each button instead of once here.
                  <div
                    onClick={(e) => e.stopPropagation()}
                    style={{ display: "flex", alignItems: "center", gap: 2 }}
                  >
                    {runningCount(workspace) > 0 && (
                      <span
                        style={{
                          fontSize: 10,
                          color: "var(--vd-text-faint)",
                          minWidth: 12,
                          textAlign: "right",
                        }}
                      >
                        {runningCount(workspace)}
                      </span>
                    )}
                    <IconButton
                      title="Rename workspace"
                      onClick={() => onStartRename(workspace)}
                    >
                      <span style={{ fontSize: 11 }}>✎</span>
                    </IconButton>
                    <IconButton
                      title="Delete workspace"
                      onClick={() => onRequestDelete(workspace.id)}
                    >
                      <span style={{ fontSize: 11 }}>✕</span>
                    </IconButton>
                  </div>
                }
              />
            </div>
          )
        )}
      </div>

      {renameError && (
        <p style={{ color: "var(--vd-danger)", fontSize: 11, padding: "4px 8px", margin: 0 }}>{renameError}</p>
      )}

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
  );
}

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
