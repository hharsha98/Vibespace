/**
 * The Cmd+P quick-open file finder: fuzzy-search over every file in the
 * active workspace, reusing `OverlayPalette` (the same chrome the Cmd+K
 * command palette uses).
 *
 * `GET /api/files/tree` only ever returns ONE directory level (by design —
 * see `apps/server/src/files/routes.ts`), so there's no single endpoint
 * that returns "every file in the workspace" in one call. This walks the
 * tree breadth-first, one level at a time, fetching every directory at the
 * current depth in parallel before moving to the next — the same
 * server-side default ignore list (node_modules/.git/dist/dotfiles) that
 * FileTree.tsx benefits from keeps this from blowing up on a typical
 * project. For very large repositories this walk could be slow; there's no
 * dedicated recursive-search endpoint yet (a reasonable Phase 7+ addition
 * if this becomes a real pain point).
 */
import { useEffect, useMemo, useState } from "react";
import type { FileTreeResponse } from "@vibespace/shared";
import OverlayPalette, { fuzzyMatch } from "../OverlayPalette.js";

interface QuickOpenProps {
  workspaceId: string | null;
  onClose: () => void;
  onOpenFile: (path: string) => void;
}

async function fetchDir(workspaceId: string, path: string): Promise<{ path: string; kind: "file" | "dir" }[]> {
  const res = await fetch(
    `/api/files/tree?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(path)}`
  );
  if (!res.ok) throw new Error(`Server responded with ${res.status}`);
  return ((await res.json()) as FileTreeResponse).entries;
}

async function listAllFiles(workspaceId: string): Promise<string[]> {
  const files: string[] = [];
  let frontier = ["."];
  while (frontier.length > 0) {
    const results = await Promise.all(
      frontier.map((dir) => fetchDir(workspaceId, dir).catch(() => []))
    );
    const nextFrontier: string[] = [];
    for (const entries of results) {
      for (const entry of entries) {
        if (entry.kind === "dir") nextFrontier.push(entry.path);
        else files.push(entry.path);
      }
    }
    frontier = nextFrontier;
  }
  return files;
}

/** Cap how many filtered results actually render — the fuzzy match itself
 * still runs over every indexed file, but a huge match list would just be
 * scroll noise; the top N (in the workspace's natural tree order) is
 * plenty to find what you're after by typing a couple more characters. */
const MAX_RESULTS = 200;

function fileNameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}
function dirNameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

export default function QuickOpen({ workspaceId, onClose, onOpenFile }: QuickOpenProps) {
  const [query, setQuery] = useState("");
  const [allFiles, setAllFiles] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    setAllFiles(null);
    setError(null);
    listAllFiles(workspaceId)
      .then((files) => {
        if (!cancelled) setAllFiles(files);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to index files");
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const items = useMemo(() => {
    if (!allFiles) return [];
    const filtered = query ? allFiles.filter((f) => fuzzyMatch(query, f)) : allFiles;
    return filtered
      .slice(0, MAX_RESULTS)
      .map((path) => ({ id: path, label: fileNameOf(path), category: dirNameOf(path) || undefined, path }));
  }, [allFiles, query]);

  return (
    <OverlayPalette
      items={items}
      query={query}
      onQueryChange={setQuery}
      placeholder="Quick open a file…"
      emptyMessage={!workspaceId ? "No active workspace." : !allFiles ? (error ?? "Indexing files…") : "No matching files."}
      onClose={onClose}
      onRun={(item) => onOpenFile(item.path)}
    />
  );
}
