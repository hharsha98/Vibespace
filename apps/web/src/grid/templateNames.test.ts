import { describe, expect, it } from "vitest";
import { templateLabel } from "./templateNames.js";

describe("templateLabel", () => {
  it("names the four templates BridgeSpace's docs explicitly name, with the number kept visible", () => {
    expect(templateLabel(1)).toBe("Single (1)");
    expect(templateLabel(2)).toBe("Split (2)");
    expect(templateLabel(4)).toBe("Quad (4)");
    expect(templateLabel(6)).toBe("Six (6)");
  });

  it("names every other supported template size too", () => {
    expect(templateLabel(8)).toBe("Eight (8)");
    expect(templateLabel(10)).toBe("Ten (10)");
    expect(templateLabel(12)).toBe("Twelve (12)");
    expect(templateLabel(14)).toBe("Fourteen (14)");
    expect(templateLabel(16)).toBe("Sixteen (16)");
  });

  it("falls back to a bare pane count for an unnamed size, singular vs. plural", () => {
    expect(templateLabel(3)).toBe("3 panes");
    expect(templateLabel(0)).toBe("0 panes");
  });
});
