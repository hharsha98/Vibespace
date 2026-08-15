import { describe, expect, it } from "vitest";
import { FONT, RADIUS, SHADOW, SPACE } from "./tokens.js";

// These scales exist specifically so every component reads a NAMED step
// instead of scattering ad hoc numbers (see tokens.ts's top comment). The
// one property worth locking down with a test is the property that makes a
// "scale" a scale at all: each step must be strictly larger than the last.
// A future edit that accidentally reorders or duplicates a step (e.g.
// copy-pasting `md`'s value into `lg`) would silently flatten the scale
// back into "everything is one size" — exactly the bug this file exists to
// prevent — without a type error, since these are just numbers. This test
// is what catches that.

function isStrictlyIncreasing(values: number[]): boolean {
  return values.every((value, i) => i === 0 || value > values[i - 1]);
}

describe("SPACE", () => {
  it("is a strictly increasing scale", () => {
    expect(isStrictlyIncreasing([SPACE.xs, SPACE.sm, SPACE.md, SPACE.lg, SPACE.xl])).toBe(true);
  });

  it("starts at the 4px base unit docs/DESIGN.md specifies", () => {
    expect(SPACE.xs).toBe(4);
  });
});

describe("RADIUS", () => {
  it("is a strictly increasing scale", () => {
    expect(isStrictlyIncreasing([RADIUS.sm, RADIUS.md, RADIUS.lg, RADIUS.xl])).toBe(true);
  });

  it("keeps the pane/card radius docs/DESIGN.md §4 already committed to (6px)", () => {
    expect(RADIUS.md).toBe(6);
  });
});

describe("FONT", () => {
  it("is a strictly increasing scale", () => {
    expect(isStrictlyIncreasing([FONT.label, FONT.meta, FONT.body, FONT.title, FONT.heading])).toBe(
      true
    );
  });

  it("keeps the 12px body base docs/DESIGN.md §3 already committed to", () => {
    expect(FONT.body).toBe(12);
  });
});

describe("SHADOW", () => {
  it("defines exactly the three elevation steps (sm/md/lg) every caller expects", () => {
    expect(Object.keys(SHADOW).sort()).toEqual(["lg", "md", "sm"]);
  });

  it("uses a neutral (black, alpha-only) colour so it reads consistently on all 26 themes", () => {
    for (const value of Object.values(SHADOW)) {
      expect(value).toMatch(/^0 .+ rgba\(0, 0, 0, 0\.\d+\)$/);
    }
  });
});
