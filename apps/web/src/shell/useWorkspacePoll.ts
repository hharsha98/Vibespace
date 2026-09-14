/**
 * Polls `GET /api/workspaces` (Prelaunch DX fix: API-created workspaces
 * stayed invisible until the app remounted).
 *
 * --- Why this exists ---
 * `App.tsx`'s mount effect fetches `GET /api/workspaces` exactly once, with
 * a `[]`-dependency `useEffect`, to seed the rail and build the initial
 * grid. Nothing ever re-fetches it after that. A workspace created through
 * the API directly (rather than the "New workspace" form, which updates
 * local state itself the moment its own `POST` resolves) has no way to
 * reach a page that's already open — the rail simply never learns it
 * exists until a hard refresh.
 *
 * --- Why polling, and not a WebSocket ---
 * There is no app-wide WebSocket connection in this codebase — only
 * `/api/sessions/:id/ws` (one per pty) and `/api/files/watch` (one per
 * workspace's file tree), both scoped to something already open, not a
 * standing connection the whole app could push workspace-list changes
 * over. Building one just for this would be a new kind of moving part for
 * a list that changes rarely; polling is the same trade `useGitBranch.ts`
 * already makes for the same reason (see that file's own "why polling, not
 * a filesystem watch" comment) — this hook is modelled closely on it,
 * right down to the poll interval and the request-id guard below.
 *
 * --- Staleness window ---
 * Same as `useGitBranch`: up to `POLL_INTERVAL_MS` (15s) between a
 * workspace being created/renamed/deleted elsewhere and this tab noticing.
 * Nobody is making split-second decisions off the rail's workspace list,
 * so that's an accepted trade for not adding a second live-update
 * mechanism to the app.
 */
import { useEffect, useRef, useState } from "react";
import type { Workspace } from "@vibespace/shared";

const POLL_INTERVAL_MS = 15_000;

/**
 * Returns the most recently polled workspace list, or `null` before the
 * first successful response has landed. Callers that need to reconcile
 * this against locally-held state (in particular: never let a poll
 * response clobber the active workspace's in-progress `layout` edits — see
 * `mergeWorkspaces` below) should do so themselves; this hook only ever
 * hands back exactly what the server returned, verbatim.
 */
export function useWorkspacePoll(): Workspace[] | null {
  const [result, setResult] = useState<Workspace[] | null>(null);
  // Guards against a slow response landing after a NEWER request has
  // already gone out — same reasoning as useGitBranch's identical guard;
  // there's only ever one "generation" of polling here (this hook isn't
  // parameterised by anything that would restart it), but the guard still
  // protects against two in-flight requests resolving out of order.
  const requestIdRef = useRef(0);

  useEffect(() => {
    const thisRequestId = ++requestIdRef.current;
    let cancelled = false;

    const poll = () => {
      fetch("/api/workspaces")
        .then((res) => (res.ok ? (res.json() as Promise<{ workspaces: Workspace[] }>) : null))
        .then((body) => {
          if (cancelled || requestIdRef.current !== thisRequestId || !body) return;
          setResult(body.workspaces);
        })
        .catch(() => {
          // Transient network hiccup — keep showing the last known
          // workspace list rather than flickering the rail away; the next
          // poll recovers on its own, same as useGitBranch.
        });
    };

    poll(); // Fire immediately so the rail isn't stuck on stale data for a full interval after mount.
    const timer = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return result;
}

/**
 * Reconciles a freshly-polled `server` workspace list against the
 * `local` list currently held in React state, without letting the poll
 * silently discard work in progress.
 *
 * --- The hazard this exists to prevent ---
 * `App.tsx` autosaves the active workspace's `layout` on a 500ms debounce
 * after every grid change (split, close, session attach, ...). A poll
 * landing mid-edit — say, right after the user splits a pane but before
 * the debounced PATCH has reached the server and been reflected back in
 * a subsequent `GET /api/workspaces` — would otherwise overwrite that
 * workspace's `layout` in local state with the server's now-STALE copy,
 * silently reverting the split the user just made. This function's whole
 * job is to make that impossible: for the ACTIVE workspace specifically,
 * the local `layout` always wins, no matter what the server says.
 *
 * --- The rules ---
 * - A workspace present on the server but missing locally is a genuine
 *   addition (created via the API, or by another client) — added as-is.
 * - A workspace present locally but missing from the server's response was
 *   deleted elsewhere — dropped, since mapping over `server` naturally
 *   excludes it.
 * - A workspace present in both takes the server's `name`/`color` (so a
 *   rename or colour change made elsewhere still shows up here) but, if
 *   it's the ACTIVE workspace, keeps the LOCAL `layout` rather than the
 *   server's — see the hazard above. A non-active workspace's `layout` is
 *   safe to take from the server: nothing is actively editing it in this
 *   tab right now.
 * - Ordering follows the server's response order, which is deterministic
 *   (the server itself returns workspaces in a stable order) and simpler
 *   than trying to preserve whatever order local state happened to be in.
 */
export function mergeWorkspaces(
  local: Workspace[],
  server: Workspace[],
  activeWorkspaceId: string | null
): Workspace[] {
  return server.map((serverWorkspace) => {
    const localWorkspace = local.find((w) => w.id === serverWorkspace.id);
    if (!localWorkspace) return serverWorkspace; // new on the server — add as-is
    if (serverWorkspace.id !== activeWorkspaceId) return serverWorkspace; // not active — server's copy is safe to take wholesale
    // Active workspace: everything EXCEPT layout comes from the server (so
    // a rename/colour change elsewhere is still visible), but `layout`
    // stays local — see this function's own top comment for why.
    return { ...serverWorkspace, layout: localWorkspace.layout };
  });
}
