/**
 * TasksStore tests — CRUD, the wave-readiness gate ("only dispatch a wave
 * once the previous wave is complete"), and the reviewer gate ("a task can
 * only reach 'complete' via review approval"). Real SQLite in a fresh temp
 * dir, same pattern as every other swarm store test.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TasksStore } from "./tasks.js";

let dataDir: string;
let store: TasksStore;

const MISSION_ID = "mission-tasks";

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "vibedeck-tasks-test-"));
  process.env.VIBEDECK_DATA_DIR = dataDir;
  store = new TasksStore();
});

afterEach(() => {
  store.close();
  delete process.env.VIBEDECK_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("TasksStore CRUD", () => {
  it("creates a task starting 'pending', with no assignment and no review", () => {
    const task = store.create({ missionId: MISSION_ID, title: "Add login form", prompt: "Build the login form" });

    expect(task.status).toBe("pending");
    expect(task.assignedAgentId).toBeNull();
    expect(task.reviewApproved).toBeNull();
    expect(task.reviewNotes).toBeNull();
    expect(task.declaredPaths).toEqual([]);
  });

  it("declaredPaths round-trips through storage exactly", () => {
    const task = store.create({
      missionId: MISSION_ID,
      title: "Task",
      prompt: "Do it",
      declaredPaths: ["src/a.ts", "src/b.ts"],
    });
    expect(store.get(task.id)?.declaredPaths).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("list scopes to a mission and orders by creation", () => {
    const a = store.create({ missionId: MISSION_ID, title: "A", prompt: "..." });
    const b = store.create({ missionId: MISSION_ID, title: "B", prompt: "..." });
    store.create({ missionId: "other-mission", title: "C", prompt: "..." });

    expect(store.list(MISSION_ID).map((t) => t.id)).toEqual([a.id, b.id]);
  });

  it("get returns undefined for an unknown id", () => {
    expect(store.get("nope")).toBeUndefined();
  });
});

describe("TasksStore.update — the reviewer gate", () => {
  it("rejects a direct PATCH to 'complete' with reason complete-requires-review", () => {
    const task = store.create({ missionId: MISSION_ID, title: "T", prompt: "..." });
    // @ts-expect-error — 'complete' is intentionally excluded from UpdateTaskOptions's status type;
    // this exercises the runtime guard for a caller that bypasses the type (e.g. an HTTP body).
    const result = store.update(task.id, { status: "complete" });

    expect(result).toEqual({ ok: false, reason: "complete-requires-review" });
    expect(store.get(task.id)?.status).toBe("pending"); // untouched
  });

  it("update() to non-complete statuses (in_review, blocked, pending) works normally", () => {
    const task = store.create({ missionId: MISSION_ID, title: "T", prompt: "..." });
    const result = store.update(task.id, { status: "in_review" });
    expect(result).toEqual({ ok: true, task: expect.objectContaining({ status: "in_review" }) });
  });

  it("update() returns not-found for an unknown id", () => {
    expect(store.update("nope", { status: "pending" })).toEqual({ ok: false, reason: "not-found" });
  });
});

describe("TasksStore.review — the only path to 'complete'", () => {
  it("approved review moves the task to 'complete' and records the review", () => {
    const task = store.create({ missionId: MISSION_ID, title: "T", prompt: "..." });
    const result = store.review(task.id, true, "Looks good", "reviewer-1");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.task.status).toBe("complete");
    expect(result.task.reviewApproved).toBe(true);
    expect(result.task.reviewNotes).toBe("Looks good");
    expect(result.task.reviewedByAgentId).toBe("reviewer-1");
  });

  it("rejected review moves the task to 'blocked', not 'complete'", () => {
    const task = store.create({ missionId: MISSION_ID, title: "T", prompt: "..." });
    const result = store.review(task.id, false, "Needs more tests", "reviewer-1");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.task.status).toBe("blocked");
    expect(result.task.reviewApproved).toBe(false);
    expect(result.task.reviewNotes).toBe("Needs more tests");
  });

  it("review() returns not-found for an unknown id", () => {
    expect(store.review("nope", true, null, "reviewer-1")).toEqual({ ok: false, reason: "not-found" });
  });
});

describe("TasksStore — wave readiness gate", () => {
  it("a task in the FIRST wave can start immediately (nothing blocks it)", () => {
    const task = store.create({ missionId: MISSION_ID, title: "First", prompt: "...", declaredPaths: ["src/a.ts"] });
    const result = store.update(task.id, { status: "running" });
    expect(result).toEqual({ ok: true, task: expect.objectContaining({ status: "running" }) });
  });

  it("a task in a LATER wave cannot start while its wave's predecessor is incomplete, and names the blocker", () => {
    const a = store.create({ missionId: MISSION_ID, title: "A", prompt: "...", declaredPaths: ["src/shared.ts"] });
    const b = store.create({ missionId: MISSION_ID, title: "B", prompt: "...", declaredPaths: ["src/shared.ts"] });
    // A and B both declare src/shared.ts -> planSchedule puts them in separate waves: [A], [B].

    const attempt = store.update(b.id, { status: "running" });
    expect(attempt).toEqual({ ok: false, reason: "wave-not-ready", blockedBy: [a.id] });
    expect(store.get(b.id)?.status).toBe("pending"); // untouched
  });

  it("once the blocking task is 'complete' (via review), the later-wave task can start", () => {
    const a = store.create({ missionId: MISSION_ID, title: "A", prompt: "...", declaredPaths: ["src/shared.ts"] });
    const b = store.create({ missionId: MISSION_ID, title: "B", prompt: "...", declaredPaths: ["src/shared.ts"] });

    store.update(a.id, { status: "running" });
    store.update(a.id, { status: "in_review" });
    store.review(a.id, true, "ok", "reviewer-1"); // -> 'complete'

    const attempt = store.update(b.id, { status: "running" });
    expect(attempt).toEqual({ ok: true, task: expect.objectContaining({ status: "running" }) });
  });

  it("a task with no declared paths is never wave-blocked, even alongside conflicting tasks", () => {
    const a = store.create({ missionId: MISSION_ID, title: "A", prompt: "...", declaredPaths: ["src/shared.ts"] });
    store.create({ missionId: MISSION_ID, title: "B", prompt: "...", declaredPaths: ["src/shared.ts"] });
    const noOp = store.create({ missionId: MISSION_ID, title: "NoOp", prompt: "...", declaredPaths: [] });

    // NoOp shares A's (the first) wave, so it should be immediately startable.
    void a;
    const attempt = store.update(noOp.id, { status: "running" });
    expect(attempt).toEqual({ ok: true, task: expect.objectContaining({ status: "running" }) });
  });

  it("re-starting an already-running task is a no-op re-check, not blocked by itself", () => {
    const task = store.create({ missionId: MISSION_ID, title: "T", prompt: "...", declaredPaths: ["src/a.ts"] });
    store.update(task.id, { status: "running" });
    // Setting the SAME status again shouldn't re-trigger gating in a way that blocks on itself.
    const again = store.update(task.id, { status: "running" });
    expect(again.ok).toBe(true);
  });
});

describe("TasksStore.getSchedule", () => {
  it("exposes the current wave grouping for a mission's tasks", () => {
    const a = store.create({ missionId: MISSION_ID, title: "A", prompt: "...", declaredPaths: ["src/shared.ts"] });
    const b = store.create({ missionId: MISSION_ID, title: "B", prompt: "...", declaredPaths: ["src/shared.ts"] });
    const c = store.create({ missionId: MISSION_ID, title: "C", prompt: "...", declaredPaths: ["src/other.ts"] });

    const waves = store.getSchedule(MISSION_ID);
    expect(waves).toEqual([
      [a.id, c.id],
      [b.id],
    ]);
  });
});
