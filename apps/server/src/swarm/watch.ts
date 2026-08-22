/**
 * Conflict detection: this repo's Phase 6 chokidar watcher, reused here to
 * catch a mission's claimed files being written to on disk. See
 * `claims.ts`'s top comment ("this is advisory, not enforcement") for why
 * this exists at all — the claim registry only coordinates agents that
 * check in with it; this watcher is what catches the ones that don't.
 *
 * --- What this can and cannot tell you ---
 * A filesystem watcher can see THAT a path changed. It cannot see WHICH
 * process changed it — chokidar (like any userland fs watcher) gets no
 * PID, no attribution, nothing beyond "this path was written." So a
 * conflict row records the path and WHO CURRENTLY HOLDS THE CLAIM on it —
 * not who actually wrote it, because that information genuinely does not
 * exist at this layer without something far heavier (per-process file-open
 * tracking, which this phase is not signing up to build).
 *
 * A real consequence of that limitation: this WILL also fire for the
 * holder's own perfectly legitimate edit to a file it claimed — there is no
 * way to tell "the holder editing their own claim" apart from "someone else
 * writing over it" with a filesystem watcher alone. A conflict row is a
 * trip-wire for a human/coordinator to glance at ("this claimed path just
 * changed"), not a proven violation. Say this plainly rather than letting
 * the UI/docs imply the registry caught a specific culprit — it didn't; it
 * caught a fact (the path changed) and a fact (who held it at the time).
 *
 * --- Kept cheap: only watches while a mission is running ---
 * One watcher per RUNNING mission — `swarm/routes.ts` opens one when a
 * mission is created/resumed and closes it the moment the mission is
 * paused/stopped/completed, not a permanent watcher on every workspace a
 * mission has ever touched.
 */
import chokidar, { type FSWatcher } from "chokidar";
import { relative, sep } from "node:path";
import type { ClaimsStore } from "./claims.js";

/** Directory names never watched. Duplicated from files/routes.ts's own
 * (unexported) list rather than importing it — one small constant, and it
 * keeps this module from reaching into another route module's internals
 * for it. Kept in sync by hand; if that ever drifts, the cost is just a
 * few more/fewer paths watched, not a correctness bug. */
const IGNORED_DIR_NAMES = new Set(["node_modules", ".git", "dist"]);

/**
 * Starts watching `workspaceRoot` for changes to any path currently claimed
 * in `missionId`, recording a `claim_conflicts` row (via `claimsStore`) for
 * each one. Returns a dispose function — the caller MUST call it when the
 * mission stops being "running" (paused/stopped/completed), so the watcher
 * doesn't keep OS file-descriptor/fsevents resources open for a mission
 * that's no longer active.
 *
 * `onReady`, if given, fires once chokidar has finished its initial scan
 * and is actually watching (chokidar's own `"ready"` event). Production
 * callers (`swarm/routes.ts`) don't need this — a claim made slightly
 * before the watcher has fully attached is a vanishingly small window that
 * self-heals on the next change. Tests DO need it: without it, a test that
 * writes a file immediately after calling this function can race chokidar's
 * own startup and have that first write missed entirely, which is a real
 * "the test is racy" bug, not a "sleep longer" one — waiting for `onReady`
 * fixes it properly instead of papering over it with an arbitrary delay.
 */
export function startMissionWatcher(
  missionId: string,
  workspaceRoot: string,
  claimsStore: ClaimsStore,
  onReady?: () => void
): () => void {
  const watcher: FSWatcher = chokidar.watch(workspaceRoot, {
    ignoreInitial: true,
    ignored: (watchedPath: string) => {
      const rel = relative(workspaceRoot, watchedPath);
      if (rel === "") return false; // never ignore the root itself
      return rel.split(sep).some((segment) => IGNORED_DIR_NAMES.has(segment));
    },
  });
  if (onReady) watcher.on("ready", onReady);

  const onChange = (absPath: string) => {
    const relPath = relative(workspaceRoot, absPath).split(sep).join("/");
    const claim = claimsStore.getByPath(missionId, relPath);
    if (!claim) return; // not claimed by anyone — nothing to flag
    claimsStore.recordConflict(missionId, relPath, claim.agentId);
  };

  // Same process-killing hazard as the file-watch route's watcher, and for
  // the same reason: an 'error' event with no listener on an EventEmitter
  // takes the Node process down. A mission watches a real project
  // directory, so it will meet unwatchable entries — sockets, files
  // removed mid-scan, unreadable paths — and losing every agent session in
  // every workspace over one of them is not a trade anyone would choose.
  watcher.on("error", (err: unknown) => {
    console.warn(
      `vibedeck: mission ${missionId} watcher error under "${workspaceRoot}" (continuing to watch): ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
  });

  watcher.on("add", onChange);
  watcher.on("change", onChange);

  let disposed = false;
  return () => {
    if (disposed) return; // idempotent — routes.ts may call this from more than one code path
    disposed = true;
    watcher.close().catch(() => {
      // Already closing/closed — nothing else to do.
    });
  };
}
