/**
 * Polls `GET /api/git/branch` for a workspace's current git branch (Phase
 * 9.5c, PARITY #13b) — the pane header's `⑂ main` chip in PaneView.tsx.
 *
 * --- Why polling, and not a filesystem watch ---
 * The obvious "instant" alternative is watching `.git/HEAD` (and the ref it
 * points at) for changes, the way `files/routes.ts` already watches a
 * workspace's files with chokidar. That's deliberately NOT what this does:
 * `.git` internals are noisy and version-control-specific in ways a plain
 * chokidar watch would need to special-case (packed-refs, detached HEAD,
 * `git worktree`'s indirection, submodules...), and every terminal pane
 * already polls independently (see below) — wiring up a *second*,
 * per-workspace watcher just to shave the last few seconds off branch-
 * change detection isn't worth the extra moving part for a chip that is
 * inherently "recently accurate," not "live."
 *
 * --- Staleness window ---
 * A branch switch (`git checkout`) made in one pane's shell is reflected in
 * every pane's chip within one `POLL_INTERVAL_MS` window — up to 15 seconds
 * stale. That's an accepted trade for simplicity: nobody is making
 * split-second decisions off this chip, and 15s keeps the request volume
 * low even with many panes open (see the per-pane cost note below).
 *
 * --- Per-pane cost, honestly ---
 * Every pane in a workspace currently shares that workspace's rootPath as
 * its session cwd (see App.tsx's `sessionsForWorkspace`), so N panes means N
 * independent polls of the SAME branch every interval — there is no
 * workspace-level dedup/cache here. `git rev-parse`/`symbolic-ref` are cheap
 * (a few filesystem stats, no network), so this is deliberately left simple
 * rather than adding a shared-cache store (like `blockStore.ts`'s tracker
 * registry) for what would only ever save a handful of near-instant local
 * requests every 15 seconds.
 */
import { useEffect, useRef, useState } from "react";
import type { GitBranchResponse } from "@vibedeck/shared";

const POLL_INTERVAL_MS = 15_000;

export function useGitBranch(workspaceId: string | null): GitBranchResponse | null {
  const [result, setResult] = useState<GitBranchResponse | null>(null);
  // Guards against a slow response from a PREVIOUS workspaceId landing after
  // the effect has already moved on to a new one — see the cleanup below.
  const requestIdRef = useRef(0);

  useEffect(() => {
    setResult(null);
    if (!workspaceId) return;

    const thisRequestId = ++requestIdRef.current;
    let cancelled = false;

    const poll = () => {
      fetch(`/api/git/branch?workspaceId=${encodeURIComponent(workspaceId)}`)
        .then((res) => (res.ok ? (res.json() as Promise<GitBranchResponse>) : null))
        .then((body) => {
          if (cancelled || requestIdRef.current !== thisRequestId || !body) return;
          setResult(body);
        })
        .catch(() => {
          // Transient network hiccup — keep showing the last known branch
          // rather than flickering the chip away; the next poll will
          // recover on its own.
        });
    };

    poll(); // Fire immediately so the chip isn't blank for a full interval on first mount.
    const timer = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [workspaceId]);

  return result;
}
