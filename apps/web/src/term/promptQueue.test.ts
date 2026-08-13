import { describe, expect, it } from "vitest";
import {
  AGENT_ACTIVITY_IDLE_MS,
  clearQueue,
  createPromptQueueState,
  isRecentActivityBusy,
  setAgentStatus,
  submitPrompt,
  type PromptQueueState,
} from "./promptQueue.js";

describe("submitPrompt", () => {
  it("a prompt submitted while idle sends immediately, queue untouched", () => {
    const state = createPromptQueueState();
    const result = submitPrompt(state, "echo hi");
    expect(result.send).toBe("echo hi");
    expect(result.state.queue).toEqual([]);
    expect(result.state.status).toBe("idle");
  });

  it("queueing while busy holds — nothing is sent", () => {
    const working: PromptQueueState = { status: "working", queue: [] };
    const result = submitPrompt(working, "npm test");
    expect(result.send).toBeNull();
    expect(result.state.queue).toEqual(["npm test"]);
    expect(result.state.status).toBe("working");
  });

  it("multiple prompts submitted while busy queue in order", () => {
    let state: PromptQueueState = { status: "working", queue: [] };
    state = submitPrompt(state, "first").state;
    state = submitPrompt(state, "second").state;
    state = submitPrompt(state, "third").state;
    expect(state.queue).toEqual(["first", "second", "third"]);
  });
});

describe("setAgentStatus", () => {
  it("going idle flushes exactly one queued prompt, oldest first", () => {
    const state: PromptQueueState = { status: "working", queue: ["first", "second"] };
    const result = setAgentStatus(state, "idle");
    expect(result.send).toBe("first");
    expect(result.state.status).toBe("idle");
    expect(result.state.queue).toEqual(["second"]);

    // The remaining item stays queued until the NEXT working->idle
    // transition — going idle again without an intervening "working"
    // report is a no-op (same status), so nothing double-flushes.
    const again = setAgentStatus(result.state, "idle");
    expect(again.send).toBeNull();
    expect(again.state.queue).toEqual(["second"]);

    // Simulate the flushed prompt making the pane busy again, then idle:
    // the second queued prompt flushes on ITS OWN transition, one at a time.
    const busyAgain = setAgentStatus(again.state, "working");
    const secondFlush = setAgentStatus(busyAgain.state, "idle");
    expect(secondFlush.send).toBe("second");
    expect(secondFlush.state.queue).toEqual([]);
  });

  it("going idle with an empty queue sends nothing", () => {
    const state: PromptQueueState = { status: "working", queue: [] };
    const result = setAgentStatus(state, "idle");
    expect(result.send).toBeNull();
    expect(result.state).toEqual({ status: "idle", queue: [] });
  });

  it("idle->working is a status change with no send", () => {
    const state = createPromptQueueState();
    const result = setAgentStatus(state, "working");
    expect(result.send).toBeNull();
    expect(result.state.status).toBe("working");
  });

  it("re-reporting the same status is a no-op (idle->idle, working->working)", () => {
    const idle = createPromptQueueState();
    const idleAgain = setAgentStatus(idle, "idle");
    expect(idleAgain.send).toBeNull();
    expect(idleAgain.state).toBe(idle); // same reference: truly a no-op

    const working: PromptQueueState = { status: "working", queue: ["queued"] };
    const workingAgain = setAgentStatus(working, "working");
    expect(workingAgain.send).toBeNull();
    expect(workingAgain.state.queue).toEqual(["queued"]); // untouched, not re-flushed
  });
});

describe("clearQueue", () => {
  it("empties the queue without touching status", () => {
    const state: PromptQueueState = { status: "working", queue: ["a", "b", "c"] };
    const cleared = clearQueue(state);
    expect(cleared.queue).toEqual([]);
    expect(cleared.status).toBe("working");
  });

  it("a cleared queue flushes nothing on the next idle transition", () => {
    const state: PromptQueueState = { status: "working", queue: ["a", "b"] };
    const cleared = clearQueue(state);
    const result = setAgentStatus(cleared, "idle");
    expect(result.send).toBeNull();
    expect(result.state.queue).toEqual([]);
  });

  it("clearing an already-empty queue is a no-op (same reference)", () => {
    const state = createPromptQueueState();
    expect(clearQueue(state)).toBe(state);
  });
});

describe("per-session isolation", () => {
  it("the queue is per-session and never leaks across sessions", () => {
    // Nothing in this module is global/shared mutable state — every
    // function is state-in, state-out over a plain PromptQueueState value,
    // so two independently-created states (as Terminal.tsx does, one per
    // pane) can never observe each other's mutations. Demonstrate it:
    const sessionA = createPromptQueueState();
    const sessionB = createPromptQueueState();

    const afterA = submitPrompt(setAgentStatus(sessionA, "working").state, "only in A").state;

    expect(afterA.queue).toEqual(["only in A"]);
    // sessionB, a completely separate state object, is untouched.
    expect(sessionB.queue).toEqual([]);
    expect(sessionB.status).toBe("idle");
  });
});

describe("isRecentActivityBusy", () => {
  it("null lastOutputAt (no output ever seen) is never busy", () => {
    expect(isRecentActivityBusy(null, 10_000)).toBe(false);
  });

  it("output within the threshold counts as busy", () => {
    const lastOutputAt = 1_000;
    const now = lastOutputAt + AGENT_ACTIVITY_IDLE_MS - 1;
    expect(isRecentActivityBusy(lastOutputAt, now)).toBe(true);
  });

  it("output at or past the threshold counts as idle", () => {
    const lastOutputAt = 1_000;
    const now = lastOutputAt + AGENT_ACTIVITY_IDLE_MS;
    expect(isRecentActivityBusy(lastOutputAt, now)).toBe(false);
  });

  it("accepts a custom threshold instead of the default", () => {
    expect(isRecentActivityBusy(1_000, 1_500, 1000)).toBe(true);
    expect(isRecentActivityBusy(1_000, 2_500, 1000)).toBe(false);
  });
});
