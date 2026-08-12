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
stdio — exposing four tools:

| Tool | What |
|---|---|
| `memory_list` | List every note (slug, title, tags, `updatedAt` — not the full body) |
| `memory_read` | Read one note by slug: full body + backlinks |
| `memory_write` | Create a note (omit `slug`, give a `title`) or update one (give `slug`) |
| `memory_search` | Case-insensitive search over title, body, and tags |

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

## Path safety

Every slug — from a URL param, an MCP tool argument, wherever — is resolved
through `apps/server/src/files/safe-path.ts`'s `safeResolve` against the
workspace's `.vibedeck/memory/` directory specifically (not just the
workspace root), so a crafted slug like `"../../../etc/passwd"` can't
escape it. See `apps/server/src/memory/store.test.ts`'s "path traversal via
a crafted slug" tests.
