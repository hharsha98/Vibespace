import { describe, expect, it } from "vitest";
import { tokenizeBody } from "./wikitext.js";

describe("tokenizeBody", () => {
  it("returns a single text token for plain text", () => {
    expect(tokenizeBody("Just plain text.")).toEqual([{ kind: "text", value: "Just plain text." }]);
  });

  it("extracts a link token from [[target]]", () => {
    expect(tokenizeBody("See [[other-note]].")).toEqual([
      { kind: "text", value: "See " },
      { kind: "link", value: "other-note" },
      { kind: "text", value: "." },
    ]);
  });

  it("keeps inline code as a code token, not a link", () => {
    expect(tokenizeBody("Use `[[example]]` syntax.")).toEqual([
      { kind: "text", value: "Use " },
      { kind: "code", value: "`[[example]]`" },
      { kind: "text", value: " syntax." },
    ]);
  });

  it("keeps fenced code blocks as a single code token", () => {
    const body = "before\n```\n[[fake]]\n```\nafter [[real]]";
    const tokens = tokenizeBody(body);
    expect(tokens.some((t) => t.kind === "link" && t.value === "fake")).toBe(false);
    expect(tokens.some((t) => t.kind === "link" && t.value === "real")).toBe(true);
  });

  it("trims whitespace inside link brackets", () => {
    expect(tokenizeBody("[[  spaced  ]]")).toEqual([{ kind: "link", value: "spaced" }]);
  });
});
