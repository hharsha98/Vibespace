import { describe, expect, it } from "vitest";
import { columnEmptyKind } from "./emptyState.js";

describe("columnEmptyKind", () => {
  it("returns 'none' for any column that has cards, regardless of board state", () => {
    expect(columnEmptyKind("todo", 3, true)).toBe("none");
    expect(columnEmptyKind("todo", 1, false)).toBe("none");
    expect(columnEmptyKind("complete", 2, false)).toBe("none");
  });

  it("invites into an empty To Do column on a completely empty board (first run)", () => {
    expect(columnEmptyKind("todo", 0, true)).toBe("invite");
  });

  it("only To Do gets the invite treatment on a first-run board — every other empty column rests", () => {
    expect(columnEmptyKind("in_progress", 0, true)).toBe("resting");
    expect(columnEmptyKind("in_review", 0, true)).toBe("resting");
    expect(columnEmptyKind("complete", 0, true)).toBe("resting");
    expect(columnEmptyKind("cancelled", 0, true)).toBe("resting");
  });

  it("rests (never invites) an empty column when the board has cards elsewhere — 'you finished everything', not 'first run'", () => {
    expect(columnEmptyKind("todo", 0, false)).toBe("resting");
    expect(columnEmptyKind("in_progress", 0, false)).toBe("resting");
    expect(columnEmptyKind("complete", 0, false)).toBe("resting");
  });
});
