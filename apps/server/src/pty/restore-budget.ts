/**
 * Two small, pure knobs behind cold-start restore's safety story — kept in
 * their own file, deliberately free of any SessionManager/store/I-O
 * dependency, so "the bounded-budget maths" and "the circuit breaker
 * tripping" (both explicitly called out as things this feature must test)
 * are unit-testable with nothing but plain data and a clock-free counter.
 * The actual orchestration that USES these lives in `restore.ts`.
 */
import type { SessionRecord } from "@vibespace/shared";

/**
 * How many recoverable sessions a workspace eagerly restores at once when
 * it becomes active, before the rest are left as DEFERRED panes (same
 * split position/cwd/intended agent, a "restore this pane" affordance, no
 * pty spawned yet — see `restore.ts`). Chosen as 4, not "all of them":
 * BridgeSpace's own v3.4.13 changelog is explicit that recreating every
 * persisted pty at once after a crash needs a bound instead. 4 is also the
 * largest eager count that still matches this app's own default 2x2 grid
 * template (`buildTemplate(4)` in `apps/web/src/grid/tree.ts`) — the single
 * most common non-trivial layout — without spawning a batch of real OS
 * processes (shells, `claude`, `codex`, ...) large enough to visibly stall
 * a cold boot or spike CPU/memory on a modest machine the moment someone's
 * heavier 8- or 16-pane workspace comes back. Deferred panes beyond the
 * budget cost nothing (no process, no memory) until a person actually asks
 * for them.
 */
export const EAGER_RESTORE_BUDGET = 4;

/**
 * How many CONSECUTIVE eager-restore failures (missing binary, an
 * immediate non-zero exit, a spawn error — anything that leaves a record
 * right back at 'recoverable' after an attempted resume) trip the circuit
 * breaker and stop the REST of this batch's eager attempts, deferring them
 * instead of retrying forever. 3 is small on purpose: this only fires when
 * something is systemically broken for the whole batch (the agent's binary
 * got uninstalled between spawns, the machine is out of file
 * descriptors/process slots, ...) — a single flaky failure or two shouldn't
 * abandon an otherwise-healthy restore, but a THIRD in a row is strong
 * evidence the fourth will fail identically, and every additional real
 * spawn attempt at that point is pure cost (another process launch,
 * another few hundred ms) for a result the breaker can already predict.
 */
export const RESTORE_CIRCUIT_BREAKER_THRESHOLD = 3;

export interface RestorePlan<T> {
  /** The first `budget` records — attempt to restore these right now. */
  eager: T[];
  /** Everything past the budget — show a restore affordance, spawn nothing. */
  deferred: T[];
}

/**
 * Splits `records` (expected oldest-first — see
 * `SessionRecordsStore.listRecoverable`) into the first `budget` (eager)
 * and the rest (deferred). Pure: no I/O, no randomness, no clock — the
 * entire "bounded budget maths" in one deterministic function.
 */
export function planRestore<T extends SessionRecord | { id: string }>(
  records: readonly T[],
  budget: number
): RestorePlan<T> {
  const safeBudget = Math.max(0, Math.trunc(budget));
  return {
    eager: records.slice(0, safeBudget),
    deferred: records.slice(safeBudget),
  };
}

/**
 * Trips after `threshold` CONSECUTIVE failures; any success resets the
 * streak back to zero (a transient blip shouldn't carry the same weight as
 * a systemic one — see `RESTORE_CIRCUIT_BREAKER_THRESHOLD`'s own comment).
 * Once tripped, `restore.ts`'s `restoreWorkspaceSessions` stops attempting
 * further eager restores in the current batch and defers everything left
 * instead of hammering the machine with attempts that are all but certain
 * to fail the same way.
 */
export class RestoreCircuitBreaker {
  private consecutiveFailures = 0;

  constructor(private readonly threshold: number = RESTORE_CIRCUIT_BREAKER_THRESHOLD) {}

  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
  }

  get tripped(): boolean {
    return this.consecutiveFailures >= this.threshold;
  }

  /** Exposed for tests/diagnostics — how many failures in a row right now. */
  get failureStreak(): number {
    return this.consecutiveFailures;
  }
}
