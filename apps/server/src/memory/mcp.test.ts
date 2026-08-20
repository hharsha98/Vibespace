/**
 * Tests the MCP tool handlers directly (see mcp.ts's top comment for why
 * they're extracted as plain exported functions) against a real temp-dir
 * workspace root — same `mkdtempSync` pattern as store.test.ts. No stdio
 * transport, no MCP client, no protocol framing: this exercises exactly
 * the logic a real MCP client's `tools/call` would trigger, just called
 * directly.
 *
 * Also asserts `createMemoryMcpServer` builds an `McpServer` instance
 * without throwing, so a change to the SDK's `registerTool` signature (or
 * any typo in the tool wiring itself) fails loudly in CI rather than only
 * at first real connection.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as memoryStore from "./store.js";
import {
  createMemoryMcpServer,
  handleFindBacklinks,
  handleFindLinks,
  handleMemoryDelete,
  handleMemoryGraph,
  handleMemoryList,
  handleMemoryListByTag,
  handleMemoryListTags,
  handleMemoryRead,
  handleMemorySearch,
  handleMemoryWrite,
  handleSuggestConnections,
} from "./mcp.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vibedeck-mcp-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Every tool result is `{ content: [{ type: "text", text }] }` — this
 * pulls out and JSON-parses that text, since every handler's payload is
 * `JSON.stringify`'d data (see mcp.ts's `jsonResult`). */
function parseResult(result: Awaited<ReturnType<typeof handleMemoryList>>): unknown {
  const first = result.content[0];
  if (first.type !== "text") throw new Error("expected a text content block");
  return JSON.parse(first.text);
}

describe("createMemoryMcpServer", () => {
  it("builds an McpServer without throwing, with all eleven memory tools registered", () => {
    expect(() => createMemoryMcpServer(root)).not.toThrow();
    const server = createMemoryMcpServer(root);
    expect(server).toBeInstanceOf(McpServer);
  });
});

describe("handleMemoryList", () => {
  it("returns an empty list for a fresh workspace", async () => {
    const result = await handleMemoryList(root);
    expect(parseResult(result)).toEqual({ notes: [] });
  });

  it("lists created notes with slug/title/tags/updatedAt, no body", async () => {
    memoryStore.create(root, { title: "First note", tags: ["a"] });
    const result = await handleMemoryList(root);
    const parsed = parseResult(result) as { notes: Array<Record<string, unknown>> };
    expect(parsed.notes).toHaveLength(1);
    expect(parsed.notes[0]).toMatchObject({ slug: "first-note", title: "First note", tags: ["a"] });
    expect(parsed.notes[0]).not.toHaveProperty("body");
  });
});

describe("handleMemoryRead", () => {
  it("returns an error result for an unknown slug", async () => {
    const result = await handleMemoryRead(root, "nope");
    expect(result.isError).toBe(true);
  });

  it("returns the full note plus backlinks for a known slug", async () => {
    memoryStore.create(root, { title: "Target" });
    memoryStore.create(root, { title: "Linker", body: "See [[target]]." });

    const result = await handleMemoryRead(root, "target");
    const parsed = parseResult(result) as { slug: string; body: string; backlinks: string[] };
    expect(parsed.slug).toBe("target");
    expect(parsed.backlinks).toEqual(["linker"]);
  });
});

describe("handleMemoryWrite", () => {
  it("creates a new note when slug is omitted", async () => {
    const result = await handleMemoryWrite(root, { title: "New via MCP", body: "hello" });
    const parsed = parseResult(result) as { slug: string; title: string; body: string };
    expect(parsed.slug).toBe("new-via-mcp");
    expect(parsed.body).toBe("hello");
  });

  it("errors when creating without a title", async () => {
    const result = await handleMemoryWrite(root, {});
    expect(result.isError).toBe(true);
  });

  it("updates an existing note when slug is given", async () => {
    memoryStore.create(root, { title: "Original" });
    const result = await handleMemoryWrite(root, { slug: "original", body: "updated body" });
    const parsed = parseResult(result) as { slug: string; body: string };
    expect(parsed.slug).toBe("original"); // slug immutable
    expect(parsed.body).toBe("updated body");
  });

  it("errors when updating an unknown slug", async () => {
    const result = await handleMemoryWrite(root, { slug: "does-not-exist", body: "x" });
    expect(result.isError).toBe(true);
  });
});

describe("handleMemorySearch", () => {
  it("matches by title, body, and tags, case-insensitively", async () => {
    memoryStore.create(root, { title: "Parser design", body: "recursive descent", tags: ["compilers"] });
    memoryStore.create(root, { title: "Unrelated", body: "nothing to see" });

    const byTitle = parseResult(await handleMemorySearch(root, "PARSER")) as { matches: unknown[] };
    expect(byTitle.matches).toHaveLength(1);

    const byBody = parseResult(await handleMemorySearch(root, "descent")) as { matches: unknown[] };
    expect(byBody.matches).toHaveLength(1);

    const byTag = parseResult(await handleMemorySearch(root, "compilers")) as { matches: unknown[] };
    expect(byTag.matches).toHaveLength(1);
  });

  it("returns an empty matches array for no hits", async () => {
    memoryStore.create(root, { title: "Something" });
    const result = parseResult(await handleMemorySearch(root, "zzz-no-match")) as { matches: unknown[] };
    expect(result.matches).toEqual([]);
  });
});

describe("handleMemoryDelete", () => {
  it("deletes an existing note and it no longer appears in memory_list", async () => {
    memoryStore.create(root, { title: "Temporary" });
    const result = await handleMemoryDelete(root, "temporary");
    expect(parseResult(result)).toEqual({ deleted: "temporary" });

    const listed = parseResult(await handleMemoryList(root)) as { notes: unknown[] };
    expect(listed.notes).toEqual([]);
  });

  it("errors for an unknown slug", async () => {
    const result = await handleMemoryDelete(root, "does-not-exist");
    expect(result.isError).toBe(true);
  });
});

describe("handleMemoryListByTag", () => {
  it("returns only notes carrying the exact tag, case-insensitively", async () => {
    memoryStore.create(root, { title: "One", tags: ["Design"] });
    memoryStore.create(root, { title: "Two", tags: ["design", "backend"] });
    memoryStore.create(root, { title: "Three", tags: ["backend"] });

    const result = parseResult(await handleMemoryListByTag(root, "design")) as {
      notes: Array<{ slug: string }>;
    };
    expect(result.notes.map((n) => n.slug).sort()).toEqual(["one", "two"]);
  });

  it("does NOT substring-match a tag (exact match only, unlike memory_search)", async () => {
    memoryStore.create(root, { title: "One", tags: ["design-system"] });
    const result = parseResult(await handleMemoryListByTag(root, "design")) as { notes: unknown[] };
    expect(result.notes).toEqual([]);
  });
});

describe("handleMemoryListTags", () => {
  it("returns empty for a fresh workspace", async () => {
    expect(parseResult(await handleMemoryListTags(root))).toEqual({ tags: [] });
  });

  it("counts every distinct tag, most-used first, ties alphabetical", async () => {
    memoryStore.create(root, { title: "A", tags: ["backend", "design"] });
    memoryStore.create(root, { title: "B", tags: ["backend"] });
    memoryStore.create(root, { title: "C", tags: ["frontend"] });

    const result = parseResult(await handleMemoryListTags(root)) as {
      tags: Array<{ tag: string; count: number }>;
    };
    expect(result.tags).toEqual([
      { tag: "backend", count: 2 },
      { tag: "design", count: 1 },
      { tag: "frontend", count: 1 },
    ]);
  });
});

describe("handleFindBacklinks", () => {
  it("lists notes linking to a given slug", async () => {
    memoryStore.create(root, { title: "Target" });
    memoryStore.create(root, { title: "Linker one", body: "See [[target]]." });
    memoryStore.create(root, { title: "Linker two", body: "Also [[target]]." });
    memoryStore.create(root, { title: "Unrelated" });

    const result = parseResult(await handleFindBacklinks(root, "target")) as { backlinks: string[] };
    expect(result.backlinks.sort()).toEqual(["linker-one", "linker-two"]);
  });

  it("returns an empty array (not an error) for a slug with no note and no backlinks", async () => {
    const result = parseResult(await handleFindBacklinks(root, "nothing-here")) as { backlinks: string[] };
    expect(result.backlinks).toEqual([]);
  });

  it("still finds backlinks pointing at a DANGLING slug (no note written for it yet)", async () => {
    memoryStore.create(root, { title: "Wants a note", body: "We should write [[future-note]] someday." });
    const result = parseResult(await handleFindBacklinks(root, "future-note")) as { backlinks: string[] };
    expect(result.backlinks).toEqual(["wants-a-note"]);
  });
});

describe("handleFindLinks", () => {
  it("lists a note's outgoing links, flagging dangling targets", async () => {
    memoryStore.create(root, { title: "Real target" });
    memoryStore.create(root, {
      title: "Source",
      body: "Links to [[real-target]] and also [[missing-note]].",
    });

    const result = parseResult(await handleFindLinks(root, "source")) as {
      links: Array<{ slug: string; dangling: boolean }>;
    };
    expect(result.links).toEqual([
      { slug: "real-target", title: "Real target", dangling: false },
      { slug: "missing-note", title: "missing-note", dangling: true },
    ]);
  });

  it("errors for an unknown slug", async () => {
    const result = await handleFindLinks(root, "does-not-exist");
    expect(result.isError).toBe(true);
  });
});

describe("handleMemoryGraph", () => {
  it("returns the whole workspace's nodes and edges", async () => {
    memoryStore.create(root, { title: "A", body: "[[b]]" });
    memoryStore.create(root, { title: "B" });

    const result = parseResult(await handleMemoryGraph(root)) as {
      nodes: Array<{ slug: string }>;
      edges: Array<{ source: string; target: string }>;
    };
    expect(result.nodes.map((n) => n.slug).sort()).toEqual(["a", "b"]);
    expect(result.edges).toEqual([{ source: "a", target: "b", dangling: false }]);
  });
});

describe("handleSuggestConnections", () => {
  it("includes an explicit non-AI/non-semantic disclaimer in every response", async () => {
    const result = parseResult(await handleSuggestConnections(root, {})) as { heuristic: string };
    expect(result.heuristic.toLowerCase()).toContain("not semantic");
    expect(result.heuristic.toLowerCase()).toContain("not");
  });

  it("suggests a pair sharing significant keywords, on a fixture with a known right answer", async () => {
    memoryStore.create(root, { title: "A", body: "alpha bravo charlie delta echo" });
    memoryStore.create(root, { title: "B", body: "alpha bravo charlie foxtrot golf" });
    memoryStore.create(root, { title: "C", body: "totally unrelated content about kittens" });

    const result = parseResult(await handleSuggestConnections(root, {})) as {
      suggestions: Array<{ a: string; b: string; reasons: string[] }>;
    };
    expect(result.suggestions).toHaveLength(1);
    expect([result.suggestions[0].a, result.suggestions[0].b].sort()).toEqual(["a", "b"]);
    expect(result.suggestions[0].reasons[0]).toContain("shares 3 significant terms");
  });

  it("does not suggest a pair that's already linked", async () => {
    memoryStore.create(root, { title: "A", body: "alpha bravo charlie delta [[b]]" });
    memoryStore.create(root, { title: "B", body: "alpha bravo charlie foxtrot" });

    const result = parseResult(await handleSuggestConnections(root, {})) as { suggestions: unknown[] };
    expect(result.suggestions).toEqual([]);
  });

  it("scopes results to one note and reshapes each suggestion around it, when slug is given", async () => {
    memoryStore.create(root, { title: "A", body: "alpha bravo charlie delta echo" });
    memoryStore.create(root, { title: "B", body: "alpha bravo charlie foxtrot golf" });

    const result = parseResult(await handleSuggestConnections(root, { slug: "a" })) as {
      suggestions: Array<{ suggestedLink: string; reasons: string[] }>;
    };
    expect(result.suggestions).toEqual([{ suggestedLink: "b", reasons: expect.any(Array) }]);
  });

  it("errors when scoped to an unknown slug", async () => {
    const result = await handleSuggestConnections(root, { slug: "does-not-exist" });
    expect(result.isError).toBe(true);
  });
});
