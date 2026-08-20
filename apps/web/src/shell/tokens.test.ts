import { describe, expect, it } from "vitest";
import { FONT, LIGHT_SHADOW, MOTION, RADIUS, SHADOW, SHADOW_VAR, SPACE } from "./tokens.js";

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

  it("uses a neutral (black, alpha-only) colour so it reads consistently on all themes", () => {
    for (const value of Object.values(SHADOW)) {
      expect(value).toMatch(/^0 .+ rgba\(0, 0, 0, 0\.\d+\)$/);
    }
  });
});

/** Pulls the alpha (the last `0.NN` inside the `rgba(...)`) and the blur
 * radius (the second length in `0 <offset> <blur> rgba(...)`) out of a
 * SHADOW-shaped CSS value, so the light/dark comparison below can assert on
 * the actual numbers rather than eyeballing the strings. */
function shadowAlpha(value: string): number {
  const match = value.match(/rgba\(0, 0, 0, (0\.\d+)\)/);
  if (!match) throw new Error(`not a SHADOW-shaped value: ${value}`);
  return Number(match[1]);
}
function shadowBlurPx(value: string): number {
  const match = value.match(/^0 \d+px (\d+)px/);
  if (!match) throw new Error(`not a SHADOW-shaped value: ${value}`);
  return Number(match[1]);
}

// LIGHT_SHADOW exists because a shadow scale tuned against the near-black
// dark canvas either vanished or read as muddy on a light one (the
// "light themes are broken" bug this whole pass fixes) — the one property
// that actually encodes "we fixed it" is that light is measurably lighter
// AND tighter than dark at every one of the three steps, not just a
// differently-worded comment saying so.
describe("LIGHT_SHADOW", () => {
  it("defines exactly the same three elevation steps SHADOW does", () => {
    expect(Object.keys(LIGHT_SHADOW).sort()).toEqual(["lg", "md", "sm"]);
  });

  it("uses a neutral (black, alpha-only) colour, same as SHADOW", () => {
    for (const value of Object.values(LIGHT_SHADOW)) {
      expect(value).toMatch(/^0 .+ rgba\(0, 0, 0, 0\.\d+\)$/);
    }
  });

  it("is lighter (lower alpha) than SHADOW at every step", () => {
    for (const key of ["sm", "md", "lg"] as const) {
      expect(shadowAlpha(LIGHT_SHADOW[key])).toBeLessThan(shadowAlpha(SHADOW[key]));
    }
  });

  it("is tighter (smaller blur radius) than SHADOW at every step", () => {
    for (const key of ["sm", "md", "lg"] as const) {
      expect(shadowBlurPx(LIGHT_SHADOW[key])).toBeLessThan(shadowBlurPx(SHADOW[key]));
    }
  });

  it("is itself a strictly increasing scale (sm < md < lg) in both alpha and blur", () => {
    const alphas = (["sm", "md", "lg"] as const).map((k) => shadowAlpha(LIGHT_SHADOW[k]));
    const blurs = (["sm", "md", "lg"] as const).map((k) => shadowBlurPx(LIGHT_SHADOW[k]));
    expect(isStrictlyIncreasing(alphas)).toBe(true);
    expect(isStrictlyIncreasing(blurs)).toBe(true);
  });
});

describe("SHADOW_VAR", () => {
  it("maps each SHADOW/LIGHT_SHADOW step to the matching CSS custom property", () => {
    expect(SHADOW_VAR.sm).toBe("var(--vd-shadow-sm)");
    expect(SHADOW_VAR.md).toBe("var(--vd-shadow-md)");
    expect(SHADOW_VAR.lg).toBe("var(--vd-shadow-lg)");
  });
});

describe("MOTION", () => {
  it("is a strictly increasing scale", () => {
    const ms = (v: string) => Number(v.replace("ms", ""));
    expect(isStrictlyIncreasing([ms(MOTION.fast), ms(MOTION.base), ms(MOTION.slow)])).toBe(true);
  });

  it("stays inside the 120-180ms range the design brief specifies", () => {
    for (const key of ["fast", "base", "slow"] as const) {
      const value = Number(MOTION[key].replace("ms", ""));
      expect(value).toBeGreaterThanOrEqual(120);
      expect(value).toBeLessThanOrEqual(180);
    }
  });

  it("defines one shared easing curve as a valid cubic-bezier function", () => {
    expect(MOTION.easing).toMatch(/^cubic-bezier\((-?\d*\.?\d+,\s*){3}-?\d*\.?\d+\)$/);
  });
});
