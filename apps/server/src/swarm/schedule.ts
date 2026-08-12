/**
 * planSchedule: a pure function that groups mission tasks into "waves" —
 * batches that can run CONCURRENTLY because none of the tasks in a wave
 * declare an overlapping file path — based on nothing but the tasks'
 * declared paths. No database, no filesystem, no I/O of any kind; the
 * whole point is that this is testable as plain input-in/output-out logic.
 *
 * This is a SEQUENCING layer, and it is deliberately separate from (not a
 * substitute for) the claims registry (`claims.ts`) or the conflict
 * watcher (`watch.ts`) — see docs/SWARM.md for the full three-layer story.
 * In short: this file prevents PLANNED collisions before any agent is even
 * spawned (two tasks declaring the same file are never scheduled to run at
 * the same time); the claims registry catches UNPLANNED collisions at
 * claim-time (an agent claiming a path nobody declared up front); the
 * watcher detects what neither stopped. None of the three make agents
 * "never collide" — each catches what the one before it couldn't.
 *
 * Path overlap is judged after a PURE, filesystem-free normalisation
 * (`node:path`'s `posix.normalize`, string-only) — deliberately NOT
 * `claims.ts`'s `normalizeClaimPath`, which needs a real workspace root on
 * disk to resolve against via `safeResolve`. Schedule planning happens
 * before any task has necessarily even been assigned to an agent, let
 * alone touched disk, so it only needs "./src/a.ts" and "src/a.ts" to
 * compare equal — not to verify workspace containment, which is a real
 * security check that happens for real, later, when an agent actually
 * calls the claims API.
 */
import { posix } from "node:path";

export interface ScheduledTask {
  id: string;
  /** Workspace-relative paths this task expects to touch, in whatever
   * (possibly messy — "./a", "a//b") form was supplied. An empty array
   * means the task touches no files it needs to coordinate over, so it
   * can never conflict with anything. */
  declaredPaths: string[];
}

function normalizeForSchedule(path: string): string {
  return posix.normalize(path);
}

/** True if `a` and `b` declare at least one path in common, after
 * normalisation. A task with no declared paths never overlaps with
 * anything — "declaring no paths blocks nothing" is exactly this early
 * return. */
function pathsOverlap(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const normalizedA = new Set(a.map(normalizeForSchedule));
  return b.some((path) => normalizedA.has(normalizeForSchedule(path)));
}

/**
 * Groups `tasks` into waves: each wave is an array of task ids that can run
 * concurrently because no two of them declare an overlapping path. The
 * result is ordered — `waves[0]` is the first (earliest-eligible) wave.
 *
 * Algorithm: greedy graph colouring, processing `tasks` in the order
 * given. Each task is placed into the EARLIEST existing wave that contains
 * no task it conflicts with; a new wave is opened only when every existing
 * wave has a conflict. Input order matters for exactly one thing: which of
 * two mutually-non-conflicting tasks gets "first pick" of an early wave
 * when a third, conflicting task is also in play — see this module's
 * tests for the worked A-B-C example.
 */
export function planSchedule(tasks: readonly ScheduledTask[]): string[][] {
  const waves: ScheduledTask[][] = [];

  for (const task of tasks) {
    const targetWave = waves.find((wave) => !wave.some((other) => pathsOverlap(task.declaredPaths, other.declaredPaths)));
    if (targetWave) {
      targetWave.push(task);
    } else {
      waves.push([task]);
    }
  }

  return waves.map((wave) => wave.map((task) => task.id));
}
