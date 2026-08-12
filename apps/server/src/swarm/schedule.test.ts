/**
 * planSchedule tests — pure, no database/filesystem involved. Covers
 * exactly the cases the Phase 9a spec calls out: non-overlap sharing a
 * wave, one shared path forcing separate waves, the A-B/B-C-but-not-A-C
 * worked example, an empty-declared-paths task blocking nothing, and path
 * normalisation treating "./src/a.ts" and "src/a.ts" as the same path.
 */
import { describe, expect, it } from "vitest";
import { planSchedule, type ScheduledTask } from "./schedule.js";

describe("planSchedule — no overlap", () => {
  it("tasks with entirely disjoint declared paths all share a single wave", () => {
    const tasks: ScheduledTask[] = [
      { id: "A", declaredPaths: ["src/a.ts"] },
      { id: "B", declaredPaths: ["src/b.ts"] },
      { id: "C", declaredPaths: ["src/c.ts"] },
    ];
    expect(planSchedule(tasks)).toEqual([["A", "B", "C"]]);
  });
});

describe("planSchedule — overlap forces separation", () => {
  it("two tasks declaring the same path land in separate waves", () => {
    const tasks: ScheduledTask[] = [
      { id: "A", declaredPaths: ["src/shared.ts"] },
      { id: "B", declaredPaths: ["src/shared.ts"] },
    ];
    expect(planSchedule(tasks)).toEqual([["A"], ["B"]]);
  });

  it("overlap on just ONE of several declared paths is still enough to separate", () => {
    const tasks: ScheduledTask[] = [
      { id: "A", declaredPaths: ["src/a.ts", "src/shared.ts"] },
      { id: "B", declaredPaths: ["src/b.ts", "src/shared.ts"] },
    ];
    expect(planSchedule(tasks)).toEqual([["A"], ["B"]]);
  });
});

describe("planSchedule — the A-B-C chain", () => {
  it("A-B and B-C overlap but A-C don't: A and C may share a wave, B must not share with either", () => {
    const tasks: ScheduledTask[] = [
      { id: "A", declaredPaths: ["p1"] },
      { id: "B", declaredPaths: ["p1", "p2"] }, // overlaps A via p1, C via p2
      { id: "C", declaredPaths: ["p2"] },
    ];
    const waves = planSchedule(tasks);

    // A and C together, B alone — and specifically B must never be in the
    // same wave as either A or C.
    expect(waves).toEqual([["A", "C"], ["B"]]);
    const bWave = waves.find((w) => w.includes("B"))!;
    expect(bWave).not.toContain("A");
    expect(bWave).not.toContain("C");
  });
});

describe("planSchedule — a task with no declared paths", () => {
  it("blocks nothing: it shares the earliest wave regardless of what else is scheduled", () => {
    const tasks: ScheduledTask[] = [
      { id: "A", declaredPaths: ["src/a.ts"] },
      { id: "B", declaredPaths: ["src/a.ts"] }, // conflicts with A, forced to wave 2
      { id: "NoOp", declaredPaths: [] },
    ];
    const waves = planSchedule(tasks);
    expect(waves).toEqual([["A", "NoOp"], ["B"]]);
  });

  it("two path-less tasks never conflict with each other either", () => {
    const tasks: ScheduledTask[] = [
      { id: "A", declaredPaths: [] },
      { id: "B", declaredPaths: [] },
    ];
    expect(planSchedule(tasks)).toEqual([["A", "B"]]);
  });
});

describe("planSchedule — path normalisation", () => {
  it("'./src/a.ts' and 'src/a.ts' count as the same declared path", () => {
    const tasks: ScheduledTask[] = [
      { id: "A", declaredPaths: ["src/a.ts"] },
      { id: "B", declaredPaths: ["./src/a.ts"] },
    ];
    expect(planSchedule(tasks)).toEqual([["A"], ["B"]]);
  });

  it("'src//a.ts' (double slash) also normalises to the same path", () => {
    const tasks: ScheduledTask[] = [
      { id: "A", declaredPaths: ["src/a.ts"] },
      { id: "B", declaredPaths: ["src//a.ts"] },
    ];
    expect(planSchedule(tasks)).toEqual([["A"], ["B"]]);
  });
});

describe("planSchedule — edge cases", () => {
  it("returns an empty array of waves for an empty task list", () => {
    expect(planSchedule([])).toEqual([]);
  });

  it("a single task with no conflicts gets a single wave with itself", () => {
    expect(planSchedule([{ id: "A", declaredPaths: ["src/a.ts"] }])).toEqual([["A"]]);
  });
});
