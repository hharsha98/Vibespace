import { describe, expect, it } from "vitest";
import { SETUP_REQUIREMENTS } from "./setupRequirements.js";

// Same DOM-free reasoning as billingContent.test.ts's own comment: this
// repo's web package has no jsdom/testing-library, so SetupSection is never
// rendered in a test — the closest thing to "does the Setup panel show real
// content" is scanning the plain data it renders verbatim.
describe("SETUP_REQUIREMENTS", () => {
  it("is non-empty", () => {
    expect(SETUP_REQUIREMENTS.length).toBeGreaterThan(0);
  });

  it("gives every entry a unique id", () => {
    const ids = SETUP_REQUIREMENTS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every entry a non-empty title and body", () => {
    for (const requirement of SETUP_REQUIREMENTS) {
      expect(requirement.title.length).toBeGreaterThan(0);
      expect(requirement.body.length).toBeGreaterThan(0);
    }
  });

  it("gives every entry with an href a non-empty linkLabel", () => {
    for (const requirement of SETUP_REQUIREMENTS) {
      if (requirement.href !== undefined) {
        expect(requirement.linkLabel?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });

  it("covers the four confirmed first-run requirements", () => {
    const ids = SETUP_REQUIREMENTS.map((r) => r.id);
    expect(ids).toEqual(["node", "gatekeeper", "agent-clis", "platform"]);
  });
});
