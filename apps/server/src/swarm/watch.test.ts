/**
 * Proves `startMissionWatcher` actually detects a claimed file changing on
 * disk and records a `claim_conflicts` row for it — the "detection, not
 * prevention" half of the ownership story (see `watch.ts`'s and
 * `claims.ts`'s top comments). Uses a real chokidar watcher against a real
 * temp directory (not mocked) — this is exactly the mechanism a real
 * uncooperative agent's `echo > file` would trip.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaimsStore } from "./claims.js";
import { startMissionWatcher } from "./watch.js";

let dataDir: string;
let workspaceRoot: string;
let store: ClaimsStore;
let dispose: (() => void) | null;

const MISSION_ID = "mission-watch";

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "vibedeck-watch-test-"));
  process.env.VIBEDECK_DATA_DIR = dataDir;
  workspaceRoot = mkdtempSync(join(tmpdir(), "vibedeck-watch-workspace-"));
  mkdirSync(join(workspaceRoot, "src"), { recursive: true });
  store = new ClaimsStore();
  dispose = null;
});

afterEach(() => {
  dispose?.();
  store.close();
  delete process.env.VIBEDECK_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
});

/**
 * Waits (polling) until `condition()` is true or `timeoutMs` elapses.
 *
 * 20s, well above this file's real-world settle time (well under a second,
 * confirmed both in isolation and repeatedly as part of the full suite — a
 * standalone fsevents diagnostic run alongside the full suite still
 * delivered its change event in ~3ms; a raised fs.watch event is not
 * inherently slow under this repo's load). This generous ceiling exists
 * purely as headroom against the same class of vitest worker-thread
 * scheduling jitter every other `waitFor`-based test in this repo already
 * budgets 10s for (`board/routes.test.ts`, `swarm/routes.test.ts`) — not
 * because this specific event was ever observed to need anywhere near it.
 * Still condition-polling, never a blind sleep. The `it(...)` timeouts
 * below stay above this.
 */
async function waitFor(condition: () => boolean, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: condition never became true within timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Starts the watcher and waits for chokidar's own "ready" event (via
 * `startMissionWatcher`'s `onReady` hook) before returning. Writing a file
 * immediately after calling `startMissionWatcher` — with no wait at all —
 * races chokidar's own startup scan: on a loaded machine the write can land
 * before the watcher has actually attached, and the event is missed
 * entirely (a real intermittent failure this repo hit, not a hypothetical
 * one). Waiting for readiness fixes the race at its source instead of
 * masking it with an arbitrary sleep.
 *
 * The extra 150ms after "ready" resolves is a second, narrower, well-known
 * gap: chokidar's macOS/fsevents backend can fire "ready" a beat before its
 * underlying FSEventStream is actually delivering events end-to-end,
 * especially with several watchers open across different test files in the
 * same process (this repo measured real intermittent misses here — see
 * this file's git history/PR discussion). This is a fixed settle delay
 * bounded to 150ms, layered ON TOP of proper event-based readiness — not a
 * substitute for it, and not the thing `waitFor` is relied on for.
 */
function startAndWaitReady(missionId: string, root: string, claimsStore: ClaimsStore): Promise<() => void> {
  return new Promise((resolve) => {
    const disposeFn = startMissionWatcher(missionId, root, claimsStore, () => {
      setTimeout(() => resolve(disposeFn), 150);
    });
  });
}

describe("startMissionWatcher", () => {
  it(
    "records a conflict, naming the current holder, when a CLAIMED file changes on disk",
    async () => {
      const claimResult = store.claim(MISSION_ID, "agent-1", workspaceRoot, "src/foo.ts");
      expect(claimResult.ok).toBe(true);
      // The file has to actually exist before the watcher can see it change
      // — write the initial version BEFORE starting the watcher (ignoreInitial
      // is true, so this pre-existing write itself is never reported).
      writeFileSync(join(workspaceRoot, "src", "foo.ts"), "// v1\n", "utf8");

      dispose = await startAndWaitReady(MISSION_ID, workspaceRoot, store);

      // Simulate the uncooperative write this whole mechanism exists to
      // catch: something (not necessarily agent-1) edits the claimed file
      // directly on disk, with no claim-API call involved at all.
      writeFileSync(join(workspaceRoot, "src", "foo.ts"), "// v2 — written outside the claim system\n", "utf8");

      await waitFor(() => store.listConflicts(MISSION_ID).length > 0);

      const conflicts = store.listConflicts(MISSION_ID);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].path).toBe("src/foo.ts");
      expect(conflicts[0].holderAgentId).toBe("agent-1");
    },
    25_000
  );

  it(
    "does NOT record a conflict for a file that was never claimed",
    async () => {
      writeFileSync(join(workspaceRoot, "src", "unclaimed.ts"), "// v1\n", "utf8");
      dispose = await startAndWaitReady(MISSION_ID, workspaceRoot, store);

      writeFileSync(join(workspaceRoot, "src", "unclaimed.ts"), "// v2\n", "utf8");

      // Give the watcher a real beat to have noticed, if it were going to —
      // then assert it stayed quiet.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(store.listConflicts(MISSION_ID)).toEqual([]);
    },
    10_000
  );

  it(
    "a NEW file created at a claimed path also trips the watcher (the 'add' event, not just 'change')",
    async () => {
      // Claim a path that doesn't exist on disk yet at all — plausible for
      // a file a builder is about to create.
      const claimResult = store.claim(MISSION_ID, "agent-1", workspaceRoot, "src/brand-new.ts");
      expect(claimResult.ok).toBe(true);

      dispose = await startAndWaitReady(MISSION_ID, workspaceRoot, store);
      writeFileSync(join(workspaceRoot, "src", "brand-new.ts"), "// created after claim\n", "utf8");

      await waitFor(() => store.listConflicts(MISSION_ID).length > 0);
      expect(store.listConflicts(MISSION_ID)[0].path).toBe("src/brand-new.ts");
    },
    25_000
  );
});
