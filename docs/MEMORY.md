# Shared agent memory (Phase 8)

Memory is **plain markdown files on disk**, one per note, at
`<workspace-root>/.vibedeck/memory/<slug>.md`. It is deliberately not a
database: notes live next to the code they're about, are readable in any
editor or with a plain `cat`, and can be committed to git along with the
rest of the project (or `.gitignore`d, if you'd rather keep them local —
that's your call, vibedeck doesn't force either way).

The point of this phase: every coding agent working in a vibedeck workspace
— Claude Code, cursor-agent, Codex, or a human reading the Memory tab —
reads and writes the **same** notes. What one agent learns, the next one
starts with.

## The file format

```markdown
---
title: Why the parser is recursive
tags: [parser, design]
created: 2026-01-01T00:00:00.000Z
updated: 2026-01-01T00:00:00.000Z
---
Body text with [[other-note]] links.
```

- The frontmatter block is a small hand-rolled parser (`apps/server/src/memory/frontmatter.ts`), not a full YAML parser — it only ever needs to round-trip these four fields.
- A file with no frontmatter block, or a malformed one, still loads: the whole file becomes the body, and the title falls back to the filename. Nothing throws.
- `tags` is a bracketed, comma-separated list — `[]` for none.

## The wikilink convention

Write `[[other-note-slug]]` anywhere in a note's body to link to another
note **by its slug**, not its title. A slug is derived from a note's title
the first time it's created (lowercased, non-alphanumerics collapsed to
`-`) and never changes afterward, even if the title is edited later — this
is what keeps links stable.

- A link to a slug that doesn't exist yet is a **dangling link** — not an
  error. It's a deliberate way to mark "this is a note worth writing." The
  Memory tab and the Graph view both render dangling links/nodes
  differently (faint, dashed) and offer a one-click "create this note"
  affordance.
- Links inside fenced code blocks (` ``` `) or inline code spans (`` ` ``)
  are ignored — so a note that documents the `[[wikilink]]` syntax itself
  doesn't accidentally create a link.
- **Backlinks** are computed on the fly from every note's body, not stored
  anywhere — `GET /api/memory/notes/:slug` and the `memory_read` MCP tool
  both return them.

## Where to look in the app

- **Memory tab** (right dock, beside Info and Blocks): a searchable note
  list (title, tag pills, backlink count), a reader with clickable
  `[[links]]`, a backlinks section, and inline create/edit.
- **Graph view** (centre column, `Cmd+Shift+G` / `Ctrl+Shift+G`): every
  note as a node, every link as a curved connector, on a dotted-grid canvas
  (`d3-force` physics). Click a node to open it in the Memory tab. Drag to
  pan, scroll to zoom, the zoom cluster is bottom-left. Usable up to
  roughly 200 notes — see the honesty note in `apps/web/src/memory/Graph.tsx`'s
  top comment about where it starts to degrade beyond that.

## REST API

See `docs/AGENT-API.md` for the full reference (request/response bodies,
error codes). Summary:

| Method | Path | What |
|---|---|---|
| `GET` | `/api/memory/notes?workspaceId=` | List every note |
| `GET` | `/api/memory/notes/:slug?workspaceId=` | One note + its backlinks |
| `POST` | `/api/memory/notes` | Create a note |
| `PATCH` | `/api/memory/notes/:slug` | Update a note |
| `DELETE` | `/api/memory/notes/:slug?workspaceId=` | Delete a note |
| `GET` | `/api/memory/graph?workspaceId=` | The whole link graph |

## The MCP server

This is the part that makes memory genuinely *shared* across different
agent CLIs, not just something the vibedeck web UI happens to show. One
process, one workspace, talking [MCP](https://modelcontextprotocol.io) over
stdio.

As of Phase 9.5b, this is no longer a memory-only server: the SAME process
also exposes the board, agent profiles, and the prompts library as MCP
tools, plus a `vibedeck_developer_guide` MCP *prompt* that onboards a
connected agent into the whole workflow. See `apps/server/src/mcp/build-server.ts`'s
top comment for why board/agents/prompts share this one process rather
than a second server, and [docs/AGENT-API.md](./AGENT-API.md#board-agents-and-prompts-over-mcp-phase-95b)
for the full board/agents/prompts reference. This section covers the
memory tools (eleven of them, as of the pass that closed the gap against
BridgeMemory's own ~12-tool MCP surface — see [docs/PARITY.md](./PARITY.md)
rows 28-30 for the shared-memory parity items this builds on) and how to
connect; the setup below is identical either way — one server
process gives you all of it.

| Tool | What |
|---|---|
| `memory_list` | List every note (slug, title, tags, `updatedAt` — not the full body) |
| `memory_read` | Read one note by slug: full body + backlinks |
| `memory_write` | Create a note (omit `slug`, give a `title`) or update one (give `slug`) |
| `memory_search` | Case-insensitive substring search over title, body, and tags |
| `memory_delete` | Permanently delete a note by slug — no undo |
| `memory_list_by_tag` | Notes carrying an EXACT tag (case-insensitive, not a substring search) |
| `memory_list_tags` | Every distinct tag in use, with a count, most-used first |
| `find_backlinks` | Which notes link IN to a given slug (works even for a dangling slug) |
| `find_links` | The `[[wikilink]]` targets a given note links OUT to, flagged dangling or not |
| `memory_graph` | The whole workspace's link graph at once — every note/dangling-target node, every edge |
| `suggest_connections` | Proposes unlinked notes that probably should link — see below, **not semantic/AI** |

A **tool** is something an agent calls; a **prompt** is boilerplate text an
MCP client can insert into the conversation on request (e.g. Claude Code's
`/mcp` prompt picker) — `vibedeck_developer_guide` is the latter, not
something you `callTool` on. See `apps/server/src/mcp/developer-guide.ts`
for its exact text.

### `suggest_connections`: exactly what the heuristic does and doesn't catch

This tool does **not** use embeddings, semantic search, or an LLM call of
any kind — every response it returns says so explicitly, not just this
doc. It's two plain lexical checks, run over every pair of notes that
isn't already linked (in either direction):

1. **Shared significant terms** — both notes' title + body, lowercased and
   split on non-alphanumeric characters, with short words (under 4
   characters) and a small fixed stopword list removed, share at least 3
   tokens in common.
2. **Title mention** — one note's body contains the OTHER note's exact
   title as plain text (case-insensitive, whole-word/phrase boundaries),
   but doesn't already `[[link]]` to it. Text inside fenced code blocks or
   inline code spans is ignored, same as real `[[wikilinks]]`.

**What it will catch:** a note whose title got typed out in another note's
prose and never turned into a link, and pairs of notes that both use the
same handful of distinctive words.

**What it will miss, on purpose:** paraphrases and synonyms ("auth" vs
"authentication" won't match), a title referenced by abbreviation or
reworded text, and any conceptual relationship with no shared vocabulary
at all. It can also produce false positives — two unrelated notes that
happen to both use generic-but-not-stopword words will still surface.
Every suggestion is a prompt to go look, not a confirmed relationship.
See `apps/server/src/memory/links.ts`'s `suggestConnections` function for
the exact implementation and `links.test.ts` for a fixture with hand-
verified expected output.

### Running it

After `pnpm build` at the repo root:

```bash
node /absolute/path/to/vibedeck/apps/server/dist/memory/mcp-server.js /absolute/path/to/your/workspace
```

For local development without building first:

```bash
cd /absolute/path/to/vibedeck/apps/server
pnpm memory-mcp /absolute/path/to/your/workspace
```

The single required argument is the **workspace root** — the same
directory a vibedeck `Workspace.rootPath` points at, i.e. the project
directory whose `.vibedeck/memory/` you want this server to read and write.
One MCP server process per workspace; if you work in multiple vibedeck
workspaces, configure one entry per workspace root.

### Connecting Claude Code

Project-scoped (drop this in the project's `.mcp.json`, or run
`claude mcp add`):

```json
{
  "mcpServers": {
    "vibedeck-memory": {
      "command": "node",
      "args": [
        "/absolute/path/to/vibedeck/apps/server/dist/memory/mcp-server.js",
        "/absolute/path/to/your/workspace"
      ]
    }
  }
}
```

Or via the CLI, from inside your workspace:

```bash
claude mcp add vibedeck-memory -- node /absolute/path/to/vibedeck/apps/server/dist/memory/mcp-server.js /absolute/path/to/your/workspace
```

### Connecting Cursor

Add to `.cursor/mcp.json` (project-scoped) or `~/.cursor/mcp.json`
(global):

```json
{
  "mcpServers": {
    "vibedeck-memory": {
      "command": "node",
      "args": [
        "/absolute/path/to/vibedeck/apps/server/dist/memory/mcp-server.js",
        "/absolute/path/to/your/workspace"
      ]
    }
  }
}
```

### Connecting Codex

Codex reads MCP servers from `~/.codex/config.toml`:

```toml
[mcp_servers.vibedeck-memory]
command = "node"
args = [
  "/absolute/path/to/vibedeck/apps/server/dist/memory/mcp-server.js",
  "/absolute/path/to/your/workspace",
]
```

### Does it actually work?

Yes — verified by spawning the real `mcp-server.ts` entry as a subprocess
(via `tsx`, exactly how an agent CLI launches it) and driving it with a
real `@modelcontextprotocol/sdk` `Client` over stdio: `initialize`,
`tools/list`, then `memory_write` (create), `memory_list`, `memory_read`,
`memory_search`, `memory_write` (update), and a `memory_read` for a missing
slug (confirmed `isError: true`). Every call round-tripped correctly, and
the created note was confirmed on disk as a real `.md` file afterward. See
`apps/server/src/memory/mcp.test.ts` for the equivalent coverage that runs
in CI (that file calls the tool handlers directly rather than spawning a
subprocess, which is what actually runs in CI — the subprocess smoke test
above was a one-off manual verification, not a CI test, since spawning a
`tsx` child process in CI would be slower and flakier than calling the
handler functions directly for the same coverage).

The Phase 9.5b board/agents/prompts tools use a real MCP `Client` too, just
without the subprocess: `apps/server/src/mcp/build-server.test.ts` connects
a `Client` to the actual composed server over the SDK's `InMemoryTransport`
(two linked in-process transports, one for each end — no stdio, no child
process) and drives it through `tools/list`, `create_task` -> `list_tasks`
-> `get_task`, `create_agent` -> `list_agents`, `list_prompts`, and
`prompts/get` for `vibedeck_developer_guide`. This runs in CI (unlike the
memory subprocess smoke test above) since there's no subprocess involved
to make it slow or flaky.

## Path safety

Every slug — from a URL param, an MCP tool argument, wherever — is resolved
through `apps/server/src/files/safe-path.ts`'s `safeResolve` against the
workspace's `.vibedeck/memory/` directory specifically (not just the
workspace root), so a crafted slug like `"../../../etc/passwd"` can't
escape it. See `apps/server/src/memory/store.test.ts`'s "path traversal via
a crafted slug" tests.
