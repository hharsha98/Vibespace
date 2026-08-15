import { describe, expect, it } from "vitest";
import { AGENT_IDS } from "@vibedeck/shared";
import { agentAccentVar } from "./agentVisuals.js";

// `agentAccentVar` is the one bit of pure logic in agentVisuals.tsx (the
// rest is JSX glyphs, deliberately untested here — see this repo's
// established split, e.g. shell/ui.test.ts only covering `sessionStatusKind`
// and not ui.tsx's components). What actually matters, and what a future
// edit could silently break, is the constraint the file's own top comment
// promises: every agent maps to one of the UI palette's EXISTING CSS custom
// properties, never a new hard-coded hex value.
describe("agentAccentVar", () => {
  it("maps every known AgentId to a CSS custom property (never a raw hex value)", () => {
    for (const id of AGENT_IDS) {
      expect(agentAccentVar(id)).toMatch(/^var\(--vd-[a-z-]+\)$/);
    }
  });

  it("gives every agent a DIFFERENT accent, so cards read as visually distinct", () => {
    const accents = AGENT_IDS.map((id) => agentAccentVar(id));
    expect(new Set(accents).size).toBe(AGENT_IDS.length);
  });

  it("colours claude with the app's primary accent token", () => {
    expect(agentAccentVar("claude")).toBe("var(--vd-accent)");
  });

  it("colours the plain shell with the neutral idle token, not a 'brand' colour", () => {
    expect(agentAccentVar("shell")).toBe("var(--vd-idle)");
  });
});
