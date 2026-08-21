import { describe, expect, it } from "vitest";
import {
  EAGER_RESTORE_BUDGET,
  RESTORE_CIRCUIT_BREAKER_THRESHOLD,
  RestoreCircuitBreaker,
  planRestore,
} from "./restore-budget.js";

describe("planRestore (bounded budget maths)", () => {
  it("puts everything in eager when there are fewer records than the budget", () => {
    const records = [{ id: "a" }, { id: "b" }];
    const { eager, deferred } = planRestore(records, 4);
    expect(eager.map((r) => r.id)).toEqual(["a", "b"]);
    expect(deferred).toEqual([]);
  });

  it("splits exactly at the budget when there are more records than it", () => {
    const records = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }, { id: "f" }];
    const { eager, deferred } = planRestore(records, 4);
    expect(eager.map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
    expect(deferred.map((r) => r.id)).toEqual(["e", "f"]);
  });

  it("an exact match (records.length === budget) puts everything in eager, nothing deferred", () => {
    const records = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
    const { eager, deferred } = planRestore(records, 4);
    expect(eager).toHaveLength(4);
    expect(deferred).toHaveLength(0);
  });

  it("a budget of 0 defers everything", () => {
    const records = [{ id: "a" }, { id: "b" }];
    const { eager, deferred } = planRestore(records, 0);
    expect(eager).toEqual([]);
    expect(deferred.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("a negative budget behaves like 0 (never restores anything, never throws)", () => {
    const records = [{ id: "a" }, { id: "b" }];
    const { eager, deferred } = planRestore(records, -3);
    expect(eager).toEqual([]);
    expect(deferred).toHaveLength(2);
  });

  it("an empty record list produces two empty arrays regardless of budget", () => {
    expect(planRestore([], 4)).toEqual({ eager: [], deferred: [] });
  });

  it("never mutates the input array", () => {
    const records = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const copy = [...records];
    planRestore(records, 1);
    expect(records).toEqual(copy);
  });

  it("EAGER_RESTORE_BUDGET is a small, sane positive integer (documented default)", () => {
    expect(EAGER_RESTORE_BUDGET).toBeGreaterThan(0);
    expect(EAGER_RESTORE_BUDGET).toBeLessThanOrEqual(8);
    expect(Number.isInteger(EAGER_RESTORE_BUDGET)).toBe(true);
  });
});

describe("RestoreCircuitBreaker", () => {
  it("is not tripped before any failures", () => {
    const breaker = new RestoreCircuitBreaker(3);
    expect(breaker.tripped).toBe(false);
    expect(breaker.failureStreak).toBe(0);
  });

  it("trips after exactly `threshold` CONSECUTIVE failures", () => {
    const breaker = new RestoreCircuitBreaker(3);
    breaker.recordFailure();
    expect(breaker.tripped).toBe(false);
    breaker.recordFailure();
    expect(breaker.tripped).toBe(false);
    breaker.recordFailure();
    expect(breaker.tripped).toBe(true);
    expect(breaker.failureStreak).toBe(3);
  });

  it("stays tripped on further failures past the threshold", () => {
    const breaker = new RestoreCircuitBreaker(2);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.tripped).toBe(true);
  });

  it("a success resets the streak to zero, un-tripping it", () => {
    const breaker = new RestoreCircuitBreaker(3);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    expect(breaker.failureStreak).toBe(0);
    expect(breaker.tripped).toBe(false);

    // Needs a FULL fresh streak of 3 after the reset — the two failures
    // before the success must not carry over.
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.tripped).toBe(false);
    breaker.recordFailure();
    expect(breaker.tripped).toBe(true);
  });

  it("interleaved failure-success-failure never accumulates across a success", () => {
    const breaker = new RestoreCircuitBreaker(2);
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    expect(breaker.tripped).toBe(false); // only 1 failure since the last success
  });

  it("defaults to RESTORE_CIRCUIT_BREAKER_THRESHOLD when no threshold is given", () => {
    const breaker = new RestoreCircuitBreaker();
    for (let i = 0; i < RESTORE_CIRCUIT_BREAKER_THRESHOLD - 1; i++) {
      breaker.recordFailure();
    }
    expect(breaker.tripped).toBe(false);
    breaker.recordFailure();
    expect(breaker.tripped).toBe(true);
  });
});
