import { describe, expect, it } from "vitest";
import { parseSkill } from "./parse.js";

describe("parseSkill", () => {
  it("parses a valid skill with every optional field present", () => {
    const raw = [
      "---",
      "name: pdf-helper",
      "description: Helps with PDF files",
      "license: MIT",
      "compatibility: Requires bash and python3",
      "allowed-tools: bash python",
      "metadata:",
      "  author: vibedeck",
      "  version: 1.0",
      "---",
      "# PDF Helper",
      "",
      "Do the thing.",
    ].join("\n");

    const result = parseSkill(raw, "pdf-helper");
    expect(result.diagnostics).toEqual([]);
    expect(result.skill).toEqual({
      name: "pdf-helper",
      description: "Helps with PDF files",
      license: "MIT",
      compatibility: "Requires bash and python3",
      metadata: { author: "vibedeck", version: "1.0" },
      allowedTools: "bash python",
      body: "# PDF Helper\n\nDo the thing.",
    });
  });

  it("parses a minimal skill with only the required fields", () => {
    const raw = ["---", "name: minimal", "description: A minimal skill", "---", "Body."].join("\n");
    const result = parseSkill(raw, "minimal");
    expect(result.diagnostics).toEqual([]);
    expect(result.skill).toEqual({
      name: "minimal",
      description: "A minimal skill",
      license: null,
      compatibility: null,
      metadata: {},
      allowedTools: null,
      body: "Body.",
    });
  });

  describe("SKIP cases", () => {
    it("skips a skill with a missing description, recording an error", () => {
      const raw = ["---", "name: no-description", "---", "Body."].join("\n");
      const result = parseSkill(raw, "no-description");
      expect(result.skill).toBeNull();
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0].level).toBe("error");
      expect(result.diagnostics[0].message).toMatch(/description/i);
    });

    it("skips a skill with an empty (whitespace-only) description", () => {
      const raw = ["---", "name: blank-description", "description:    ", "---", "Body."].join("\n");
      const result = parseSkill(raw, "blank-description");
      expect(result.skill).toBeNull();
      expect(result.diagnostics[0].level).toBe("error");
    });

    it("skips a skill with no frontmatter block at all, without throwing", () => {
      const raw = "Just a markdown file with no frontmatter.";
      expect(() => parseSkill(raw, "no-frontmatter")).not.toThrow();
      const result = parseSkill(raw, "no-frontmatter");
      expect(result.skill).toBeNull();
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0].level).toBe("error");
    });

    it("skips a skill with an unclosed frontmatter block, without throwing", () => {
      const raw = "---\nname: unclosed\ndescription: never closes";
      expect(() => parseSkill(raw, "unclosed")).not.toThrow();
      const result = parseSkill(raw, "unclosed");
      expect(result.skill).toBeNull();
    });
  });

  describe("the malformed-YAML fallback (first colon wins)", () => {
    it("handles an unquoted description value containing its own colon", () => {
      const raw = [
        "---",
        "name: pdf-helper",
        "description: Use this skill when: the user asks about PDFs",
        "---",
        "Body.",
      ].join("\n");

      const result = parseSkill(raw, "pdf-helper");
      expect(result.skill).not.toBeNull();
      expect(result.skill?.description).toBe("Use this skill when: the user asks about PDFs");
      // This is a legitimate description, not a malformed one — no diagnostics.
      expect(result.diagnostics).toEqual([]);
    });

    it("applies the same first-colon rule inside the nested metadata block", () => {
      const raw = [
        "---",
        "name: with-metadata-colon",
        "description: A skill",
        "metadata:",
        "  note: remember: colons are fine",
        "---",
        "Body.",
      ].join("\n");

      const result = parseSkill(raw, "with-metadata-colon");
      expect(result.skill?.metadata).toEqual({ note: "remember: colons are fine" });
    });
  });

  describe("lenient name validation", () => {
    it("warns but still loads when name doesn't match the parent directory", () => {
      const raw = ["---", "name: actual-name", "description: A skill", "---", "Body."].join("\n");
      const result = parseSkill(raw, "different-directory-name");
      expect(result.skill).not.toBeNull();
      expect(result.skill?.name).toBe("actual-name");
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0].level).toBe("warning");
      expect(result.diagnostics[0].message).toMatch(/does not match/i);
    });

    it("falls back to the directory name and warns when name is missing", () => {
      const raw = ["---", "description: A skill with no name field", "---", "Body."].join("\n");
      const result = parseSkill(raw, "fallback-dir-name");
      expect(result.skill?.name).toBe("fallback-dir-name");
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0].level).toBe("warning");
      expect(result.diagnostics[0].message).toMatch(/missing/i);
    });

    it("warns but still loads when name exceeds 64 characters", () => {
      const longName = "a".repeat(65);
      const raw = ["---", `name: ${longName}`, "description: A skill", "---", "Body."].join("\n");
      const result = parseSkill(raw, longName);
      expect(result.skill).not.toBeNull();
      expect(result.skill?.name).toBe(longName);
      expect(result.diagnostics.some((d) => d.level === "warning" && /64/.test(d.message))).toBe(true);
    });

    it.each([
      ["Uppercase-Name", "uppercase"],
      ["under_score", "underscore"],
      ["-leading-hyphen", "leading hyphen"],
      ["trailing-hyphen-", "trailing hyphen"],
      ["double--hyphen", "double hyphen"],
    ])("warns but still loads for an invalid name %s (%s)", (invalidName) => {
      const raw = ["---", `name: ${invalidName}`, "description: A skill", "---", "Body."].join("\n");
      const result = parseSkill(raw, invalidName);
      expect(result.skill).not.toBeNull();
      expect(result.skill?.name).toBe(invalidName);
      expect(result.diagnostics.some((d) => d.level === "warning")).toBe(true);
    });

    it("does not warn for a valid multi-segment hyphenated name matching its directory", () => {
      const raw = ["---", "name: a-valid-skill-name-123", "description: A skill", "---", "Body."].join("\n");
      const result = parseSkill(raw, "a-valid-skill-name-123");
      expect(result.diagnostics).toEqual([]);
    });
  });

  describe("length warnings that still load", () => {
    it("warns but still loads when description exceeds 1024 characters", () => {
      const longDescription = "x".repeat(1025);
      const raw = ["---", "name: long-desc", `description: ${longDescription}`, "---", "Body."].join("\n");
      const result = parseSkill(raw, "long-desc");
      expect(result.skill).not.toBeNull();
      expect(result.skill?.description).toBe(longDescription);
      expect(result.diagnostics.some((d) => d.level === "warning" && /1024/.test(d.message))).toBe(true);
    });

    it("warns but still loads when compatibility exceeds 500 characters", () => {
      const longCompat = "y".repeat(501);
      const raw = ["---", "name: long-compat", "description: A skill", `compatibility: ${longCompat}`, "---", "Body."].join(
        "\n"
      );
      const result = parseSkill(raw, "long-compat");
      expect(result.skill?.compatibility).toBe(longCompat);
      expect(result.diagnostics.some((d) => d.level === "warning" && /500/.test(d.message))).toBe(true);
    });
  });

  it("parses the nested metadata map as a flat string-to-string object", () => {
    const raw = [
      "---",
      "name: with-metadata",
      "description: A skill",
      "metadata:",
      "  author: someone",
      "  category: docs",
      "  stability: experimental",
      "---",
      "Body.",
    ].join("\n");

    const result = parseSkill(raw, "with-metadata");
    expect(result.skill?.metadata).toEqual({
      author: "someone",
      category: "docs",
      stability: "experimental",
    });
  });

  it("returns an empty metadata object when metadata is absent", () => {
    const raw = ["---", "name: no-metadata", "description: A skill", "---", "Body."].join("\n");
    const result = parseSkill(raw, "no-metadata");
    expect(result.skill?.metadata).toEqual({});
  });

  it("never throws on garbage input", () => {
    expect(() => parseSkill("", "empty")).not.toThrow();
    expect(() => parseSkill("---", "just-a-dash")).not.toThrow();
    expect(() => parseSkill("---\n---\n", "empty-block")).not.toThrow();
    expect(() => parseSkill("\0\0\0binary-ish", "weird")).not.toThrow();
  });
});
