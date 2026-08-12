import { describe, expect, it } from "vitest";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";

describe("parseFrontmatter", () => {
  it("parses a well-formed frontmatter block", () => {
    const raw = [
      "---",
      "title: Why the parser is recursive",
      "tags: [parser, design]",
      "created: 2026-01-01T00:00:00.000Z",
      "updated: 2026-01-02T00:00:00.000Z",
      "---",
      "Body text with [[other-note]] links.",
    ].join("\n");

    expect(parseFrontmatter(raw)).toEqual({
      title: "Why the parser is recursive",
      tags: ["parser", "design"],
      created: "2026-01-01T00:00:00.000Z",
      updated: "2026-01-02T00:00:00.000Z",
      body: "Body text with [[other-note]] links.",
    });
  });

  it("parses an empty tags array", () => {
    const raw = ["---", "title: No tags", "tags: []", "created: 2026-01-01T00:00:00.000Z", "updated: 2026-01-01T00:00:00.000Z", "---", "Body."].join(
      "\n"
    );
    expect(parseFrontmatter(raw).tags).toEqual([]);
  });

  it("treats a body with no frontmatter block at all as the whole body", () => {
    const raw = "Just a plain markdown file, no frontmatter.";
    expect(parseFrontmatter(raw)).toEqual({
      title: null,
      tags: [],
      created: null,
      updated: null,
      body: raw,
    });
  });

  it("treats an unclosed frontmatter block (missing closing ---) as no frontmatter, without throwing", () => {
    const raw = "---\ntitle: Unclosed\nThis never closes the block.";
    expect(() => parseFrontmatter(raw)).not.toThrow();
    const result = parseFrontmatter(raw);
    expect(result.title).toBeNull();
    expect(result.body).toBe(raw);
  });

  it("handles a frontmatter block with an empty body after it", () => {
    const raw = ["---", "title: Empty body", "tags: []", "created: 2026-01-01T00:00:00.000Z", "updated: 2026-01-01T00:00:00.000Z", "---", ""].join(
      "\n"
    );
    expect(parseFrontmatter(raw).body).toBe("");
  });

  it("ignores lines in the block that aren't key: value pairs, without throwing", () => {
    const raw = ["---", "title: Weird block", "this is not a valid line", "tags: [x]", "---", "Body."].join("\n");
    expect(() => parseFrontmatter(raw)).not.toThrow();
    const result = parseFrontmatter(raw);
    expect(result.title).toBe("Weird block");
    expect(result.tags).toEqual(["x"]);
  });

  it("a title containing a colon still parses correctly (splits on the FIRST colon only)", () => {
    const raw = ["---", "title: Design: the parser", "tags: []", "created: 2026-01-01T00:00:00.000Z", "updated: 2026-01-01T00:00:00.000Z", "---", "Body."].join(
      "\n"
    );
    expect(parseFrontmatter(raw).title).toBe("Design: the parser");
  });
});

describe("serializeFrontmatter", () => {
  it("renders fields and body into the on-disk format", () => {
    const rendered = serializeFrontmatter(
      { title: "My note", tags: ["a", "b"], created: "2026-01-01T00:00:00.000Z", updated: "2026-01-01T00:00:00.000Z" },
      "Body content."
    );
    expect(rendered).toBe(
      [
        "---",
        "title: My note",
        "tags: [a, b]",
        "created: 2026-01-01T00:00:00.000Z",
        "updated: 2026-01-01T00:00:00.000Z",
        "---",
        "Body content.",
      ].join("\n")
    );
  });

  it("renders an empty tags array as []", () => {
    const rendered = serializeFrontmatter(
      { title: "No tags", tags: [], created: "2026-01-01T00:00:00.000Z", updated: "2026-01-01T00:00:00.000Z" },
      "Body."
    );
    expect(rendered).toContain("tags: []");
  });
});

describe("round-trip", () => {
  it("parseFrontmatter(serializeFrontmatter(fields, body)) reproduces fields and body exactly", () => {
    const fields = {
      title: "Round trip note",
      tags: ["one", "two", "three"],
      created: "2026-03-04T10:20:30.000Z",
      updated: "2026-03-05T11:21:31.000Z",
    };
    const body = "Multi-line body.\n\nWith [[a-link]] and more text.\n";

    const serialized = serializeFrontmatter(fields, body);
    const parsed = parseFrontmatter(serialized);

    expect(parsed.title).toBe(fields.title);
    expect(parsed.tags).toEqual(fields.tags);
    expect(parsed.created).toBe(fields.created);
    expect(parsed.updated).toBe(fields.updated);
    expect(parsed.body).toBe(body);
  });
});
