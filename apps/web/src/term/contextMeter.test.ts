import { describe, expect, it } from "vitest";
import { ContextMeterTracker, extractContextLeftPercent } from "./contextMeter.js";

describe("extractContextLeftPercent", () => {
  it("returns null when no signal is present", () => {
    expect(extractContextLeftPercent("")).toBeNull();
    expect(extractContextLeftPercent("just some ordinary terminal output\r\n")).toBeNull();
    expect(extractContextLeftPercent("context left over there somewhere, not the pattern")).toBeNull();
  });

  it("parses a plain, unstyled reading", () => {
    expect(extractContextLeftPercent("100% context left")).toBe(100);
    expect(extractContextLeftPercent("7% context left")).toBe(7);
    expect(extractContextLeftPercent("Context 0% left")).toBeNull(); // different phrasing — not Codex's footer format
  });

  it("parses the exact raw byte sequence captured from a live codex pty session", () => {
    // \x1b[24;102H  -> cursor-position CSI (row 24, col 102)
    // then the literal footer text
    // \x1b[39m\x1b[49m\x1b[0m -> SGR resets (fg/bg/all)
    const raw =
      "\x1b[24;3H\x1b[22m\x1b[2m\x1b[2mtab to queue message\x1b[24;102H100% context left\x1b[39m\x1b[49m\x1b[0m";
    expect(extractContextLeftPercent(raw)).toBe(100);
  });

  it("ignores ANSI escape sequences surrounding the value", () => {
    const raw = "\x1b[1m\x1b[33m42% context left\x1b[0m";
    expect(extractContextLeftPercent(raw)).toBe(42);
  });

  it("ignores ANSI escape sequences interspersed WITHIN the value/label", () => {
    const raw = "\x1b[1m42\x1b[0m% \x1b[2mcontext\x1b[22m left";
    expect(extractContextLeftPercent(raw)).toBe(42);
  });

  it("tolerates an OSC sequence (e.g. a window-title update) nearby", () => {
    const raw = "\x1b]0;codex - my-project\x07some footer text 55% context left more text";
    expect(extractContextLeftPercent(raw)).toBe(55);
  });

  it("takes the LAST match when a redraw appended a newer value after an older one", () => {
    const raw = "80% context left ... later in the same buffer ... 45% context left";
    expect(extractContextLeftPercent(raw)).toBe(45);
  });

  it("ignores out-of-range digit sequences rather than reporting a wrong number", () => {
    // 3-digit sequences over 100 shouldn't happen from Codex, but this must
    // never trust the pattern blindly.
    expect(extractContextLeftPercent("999% context left")).toBeNull();
  });

  it("accepts the boundary values 0 and 100", () => {
    expect(extractContextLeftPercent("0% context left")).toBe(0);
    expect(extractContextLeftPercent("100% context left")).toBe(100);
  });

  it("is case-insensitive (defensive — Codex's own casing is lowercase 'context left')", () => {
    expect(extractContextLeftPercent("63% Context Left")).toBe(63);
  });
});

describe("ContextMeterTracker", () => {
  it("starts with no reading", () => {
    const tracker = new ContextMeterTracker();
    expect(tracker.current()).toBeNull();
  });

  it("picks up a reading fed in a single chunk", () => {
    const tracker = new ContextMeterTracker();
    tracker.feed("\x1b[24;102H73% context left\x1b[0m");
    expect(tracker.current()).toBe(73);
  });

  it("picks up a reading split across two pty chunks", () => {
    const tracker = new ContextMeterTracker();
    // A very real scenario: the WebSocket delivers pty bytes in whatever
    // chunk sizes arrive off the wire — nothing guarantees the footer text
    // lands whole in one message.
    tracker.feed("some earlier output\x1b[24;102H10");
    expect(tracker.current()).toBeNull(); // not a complete pattern yet
    tracker.feed("0% context left\x1b[0m");
    expect(tracker.current()).toBe(100);
  });

  it("handles a split landing mid-escape-sequence too", () => {
    const tracker = new ContextMeterTracker();
    tracker.feed("\x1b[24;102H88% context "); // no trailing escape yet
    tracker.feed("left\x1b[39m\x1b[49m\x1b[0m");
    expect(tracker.current()).toBe(88);
  });

  it("a redrawn/updated value replaces the older one", () => {
    const tracker = new ContextMeterTracker();
    tracker.feed("\x1b[24;102H90% context left\x1b[0m");
    expect(tracker.current()).toBe(90);
    // The TUI redraws its footer on the next frame with a lower number —
    // arrives as a later, separate chunk.
    tracker.feed("\x1b[24;102H85% context left\x1b[0m");
    expect(tracker.current()).toBe(85);
    tracker.feed("\x1b[24;102H84% context left\x1b[0m");
    expect(tracker.current()).toBe(84);
  });

  it("a chunk with no signal leaves the last known reading untouched", () => {
    const tracker = new ContextMeterTracker();
    tracker.feed("77% context left");
    expect(tracker.current()).toBe(77);
    tracker.feed("\x1b[2J\x1b[Hsome unrelated redraw noise with no footer text in it");
    expect(tracker.current()).toBe(77);
  });

  it("clear() resets to no reading", () => {
    const tracker = new ContextMeterTracker();
    tracker.feed("50% context left");
    expect(tracker.current()).toBe(50);
    tracker.clear();
    expect(tracker.current()).toBeNull();
  });

  it("a fresh tracker for a new session starts at null, independent of a previous one", () => {
    const first = new ContextMeterTracker();
    first.feed("20% context left");
    expect(first.current()).toBe(20);

    const second = new ContextMeterTracker();
    expect(second.current()).toBeNull();
  });

  it("many small chunks (character-at-a-time delivery) still resolve the full pattern", () => {
    const tracker = new ContextMeterTracker();
    const text = "\x1b[24;102H63% context left\x1b[0m";
    for (const ch of text) tracker.feed(ch);
    expect(tracker.current()).toBe(63);
  });

  it("stays null across many chunks of ordinary agent output with no footer at all", () => {
    const tracker = new ContextMeterTracker();
    for (let i = 0; i < 50; i++) {
      tracker.feed(`\x1b[${i};1Hsome line of assistant output ${i}\r\n`);
    }
    expect(tracker.current()).toBeNull();
  });
});
