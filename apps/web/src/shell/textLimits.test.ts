import { describe, expect, it } from "vitest";
import { charCountColor, charCountStatus } from "./textLimits.js";

describe("charCountStatus", () => {
  it("is idle well under the cap", () => {
    expect(charCountStatus(10, 100)).toBe("idle");
  });

  it("is idle right up to (but not including) the 90% warn threshold", () => {
    expect(charCountStatus(89, 100)).toBe("idle");
  });

  it("becomes warn exactly at the 90% threshold", () => {
    expect(charCountStatus(90, 100)).toBe("warn");
  });

  it("stays warn right up to the cap itself", () => {
    expect(charCountStatus(100, 100)).toBe("warn");
  });

  it("becomes danger only once length exceeds the cap", () => {
    expect(charCountStatus(101, 100)).toBe("danger");
  });

  it("is idle for an empty string against a real-world cap", () => {
    expect(charCountStatus(0, 100_000)).toBe("idle");
  });
});

describe("charCountColor", () => {
  it("maps each status to its own DESIGN.md token, not shared colours", () => {
    expect(charCountColor("idle")).toBe("var(--vd-text-faint)");
    expect(charCountColor("warn")).toBe("var(--vd-warn)");
    expect(charCountColor("danger")).toBe("var(--vd-danger)");
  });
});
