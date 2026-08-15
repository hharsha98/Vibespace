import { useEffect, useState } from "react";
import { WORKSPACE_COLORS, type Workspace } from "@vibedeck/shared";
import { IconButton, ListRow } from "./ui.js";
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

  /** Phase 9.5c, PARITY #41: sets (or, with `null`, clears) a workspace's
   * chosen colour. The picker popover's own open/closed state is transient
   * UI state owned locally by this component (see the file's top comment
   * for why that split, not App.tsx-lifted state, is the right call here) —
   * only the actual mutation is lifted up, same as every other write in
   * this file. */
  onSetWorkspaceColor: (id: string, color: string | null) => void;
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
    onSetWorkspaceColor,
  } = props;

  // Phase 9.5c: which row's colour-picker popover is currently open, if
  // any — purely transient UI state, same "local, not lifted to App.tsx"
  // treatment Terminal.tsx's right-click `contextMenu` state gets.
  const [colorPickerOpenId, setColorPickerOpenId] = useState<string | null>(null);

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

      <div style={{ display: "flex", flexDirection: "column", gap: 3, padding: "0 8px" }}>
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
                // Phase 9.5c, PARITY #41: an active row with a chosen
                // colour gets ITS colour as the thick left edge instead of
                // the theme's default accent — see ListRow's own
                // `accentColor` doc comment. `undefined` (not `workspace.
                // color` directly, which is `string | null`) so a null
                // colour genuinely falls back to ListRow's own default
                // rather than passing `null` through as a CSS value.
                accentColor={workspace.color ?? undefined}
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
                    style={{ display: "flex", alignItems: "center", gap: 3, position: "relative" }}
                  >
                    {/* Always visible — this is information (which colour
                        this workspace carries, how many panes are running),
                        not a destructive action, so it doesn't hide behind
                        hover the way rename/delete now do below. */}
                    <button
                      type="button"
                      onClick={() =>
                        setColorPickerOpenId((open) => (open === workspace.id ? null : workspace.id))
                      }
                      title={workspace.color ? "Change workspace colour" : "Set workspace colour"}
                      style={{
                        width: 12,
                        height: 12,
                        borderRadius: "50%",
                        flexShrink: 0,
                        cursor: "pointer",
                        padding: 0,
                        background: workspace.color ?? "transparent",
                        border: workspace.color
                          ? "1px solid var(--vd-border)"
                          : "1px dashed var(--vd-text-faint)",
                      }}
                    />
                    {colorPickerOpenId === workspace.id && (
                      <ColorPickerPopover
                        current={workspace.color}
                        onPick={(color) => {
                          onSetWorkspaceColor(workspace.id, color);
                          setColorPickerOpenId(null);
                        }}
                        onClose={() => setColorPickerOpenId(null)}
                      />
                    )}
                    {runningCount(workspace) > 0 && (
                      <span
                        style={{
                          fontSize: 10,
                          color: "var(--vd-ok)",
                          fontWeight: 600,
                          minWidth: 12,
                          textAlign: "right",
                        }}
                      >
                        {runningCount(workspace)}
                      </span>
                    )}
                    {/* Rename/delete: destructive/rarely-used controls, so
                        they only reveal on hover/focus (see the
                        .vd-workspace-row-actions rule in shell/ui.tsx's
                        GlobalShellStyles) — a resting row shows just its
                        name, colour and count, not five icons crammed
                        together. */}
                    <span
                      className="vd-workspace-row-actions"
                      style={{ display: "flex", alignItems: "center", gap: 1 }}
                    >
                      <IconButton title="Rename workspace" onClick={() => onStartRename(workspace)}>
                        <span style={{ fontSize: 11 }}>✎</span>
                      </IconButton>
                      <IconButton title="Delete workspace" onClick={() => onRequestDelete(workspace.id)}>
                        <span style={{ fontSize: 11 }}>✕</span>
                      </IconButton>
                    </span>
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
function ColorPickerPopover({
  current,
  onPick,
  onClose,
}: {
  current: string | null;
  onPick: (color: string | null) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onClickAway = () => onClose();
    // Deferred to the next tick: the swatch dot's own onClick (which opens
    // this popover) also bubbles to `document` in the SAME click event —
    // without a delay, this listener would fire immediately and close the
    // popover the instant it opens.
    const timer = setTimeout(() => document.addEventListener("click", onClickAway), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("click", onClickAway);
    };
  }, [onClose]);

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        top: "100%",
        left: 0,
        marginTop: 4,
        zIndex: 30,
        display: "grid",
        gridTemplateColumns: "repeat(4, 1fr)",
        gap: 4,
        padding: 6,
        background: "var(--vd-surface-raised)",
        border: "1px solid var(--vd-border)",
        borderRadius: 6,
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.4)",
      }}
    >
      <button
        type="button"
        onClick={() => onPick(null)}
        title="No colour"
        style={{
          width: 18,
          height: 18,
          borderRadius: "50%",
          cursor: "pointer",
          background: "transparent",
          border: current === null ? "2px solid var(--vd-accent)" : "1px dashed var(--vd-text-faint)",
          padding: 0,
        }}
      />
      {WORKSPACE_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          onClick={() => onPick(color)}
          title={color}
          style={{
            width: 18,
            height: 18,
            borderRadius: "50%",
            cursor: "pointer",
            background: color,
            border: current === color ? "2px solid var(--vd-text)" : "1px solid var(--vd-border)",
            padding: 0,
          }}
        />
      ))}
      <button
        type="button"
        onClick={onClose}
        title="Close"
        style={{
          gridColumn: "1 / -1",
          background: "transparent",
          border: "none",
          color: "var(--vd-text-faint)",
          fontSize: 10,
          cursor: "pointer",
          padding: "2px 0 0",
        }}
      >
        Close
      </button>
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
