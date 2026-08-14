import { describe, expect, it } from "vitest";
import type { ParsedSkill } from "./parse.js";
import { SKILL_INJECT_MAX_LENGTH, buildSkillInjectionText, prepareSkillInjection } from "./inject.js";

function makeSkill(overrides: Partial<ParsedSkill> = {}): ParsedSkill {
  return {
    name: "test-skill",
    description: "A test skill",
    license: null,
    compatibility: null,
    metadata: {},
    allowedTools: null,
    body: "Do the thing.",
    ...overrides,
  };
}

describe("buildSkillInjectionText", () => {
  it("ends in exactly one trailing newline", () => {
    const { text } = buildSkillInjectionText(makeSkill());
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
  });

  it("folds a body with many internal newlines into a single line, still ending in exactly one newline", () => {
    const skill = makeSkill({ body: "Step one.\n\nStep two.\n\n\nStep three.\nStep four." });
    const { text } = buildSkillInjectionText(skill);

    // Exactly one newline total — the deliberate trailing "submit".
    expect(text.match(/\n/g)?.length).toBe(1);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).not.toMatch(/\n.*\S/); // nothing follows the single newline
  });

  it("includes the skill's name and description as a label", () => {
    const skill = makeSkill({ name: "pdf-helper", description: "Helps with PDFs" });
    const { text } = buildSkillInjectionText(skill);
    expect(text).toContain("pdf-helper");
    expect(text).toContain("Helps with PDFs");
  });

  it("includes the body content", () => {
    const skill = makeSkill({ body: "A very specific instruction string." });
    const { text } = buildSkillInjectionText(skill);
    expect(text).toContain("A very specific instruction string.");
  });

  it("does not truncate a body under the cap", () => {
    const skill = makeSkill({ body: "short" });
    const { text, truncated } = buildSkillInjectionText(skill);
    expect(truncated).toBe(false);
    expect(text).toContain("short");
  });

  it("truncates a body over SKILL_INJECT_MAX_LENGTH and marks it truncated", () => {
    const hugeBody = "x".repeat(SKILL_INJECT_MAX_LENGTH * 2);
    const skill = makeSkill({ body: hugeBody });
    const { text, truncated } = buildSkillInjectionText(skill);

    expect(truncated).toBe(true);
    expect(text).toContain("[truncated]");
    // The text (minus the trailing newline and marker) never exceeds the cap.
    expect(text.length).toBeLessThan(hugeBody.length);
    expect(text.endsWith("\n")).toBe(true);
    // Still exactly one newline even when truncated.
    expect(text.match(/\n/g)?.length).toBe(1);
  });
});

describe("prepareSkillInjection", () => {
  it("refuses a shell pane with a clear, actionable error", () => {
    const result = prepareSkillInjection("shell", makeSkill());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/shell/i);
      expect(result.error).toMatch(/cannot/i);
    }
  });

  it.each(["claude", "cursor-agent", "codex"] as const)("accepts an agent pane (%s) and returns the injection text", (agent) => {
    const result = prepareSkillInjection(agent, makeSkill({ body: "Do the specific thing." }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain("Do the specific thing.");
      expect(result.text.endsWith("\n")).toBe(true);
      expect(result.truncated).toBe(false);
    }
  });

  it("returns truncated: true for an agent pane when the body is oversized", () => {
    const hugeBody = "y".repeat(SKILL_INJECT_MAX_LENGTH * 3);
    const result = prepareSkillInjection("claude", makeSkill({ body: hugeBody }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.truncated).toBe(true);
    }
  });
});
