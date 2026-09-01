/**
 * The MCP (Model Context Protocol) surface for Phase 8's shared memory —
 * the actual point of this phase: Claude Code, cursor-agent, and Codex can
 * all connect to the SAME `McpServer` instance (one per workspace, pointed
 * at that workspace's `.vibespace/memory/` directory) and read/write the
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
 * Original Phase 8 tools: `memory_list`, `memory_read`, `memory_write`,
 * `memory_search`. A later pass (closing the gap against BridgeMemory's
 * ~12-tool MCP surface — see docs/PARITY.md) added the rest of what
 * `./store.ts` and `./links.ts` can already do but wasn't reachable over
 * MCP yet: `memory_delete`, `memory_list_by_tag`, `memory_list_tags`,
 * `find_backlinks`, `find_links`, `memory_graph`, and `suggest_connections`
 * — the last one a plain lexical heuristic (see `links.ts`'s
 * `suggestConnections` doc comment), NOT semantic search or anything
 * AI-powered; every response it returns says so explicitly, not just this
 * comment. Every tool returns plain JSON-in-text content — the simplest,
 * most broadly-compatible MCP tool result shape, and easy for a model to
 * parse without needing `outputSchema`/structured-content support from
 * every client.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as memoryStore from "./store.js";
import { buildGraph, extractLinks, suggestConnections } from "./links.js";

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

/** Deletes a note by slug. Distinct from `handleMemoryWrite` (which only
 * creates/updates) so an agent can't accidentally trigger a delete via a
 * typo'd write call — this is its own explicit, separately-named tool, same
 * as the REST API's own `DELETE /api/memory/notes/:slug`. */
export async function handleMemoryDelete(root: string, slug: string): Promise<CallToolResult> {
  const removed = memoryStore.remove(root, slug);
  if (!removed) {
    return errorResult(`No memory note with slug "${slug}" to delete.`);
  }
  return jsonResult({ deleted: slug });
}

/** Notes tagged EXACTLY `tag` (case-insensitive) — a precise filter, unlike
 * `memory_search`'s substring match across title/body/tags all at once.
 * Useful when an agent already knows the tag it's after (e.g. from
 * `memory_list_tags` below) and wants just that slice. */
export async function handleMemoryListByTag(root: string, tag: string): Promise<CallToolResult> {
  const q = tag.toLowerCase();
  const matches = memoryStore
    .list(root)
    .filter((n) => n.tags.some((t) => t.toLowerCase() === q))
    .map((n) => ({ slug: n.slug, title: n.title, tags: n.tags, updatedAt: n.updatedAt }));
  return jsonResult({ tag, notes: matches });
}

/** Every distinct tag in use across the workspace, with how many notes
 * carry it — the discovery step before `memory_list_by_tag`: an agent
 * rarely knows the exact tag vocabulary a workspace has settled on ahead of
 * time. Sorted by count (most-used first), ties broken alphabetically. */
export async function handleMemoryListTags(root: string): Promise<CallToolResult> {
  const counts = new Map<string, number>();
  for (const note of memoryStore.list(root)) {
    for (const tag of note.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  const tags = [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  return jsonResult({ tags });
}

/** Which notes link TO `slug` — the same backlinks `handleMemoryRead`
 * already returns bundled with a note's full body, pulled out as its own
 * tool for when an agent wants just the relationship graph without paying
 * for (or polluting context with) the body text. Works even for a
 * `slug` with no note yet — a dangling target can still have real notes
 * pointing at it (see `links.ts`'s `buildGraph` doc comment); this
 * deliberately does NOT error in that case, since "nothing links here yet"
 * and "this note doesn't exist" are both honestly answered by an empty
 * array either way. */
export async function handleFindBacklinks(root: string, slug: string): Promise<CallToolResult> {
  const { backlinks } = buildGraph(memoryStore.list(root));
  return jsonResult({ slug, backlinks: backlinks[slug] ?? [] });
}

/** The OUTGOING links from one note — `[[target]]`s in ITS body, the
 * complement to `find_backlinks` (which finds who links IN). Each target is
 * annotated `dangling: true` if no note exists for it yet, same flag
 * `memory_graph`'s edges carry. Unlike `find_backlinks`, this DOES need a
 * real note to read the body from, so an unknown slug is an error. */
export async function handleFindLinks(root: string, slug: string): Promise<CallToolResult> {
  const note = memoryStore.get(root, slug);
  if (!note) {
    return errorResult(`No memory note with slug "${slug}". Use memory_list or memory_search to find one.`);
  }
  const notes = memoryStore.list(root);
  const bySlug = new Map(notes.map((n) => [n.slug, n]));
  const links = extractLinks(note.body).map((target) => ({
    slug: target,
    title: bySlug.get(target)?.title ?? target,
    dangling: !bySlug.has(target),
  }));
  return jsonResult({ slug, links });
}

/** The whole workspace's link graph — every note as a node (plus one node
 * per dangling link target), every `[[link]]` as an edge — the same shape
 * `GET /api/memory/graph` returns and the web app's Graph view renders.
 * The "walk the whole graph at once" tool, as opposed to `find_backlinks`/
 * `find_links`'s "one note's relationships" scope. */
export async function handleMemoryGraph(root: string): Promise<CallToolResult> {
  const { nodes, edges } = buildGraph(memoryStore.list(root));
  return jsonResult({ nodes, edges });
}

/** A short, honest disclaimer bundled into EVERY `suggest_connections`
 * response — not just this file's comments or docs/MEMORY.md — so a model
 * calling this tool sees the caveat at the exact moment it matters, not
 * only if it happened to read the docs first. See `links.ts`'s
 * `suggestConnections` doc comment for the full "what this catches / what
 * it misses" breakdown this summarizes. */
const SUGGEST_CONNECTIONS_DISCLAIMER =
  "Heuristic only: plain shared-keyword overlap and literal title-in-body text matching. " +
  "NOT semantic search, embeddings, or AI — synonyms, paraphrases, and reworded references are " +
  "not detected, and topically-unrelated notes that happen to share generic words may be flagged. " +
  "Treat every suggestion as a prompt to go look, not a confirmed relationship.";

export interface SuggestConnectionsArgs {
  /** Restrict results to suggestions involving this one note. Omit to see
   * every unlinked-but-plausible pair across the whole workspace. */
  slug?: string;
}

export async function handleSuggestConnections(
  root: string,
  args: SuggestConnectionsArgs
): Promise<CallToolResult> {
  const notes = memoryStore.list(root);
  if (args.slug && !notes.some((n) => n.slug === args.slug)) {
    return errorResult(`No memory note with slug "${args.slug}".`);
  }

  const all = suggestConnections(notes);
  const suggestions = args.slug
    ? all
        .filter((s) => s.a === args.slug || s.b === args.slug)
        .map((s) => ({
          suggestedLink: s.a === args.slug ? s.b : s.a,
          reasons: s.reasons,
        }))
    : all;

  return jsonResult({ heuristic: SUGGEST_CONNECTIONS_DISCLAIMER, suggestions });
}

/**
 * Builds an `McpServer` exposing `root`'s memory notes — every tool here is
 * scoped to this one workspace root, matching how `mcp-server.ts` invokes
 * this (one process, one workspace, given as a CLI argument), so no tool
 * takes a `workspaceId`/`root` argument itself the way the REST routes do.
 */
export function createMemoryMcpServer(root: string): McpServer {
  const server = new McpServer({ name: "vibespace-memory", version: "1.0.0" });

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

  server.registerTool(
    "memory_delete",
    {
      title: "Delete a memory note",
      description: "Permanently delete a memory note by slug. There is no undo — check memory_read first if unsure.",
      inputSchema: { slug: z.string().min(1).describe("The note's slug, as returned by memory_list or memory_search.") },
    },
    ({ slug }) => handleMemoryDelete(root, slug)
  );

  server.registerTool(
    "memory_list_by_tag",
    {
      title: "List memory notes by tag",
      description:
        "List every note carrying EXACTLY this tag (case-insensitive exact match, not a substring search — use memory_search for that). Use memory_list_tags first if you don't already know the tag vocabulary this workspace uses.",
      inputSchema: { tag: z.string().min(1) },
    },
    ({ tag }) => handleMemoryListByTag(root, tag)
  );

  server.registerTool(
    "memory_list_tags",
    {
      title: "List every tag in use",
      description: "List every distinct tag used across this workspace's memory notes, with how many notes carry each, most-used first.",
      inputSchema: {},
    },
    () => handleMemoryListTags(root)
  );

  server.registerTool(
    "find_backlinks",
    {
      title: "Find backlinks to a note",
      description:
        "List every note's slug that links (via [[wikilink]]) to the given slug. Works even for a slug with no note yet — a dangling link target can still have real notes pointing at it.",
      inputSchema: { slug: z.string().min(1).describe("The target slug to find incoming links to.") },
    },
    ({ slug }) => handleFindBacklinks(root, slug)
  );

  server.registerTool(
    "find_links",
    {
      title: "Find a note's outgoing links",
      description:
        "List every [[wikilink]] target inside one note's body (the complement to find_backlinks, which finds incoming links instead). Each target is flagged dangling if no note exists for it yet.",
      inputSchema: { slug: z.string().min(1).describe("The note's slug, as returned by memory_list or memory_search.") },
    },
    ({ slug }) => handleFindLinks(root, slug)
  );

  server.registerTool(
    "memory_graph",
    {
      title: "Get the whole memory link graph",
      description:
        "Return this workspace's whole memory graph at once: every note (plus every dangling link target) as a node, every [[wikilink]] as an edge. The same data the web app's Graph view renders.",
      inputSchema: {},
    },
    () => handleMemoryGraph(root)
  );

  server.registerTool(
    "suggest_connections",
    {
      title: "Suggest links between notes (heuristic, not AI)",
      description:
        "Propose notes that probably should link to each other but don't yet, using a plain lexical heuristic — shared significant keywords, and a note's exact title appearing as plain text in another note's body. " +
        "This is NOT semantic search or AI-powered: synonyms, paraphrases, and reworded references are not detected, and unrelated notes that happen to share generic words may still be suggested. " +
        "Every response repeats this caveat. Omit slug to see every unlinked-but-plausible pair in the workspace; pass slug to scope results to just that note.",
      inputSchema: {
        slug: z
          .string()
          .optional()
          .describe("Restrict results to suggestions involving this note's slug. Omit for the whole workspace."),
      },
    },
    (args) => handleSuggestConnections(root, args)
  );

  return server;
}
