import { useCallback, useEffect, useState } from "react";
import type { FileEntry, FileTreeResponse } from "@vibedeck/shared";

interface FileTreeProps {
  /** The active workspace's id, or null if none is active. Resetting to a
   * new id (switching workspaces) clears every cached listing and starts
   * fresh — a cached "src/" listing from a DIFFERENT project would be
   * actively wrong to show. */
  workspaceId: string | null;
  onOpenFile: (relPath: string) => void;
}

async function fetchDir(workspaceId: string, path: string): Promise<FileEntry[]> {
  const res = await fetch(
    `/api/files/tree?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(path)}`
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Server responded with ${res.status}`);
  }
  return ((await res.json()) as FileTreeResponse).entries;
}

/**
 * The workspace file tree: a lazy-expanding directory listing in the left
 * rail, below the workspace list (see `shell/WorkspaceRail.tsx`, which
 * mounts this). "Lazy" means a directory's children are only fetched the
 * first time it's expanded — for a workspace with a deep `node_modules`
 * this matters (though that's filtered server-side too, see
 * `apps/server/src/files/routes.ts`'s `IGNORED_DIR_NAMES`), and it means
 * opening the tree never pays for more than what's actually visible.
 *
 * Has its OWN collapse toggle (the little header below), independent of the
 * whole left rail's collapse — per docs/DESIGN.md this section lives inside
 * the rail, but can hide itself without hiding the workspace list above it.
 */
export default function FileTree({ workspaceId, onOpenFile }: FileTreeProps) {
  const [sectionCollapsed, setSectionCollapsed] = useState(false);
  const [rootEntries, setRootEntries] = useState<FileEntry[] | null>(null);
  const [rootError, setRootError] = useState<string | null>(null);
  const [rootLoading, setRootLoading] = useState(false);

  // Cache of already-fetched directory listings, keyed by workspace-relative
  // path — populated lazily as the user expands directories, never cleared
  // except on a workspace switch (see the effect below).
  const [childrenByPath, setChildrenByPath] = useState<Map<string, FileEntry[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [errorPaths, setErrorPaths] = useState<Map<string, string>>(new Map());

  // Reset everything and (re)load the root listing whenever the active
  // workspace changes — a stale cache from a different project's directory
  // structure would be actively misleading here, not just unhelpful.
  useEffect(() => {
    setRootEntries(null);
    setRootError(null);
    setChildrenByPath(new Map());
    setExpanded(new Set());
    setLoadingPaths(new Set());
    setErrorPaths(new Map());

    if (!workspaceId) return;
    setRootLoading(true);
    fetchDir(workspaceId, ".")
      .then((entries) => setRootEntries(entries))
      .catch((err: unknown) => setRootError(err instanceof Error ? err.message : "Failed to load"))
      .finally(() => setRootLoading(false));
  }, [workspaceId]);

  const loadChildren = useCallback(
    (path: string) => {
      if (!workspaceId) return;
      setLoadingPaths((prev) => new Set(prev).add(path));
      fetchDir(workspaceId, path)
        .then((entries) => {
          setChildrenByPath((prev) => new Map(prev).set(path, entries));
          setErrorPaths((prev) => {
            if (!prev.has(path)) return prev;
            const next = new Map(prev);
            next.delete(path);
            return next;
          });
        })
        .catch((err: unknown) => {
          setErrorPaths((prev) =>
            new Map(prev).set(path, err instanceof Error ? err.message : "Failed to load")
          );
        })
        .finally(() => {
          setLoadingPaths((prev) => {
            const next = new Set(prev);
            next.delete(path);
            return next;
          });
        });
    },
    [workspaceId]
  );

  const toggleDir = useCallback(
    (path: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
          // First expansion of this path — fetch its children. Later
          // toggles (collapse, then re-expand) reuse the cached listing.
          if (!childrenByPath.has(path)) loadChildren(path);
        }
        return next;
      });
    },
    [childrenByPath, loadChildren]
  );

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <button
        type="button"
        onClick={() => setSectionCollapsed((c) => !c)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "6px 8px",
          background: "transparent",
          border: "none",
          borderTop: "1px solid var(--vd-border)",
          cursor: "pointer",
          flexShrink: 0,
        }}
        title={sectionCollapsed ? "Expand files" : "Collapse files"}
      >
        <ChevronGlyph direction={sectionCollapsed ? "right" : "down"} />
        <span
          style={{
            fontSize: 10,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--vd-text-faint)",
          }}
        >
          Files
        </span>
      </button>

      {!sectionCollapsed && (
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingBottom: 8 }}>
          {!workspaceId ? (
            <EmptyRow>No active workspace.</EmptyRow>
          ) : rootLoading ? (
            <EmptyRow>Loading…</EmptyRow>
          ) : rootError ? (
            <EmptyRow error>{rootError}</EmptyRow>
          ) : rootEntries && rootEntries.length === 0 ? (
            <EmptyRow>Empty directory.</EmptyRow>
          ) : (
            rootEntries?.map((entry) => (
              <FileTreeNode
                key={entry.path}
                entry={entry}
                depth={0}
                expanded={expanded}
                childrenByPath={childrenByPath}
                loadingPaths={loadingPaths}
                errorPaths={errorPaths}
                onToggleDir={toggleDir}
                onOpenFile={onOpenFile}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

interface FileTreeNodeProps {
  entry: FileEntry;
  depth: number;
  expanded: Set<string>;
  childrenByPath: Map<string, FileEntry[]>;
  loadingPaths: Set<string>;
  errorPaths: Map<string, string>;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
}

/** One row (and, if it's an expanded directory, its children) — recursive,
 * so a deeply nested tree is just this component calling itself. */
function FileTreeNode({
  entry,
  depth,
  expanded,
  childrenByPath,
  loadingPaths,
  errorPaths,
  onToggleDir,
  onOpenFile,
}: FileTreeNodeProps) {
  const isDir = entry.kind === "dir";
  const isExpanded = isDir && expanded.has(entry.path);
  const indent = 8 + depth * 12;

  return (
    <>
      <div
        onClick={() => (isDir ? onToggleDir(entry.path) : onOpenFile(entry.path))}
        title={entry.path}
        className="vd-list-row"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          height: 22,
          paddingLeft: indent,
          paddingRight: 8,
          cursor: "pointer",
          fontSize: 12,
          color: "var(--vd-text)",
          borderRadius: 4,
        }}
      >
        {isDir ? <ChevronGlyph direction={isExpanded ? "down" : "right"} /> : <span style={{ width: 10, flexShrink: 0 }} />}
        {isDir ? <FolderIcon /> : <FileIcon />}
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {entry.name}
        </span>
      </div>

      {isExpanded &&
        (loadingPaths.has(entry.path) ? (
          <EmptyRow indent={indent + 14}>Loading…</EmptyRow>
        ) : errorPaths.has(entry.path) ? (
          <EmptyRow indent={indent + 14} error>
            {errorPaths.get(entry.path)}
          </EmptyRow>
        ) : (
          (childrenByPath.get(entry.path) ?? []).map((child) => (
            <FileTreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              expanded={expanded}
              childrenByPath={childrenByPath}
              loadingPaths={loadingPaths}
              errorPaths={errorPaths}
              onToggleDir={onToggleDir}
              onOpenFile={onOpenFile}
            />
          ))
        ))}
    </>
  );
}

function EmptyRow({
  children,
  error,
  indent = 8,
}: {
  children: React.ReactNode;
  error?: boolean;
  indent?: number;
}) {
  return (
    <div
      style={{
        padding: `2px 8px 2px ${indent}px`,
        fontSize: 11,
        color: error ? "var(--vd-danger)" : "var(--vd-text-faint)",
      }}
    >
      {children}
    </div>
  );
}

/** A small chevron — right when collapsed, down when expanded. Inline SVG,
 * no icon library, matching WorkspaceRail's own ChevronIcon convention
 * (that one only needs left/right; this one needs right/down). */
function ChevronGlyph({ direction }: { direction: "right" | "down" }) {
  const d = direction === "right" ? "M4 2.5L8.5 6L4 9.5" : "M2.5 4L6 8.5L9.5 4";
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden style={{ flexShrink: 0 }}>
      <path d={d} stroke="var(--vd-text-faint)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden style={{ flexShrink: 0 }}>
      <path
        d="M1.5 3.5A1 1 0 0 1 2.5 2.5h3l1 1.2h5a1 1 0 0 1 1 1v6.3a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V3.5Z"
        fill="var(--vd-info)"
        fillOpacity="0.25"
        stroke="var(--vd-info)"
        strokeWidth="1"
      />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden style={{ flexShrink: 0 }}>
      <path
        d="M3.5 1.5h5l3 3v7a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z"
        stroke="var(--vd-text-faint)"
        strokeWidth="1"
      />
      <path d="M8.5 1.5v3h3" stroke="var(--vd-text-faint)" strokeWidth="1" />
    </svg>
  );
}
