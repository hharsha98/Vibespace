import { describe, expect, it } from "vitest";
import { BILLING_PARAGRAPHS } from "./billingContent.js";

// The exact regression this file exists to guard against: someone later
// "helpfully" adding a price, a plan tier, or an upgrade/subscribe control
// to the Billing section — vibespace is free and MIT-licensed; there is
// nothing to sell. Settings.tsx renders BILLING_PARAGRAPHS verbatim (one
// <p> per entry, no other Billing-specific markup), so scanning this
// constant directly is equivalent to scanning what actually reaches the
// screen — the closest DOM-free proxy this repo's test tooling has for
// checking rendered content (no jsdom/testing-library, see Settings.tsx's
// own top comment).
const FORBIDDEN_PATTERN = /\$\d|\bprice\b|\bpricing\b|\bplan\b|\btier\b|\bupgrade\b|\bsubscribe\b|\bsubscription\b|\btrial\b|\bbilling cycle\b/i;

describe("BILLING_PARAGRAPHS", () => {
  it("has real content", () => {
    expect(BILLING_PARAGRAPHS.length).toBeGreaterThan(0);
    for (const paragraph of BILLING_PARAGRAPHS) {
      expect(paragraph.length).toBeGreaterThan(0);
    }
  });

  it("never mentions a price, plan tier, or upgrade/subscribe control", () => {
    const combined = BILLING_PARAGRAPHS.join(" ");
    expect(combined).not.toMatch(FORBIDDEN_PATTERN);
  });

  it("states the honest story: free, open source, MIT licensed", () => {
    const combined = BILLING_PARAGRAPHS.join(" ").toLowerCase();
    expect(combined).toContain("free");
    expect(combined).toContain("mit");
  });
});
