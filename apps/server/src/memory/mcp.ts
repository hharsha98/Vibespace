/**
 * The MCP (Model Context Protocol) surface for Phase 8's shared memory —
 * the actual point of this phase: Claude Code, cursor-agent, and Codex can
 * all connect to the SAME `McpServer` instance (one per workspace, pointed
 * at that workspace's `.vibedeck/memory/` directory) and read/write the
 * SAME notes the Memory tab and Graph view show. See docs/MEMORY.md for the
 * exact config each agent's CLI needs to paste in.
 *
 * This module only BUILDS the server (registers tools against `./store.ts`
 * and `./links.ts` — the exact same functions the REST routes use, so
 * there is only one source of truth for "what a note is" across HTTP and
 * MCP). It does not start a transport; `mcp-server.ts` is the thin runnable
 * entry that does that, kept separate so this file stays unit-testable
 * without spawning a real stdio process.
 *
 * Tools, per the phase spec: `memory_list`, `memory_read`, `memory_write`,
 * `memory_search`. Every tool returns plain JSON-in-text content — the
 * simplest, most broadly-compatible MCP tool result shape, and easy for a
 * model to parse without needing `outputSchema`/structured-content support
 * from every client.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as memoryStore from "./store.js";
import { buildGraph } from "./links.js";

function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

// --- Tool handlers ----------------------------------------------------------
// Extracted as plain, exported async functions (rather than inlined into
// `registerTool` calls below) specifically so `mcp.test.ts` can call them
// directly with a temp-dir root and assert on the returned `CallToolResult`
// — no real stdio transport, no MCP client, no protocol framing involved.
// `createMemoryMcpServer` below is just these four functions wired into
// `registerTool`'s callback shape.

export async function handleMemoryList(root: string): Promise<CallToolResult> {
  const notes = memoryStore.list(root);
  return jsonResult({
    notes: notes.map((n) => ({ slug: n.slug, title: n.title, tags: n.tags, updatedAt: n.updatedAt })),
  });
}

export async function handleMemoryRead(root: string, slug: string): Promise<CallToolResult> {
  const note = memoryStore.get(root, slug);
  if (!note) {
    return errorResult(`No memory note with slug "${slug}". Use memory_list or memory_search to find one.`);
  }
  const { backlinks } = buildGraph(memoryStore.list(root));
  return jsonResult({ ...note, backlinks: backlinks[slug] ?? [] });
}

export interface MemoryWriteArgs {
  slug?: string;
  title?: string;
  body?: string;
  tags?: string[];
}

export async function handleMemoryWrite(root: string, args: MemoryWriteArgs): Promise<CallToolResult> {
  const { slug, title, body, tags } = args;
  if (slug) {
    const updated = memoryStore.update(root, slug, { title, body, tags });
    if (!updated) return errorResult(`No memory note with slug "${slug}" to update.`);
    return jsonResult(updated);
  }
  if (!title || title.trim().length === 0) {
    return errorResult('Creating a new note requires a non-empty "title" (slug was omitted).');
  }
  const created = memoryStore.create(root, { title, body, tags });
  return jsonResult(created);
}

export async function handleMemorySearch(root: string, query: string): Promise<CallToolResult> {
  const q = query.toLowerCase();
  const matches = memoryStore
    .list(root)
    .filter(
      (n) =>
        n.title.toLowerCase().includes(q) ||
        n.body.toLowerCase().includes(q) ||
        n.tags.some((tag) => tag.toLowerCase().includes(q))
    )
    .map((n) => ({ slug: n.slug, title: n.title, tags: n.tags, updatedAt: n.updatedAt }));
  return jsonResult({ query, matches });
}

/**
 * Builds an `McpServer` exposing `root`'s memory notes — every tool here is
 * scoped to this one workspace root, matching how `mcp-server.ts` invokes
 * this (one process, one workspace, given as a CLI argument), so no tool
 * takes a `workspaceId`/`root` argument itself the way the REST routes do.
 */
export function createMemoryMcpServer(root: string): McpServer {
  const server = new McpServer({ name: "vibedeck-memory", version: "1.0.0" });

  server.registerTool(
    "memory_list",
    {
      title: "List memory notes",
      description:
        "List every shared memory note in this workspace (slug, title, tags, and timestamps — not the full body). Use memory_read to fetch one note's full content.",
      inputSchema: {},
    },
    () => handleMemoryList(root)
  );

  server.registerTool(
    "memory_read",
    {
      title: "Read a memory note",
      description:
        "Read one shared memory note by its slug, including its full body and the slugs of every other note that links to it (backlinks).",
      inputSchema: { slug: z.string().min(1).describe("The note's slug, as returned by memory_list or memory_search.") },
    },
    ({ slug }) => handleMemoryRead(root, slug)
  );

  server.registerTool(
    "memory_write",
    {
      title: "Create or update a memory note",
      description:
        "Create a new memory note (omit slug, give a title) or update an existing one (give its slug). Use [[other-slug]] in the body to link another note — including one that doesn't exist yet, which is a valid way to mark a note worth writing later.",
      inputSchema: {
        slug: z
          .string()
          .optional()
          .describe("Omit to create a new note. Provide an existing note's slug to update it — the slug itself never changes."),
        title: z.string().min(1).optional().describe("Required when creating a new note (slug omitted)."),
        body: z.string().optional().describe("Markdown body. May contain [[other-slug]] links."),
        tags: z.array(z.string()).optional(),
      },
    },
    (args) => handleMemoryWrite(root, args)
  );

  server.registerTool(
    "memory_search",
    {
      title: "Search memory notes",
      description:
        "Search shared memory notes by a plain-text query, matched case-insensitively against title, tags, and body. Returns matching notes' slug/title/tags, not the full body — follow up with memory_read for the ones that look relevant.",
      inputSchema: { query: z.string().min(1) },
    },
    ({ query }) => handleMemorySearch(root, query)
  );

  return server;
}
