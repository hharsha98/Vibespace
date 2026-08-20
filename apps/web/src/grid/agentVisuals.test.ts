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

  // With 10 agents but only 6 status/accent tokens in the palette
  // (--vd-accent + the 5 StatusKind tokens), 1:1 distinctness is no longer
  // possible without inventing a new hex value — see agentAccentVar's own
  // comment. What must still hold: every one of the 6 tokens gets used
  // (nothing is wasted/duplicated to the point some tokens go unused), and
  // the glyph shape (tested only visually, not here) carries distinctness
  // the wrapper accent alone no longer can.
  it("uses every one of the palette's 6 accent/status tokens at least once", () => {
    const accents = AGENT_IDS.map((id) => agentAccentVar(id));
    expect(new Set(accents).size).toBe(6);
  });

  it("keeps the four original agents' accents exactly as they were before the 10-agent expansion", () => {
    expect(agentAccentVar("claude")).toBe("var(--vd-accent)");
    expect(agentAccentVar("cursor-agent")).toBe("var(--vd-info)");
    expect(agentAccentVar("codex")).toBe("var(--vd-ok)");
    expect(agentAccentVar("shell")).toBe("var(--vd-idle)");
  });

  it("colours claude with the app's primary accent token", () => {
    expect(agentAccentVar("claude")).toBe("var(--vd-accent)");
  });

  it("colours the plain shell with the neutral idle token, not a 'brand' colour", () => {
    expect(agentAccentVar("shell")).toBe("var(--vd-idle)");
  });
});
