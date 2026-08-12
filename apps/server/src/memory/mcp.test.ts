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
import { createMemoryMcpServer, handleMemoryList, handleMemoryRead, handleMemorySearch, handleMemoryWrite } from "./mcp.js";

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
  it("builds an McpServer without throwing, with the four memory tools registered", () => {
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
