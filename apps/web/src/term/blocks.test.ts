import { describe, expect, it } from "vitest";
import { BlockTracker, formatBlockDuration, parseOsc133 } from "./blocks.js";

describe("BlockTracker", () => {
  it("tracks a clean ok block (exit 0)", () => {
    const tracker = new BlockTracker();
    tracker.onCommandStart(10, 1_000, "ls");
    tracker.onCommandEnd(0, 12, 1_200);

    const blocks = tracker.list();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      command: "ls",
      startLine: 10,
      endLine: 12,
      exitCode: 0,
      startedAt: 1_000,
      durationMs: 200,
      state: "ok",
    });
  });

  it("tracks a failed block (non-zero exit)", () => {
    const tracker = new BlockTracker();
    tracker.onCommandStart(0, 0, "false");
    tracker.onCommandEnd(1, 1, 50);

    const blocks = tracker.list();
    expect(blocks).toHaveLength(1);
    expect(blocks[0].exitCode).toBe(1);
    expect(blocks[0].state).toBe("failed");
  });

  it("a still-running block (no D yet) reports state 'running' and endLine null", () => {
    const tracker = new BlockTracker();
    tracker.onCommandStart(5, 500, "sleep 100");

    const blocks = tracker.list();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      state: "running",
      endLine: null,
      exitCode: null,
      durationMs: null,
    });
  });

  it("ignores a D with no preceding C, without corrupting the list", () => {
    const tracker = new BlockTracker();
    tracker.onCommandEnd(0, 3, 100);
    expect(tracker.list()).toEqual([]);

    // The tracker should still work normally afterward.
    tracker.onCommandStart(4, 200, "echo hi");
    tracker.onCommandEnd(0, 5, 300);
    expect(tracker.list()).toHaveLength(1);
  });

  it("two Cs in a row (no D between) closes the first block as interrupted/failed and opens a new one", () => {
    const tracker = new BlockTracker();
    tracker.onCommandStart(1, 100, "sleep 999");
    tracker.onCommandStart(5, 400, "echo interrupted-me");

    const blocks = tracker.list();
    expect(blocks).toHaveLength(2);

    expect(blocks[0]).toMatchObject({
      command: "sleep 999",
      startLine: 1,
      endLine: 5, // closed at the new command's start line
      exitCode: null,
      state: "failed", // unknown result reads as failed, never silently "ok"
    });

    expect(blocks[1]).toMatchObject({
      command: "echo interrupted-me",
      startLine: 5,
      state: "running",
      endLine: null,
    });
  });

  it("a D with an already-garbage (non-numeric-derived) exit code closes the block as failed, not throwing", () => {
    const tracker = new BlockTracker();
    tracker.onCommandStart(0, 0, "weird-shell-cmd");
    // Simulates what Terminal.tsx passes through after parseOsc133 already
    // turned a non-numeric "D;xyz" payload into `exitCode: null`.
    expect(() => tracker.onCommandEnd(null, 1, 10)).not.toThrow();

    const blocks = tracker.list();
    expect(blocks[0].exitCode).toBeNull();
    expect(blocks[0].state).toBe("failed");
  });

  it("interleaved / out-of-order markers never throw and never corrupt the list", () => {
    const tracker = new BlockTracker();

    expect(() => {
      tracker.onPromptEnd(0); // B before any A — fine, both are no-ops here
      tracker.onCommandEnd(0, 1, 10); // D before C — ignored, nothing open
      tracker.onPromptStart(2); // A out of place — fine
      tracker.onCommandStart(3, 20, "real command");
      tracker.onPromptStart(4); // A while a command is "running" — harmless
      tracker.onCommandEnd(0, 5, 30);
      tracker.onCommandEnd(0, 6, 40); // a second D with nothing open — ignored
    }).not.toThrow();

    const blocks = tracker.list();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      command: "real command",
      startLine: 3,
      endLine: 5,
      exitCode: 0,
      state: "ok",
    });
  });

  it("clear() forgets every block and closes out any currently-running one", () => {
    const tracker = new BlockTracker();
    tracker.onCommandStart(0, 0, "done-cmd");
    tracker.onCommandEnd(0, 1, 10);
    tracker.onCommandStart(2, 20, "still-running-cmd");

    tracker.clear();
    expect(tracker.list()).toEqual([]);

    // A D that would have closed the pre-clear "still running" block must
    // now be a no-op (nothing open post-clear), not resurrect stale state.
    tracker.onCommandEnd(0, 99, 999);
    expect(tracker.list()).toEqual([]);

    // The tracker keeps working normally after a clear.
    tracker.onCommandStart(0, 0, "fresh-cmd");
    tracker.onCommandEnd(0, 1, 5);
    expect(tracker.list()).toHaveLength(1);
    expect(tracker.list()[0].command).toBe("fresh-cmd");
  });

  it("list() returns oldest-first, and a fresh array each call", () => {
    const tracker = new BlockTracker();
    tracker.onCommandStart(0, 0, "first");
    tracker.onCommandEnd(0, 1, 1);
    tracker.onCommandStart(2, 2, "second");
    tracker.onCommandEnd(0, 3, 3);

    const listA = tracker.list();
    const listB = tracker.list();
    expect(listA.map((b) => b.command)).toEqual(["first", "second"]);
    expect(listA).not.toBe(listB); // different array instances
    expect(listA).toEqual(listB); // same contents
  });

  it("assigns unique, stable ids across blocks", () => {
    const tracker = new BlockTracker();
    tracker.onCommandStart(0, 0, "a");
    tracker.onCommandEnd(0, 1, 1);
    tracker.onCommandStart(2, 2, "b");
    tracker.onCommandEnd(0, 3, 3);

    const [a, b] = tracker.list();
    expect(a.id).not.toBe(b.id);
  });
});

describe("parseOsc133", () => {
  it("parses A, B, and C with no payload", () => {
    expect(parseOsc133("A")).toEqual({ marker: "A" });
    expect(parseOsc133("B")).toEqual({ marker: "B" });
    expect(parseOsc133("C")).toEqual({ marker: "C" });
  });

  it("parses D with a valid exit code", () => {
    expect(parseOsc133("D;0")).toEqual({ marker: "D", exitCode: 0 });
    expect(parseOsc133("D;1")).toEqual({ marker: "D", exitCode: 1 });
    expect(parseOsc133("D;127")).toEqual({ marker: "D", exitCode: 127 });
  });

  it("parses a bare D (no code at all) as exitCode: null", () => {
    expect(parseOsc133("D")).toEqual({ marker: "D", exitCode: null });
  });

  it("parses D with a non-numeric code as exitCode: null, never throwing", () => {
    expect(() => parseOsc133("D;not-a-number")).not.toThrow();
    expect(parseOsc133("D;not-a-number")).toEqual({ marker: "D", exitCode: null });
    expect(parseOsc133("D;")).toEqual({ marker: "D", exitCode: null });
  });

  it("returns null for unrecognised markers/payloads, never throwing", () => {
    expect(parseOsc133("")).toBeNull();
    expect(parseOsc133("Z")).toBeNull();
    expect(parseOsc133("some;garbage;payload")).toBeNull();
  });
});

describe("formatBlockDuration", () => {
  it("formats sub-second durations as whole milliseconds", () => {
    expect(formatBlockDuration(0)).toBe("0ms");
    expect(formatBlockDuration(340)).toBe("340ms");
    expect(formatBlockDuration(999)).toBe("999ms");
  });

  it("formats one second and above as seconds to one decimal place", () => {
    expect(formatBlockDuration(1000)).toBe("1.0s");
    expect(formatBlockDuration(2345)).toBe("2.3s");
    expect(formatBlockDuration(65_000)).toBe("65.0s");
  });
});
