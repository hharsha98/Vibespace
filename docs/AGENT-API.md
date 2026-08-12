# Agent API — moving your own board card

You are a coding agent running inside a vibedeck terminal pane, dispatched
to work on a specific board card. This page is the plain HTTP surface for
finding and updating that card — no MCP server, no SDK, just `curl`. (An
MCP server that wraps this same API is planned for a later phase; until
then, this is the whole interface.)

The server listens on `http://localhost:4317` by default.

## You already know your card id

When you were dispatched, the first thing typed into this terminal was a
short preamble naming your card's id and workspace, e.g.:

```
[vibedeck] You are working on board card 3f2a1c9e-... ("Fix the flaky test").
When you are done, move it to In Review by running:
curl -s -X PATCH http://localhost:4317/api/board/cards/3f2a1c9e-... -H "Content-Type: application/json" -d '{"columnId":"in_review"}'
```

That `curl` line is the one call you actually need. Everything below is for
when you want more context (e.g. reading your own card's current
description) or something more specific goes wrong.

## List every card in your workspace

Every board card belongs to a workspace. If you don't already know the
workspace id, ask whoever dispatched you, or check your card's
`workspaceId` field (see "Look up your own card" below).

```bash
curl -s "http://localhost:4317/api/board/cards?workspaceId=<WORKSPACE_ID>"
```

Response:

```json
{
  "cards": [
    {
      "id": "3f2a1c9e-...",
      "workspaceId": "<WORKSPACE_ID>",
      "title": "Fix the flaky test",
      "description": "It fails ~1 in 20 runs on CI.",
      "priority": "high",
      "columnId": "in_progress",
      "position": 1000,
      "sessionId": "b7e4...",
      "agent": "shell",
      "createdAt": "2026-08-11T12:00:00.000Z",
      "updatedAt": "2026-08-11T12:05:00.000Z"
    }
  ]
}
```

`columnId` is one of `todo`, `in_progress`, `in_review`, `complete` — the
board's four columns, always in that order.

## Look up your own card

```bash
curl -s "http://localhost:4317/api/board/cards?workspaceId=<WORKSPACE_ID>" \
  | grep -A2 '"id": *"<YOUR_CARD_ID>"'
```

(There's no `GET /api/board/cards/:id` single-card endpoint yet — list and
filter, as above.)

## Move your card to In Review when you're done

This is the one call every dispatched agent should run before finishing:

```bash
curl -s -X PATCH http://localhost:4317/api/board/cards/<YOUR_CARD_ID> \
  -H "Content-Type: application/json" \
  -d '{"columnId":"in_review"}'
```

Response is the updated card, e.g.:

```json
{ "id": "<YOUR_CARD_ID>", "columnId": "in_review", "updatedAt": "2026-08-11T12:10:00.000Z", "...": "..." }
```

## Other things you can PATCH

`PATCH /api/board/cards/:id` accepts any of these fields (all optional —
send only what you're changing):

| Field | Type | Notes |
|---|---|---|
| `title` | string | Must be non-empty. |
| `description` | string \| null | `null` clears it. |
| `priority` | `"critical" \| "high" \| "medium" \| "low"` | |
| `columnId` | `"todo" \| "in_progress" \| "in_review" \| "complete"` | |
| `position` | number | Fractional ordering within the column — leave this alone unless you're deliberately reordering; omitting `position` while changing `columnId` just appends your card to the end of the new column, which is what you want when moving to In Review. |

Example — update your card's description on the way to In Review:

```bash
curl -s -X PATCH http://localhost:4317/api/board/cards/<YOUR_CARD_ID> \
  -H "Content-Type: application/json" \
  -d '{"columnId":"in_review","description":"Fixed by pinning the flaky test'\''s clock; see the diff."}'
```

## Error responses

- `404` — the card id (or workspace id, for the `GET` list) doesn't exist.
- `400` — a field failed validation (e.g. an unrecognised `columnId` or
  `priority`, or an empty `title`). The body is `{ "error": "..." }`
  explaining what was wrong.

## What NOT to do

- Don't `DELETE` your own card unless you were explicitly asked to — that's
  a human (or the board UI's own delete button) decision, not something a
  dispatched agent should do on its own.
- Don't move your card straight to `complete` — `in_review` is the honest
  status for "I'm done working, a human hasn't confirmed it yet." Someone
  reviewing the board moves it to Complete once they've checked your work.

## Shared memory (Phase 8)

Every workspace also has a small shared knowledge base — plain markdown
notes at `.vibedeck/memory/*.md`, readable/writable by every agent working
in that workspace, not just the one that wrote them. Full details (the
wikilink convention, the MCP server, path-safety notes) are in
[docs/MEMORY.md](./MEMORY.md); this section is just the REST reference, in
the same "you already have `curl`" spirit as the board section above.

If you're running as an MCP-connected agent (Claude Code, cursor-agent,
Codex — see docs/MEMORY.md for the exact config), prefer the
`memory_list`/`memory_read`/`memory_write`/`memory_search` MCP tools over
these HTTP calls; they're the same underlying store, just without needing
to know your `workspaceId`. The REST API below is for anything without an
MCP connection, or for reading/writing memory from a script.

### List every note

```bash
curl -s "http://localhost:4317/api/memory/notes?workspaceId=<WORKSPACE_ID>"
```

```json
{
  "notes": [
    {
      "slug": "why-the-parser-is-recursive",
      "title": "Why the parser is recursive",
      "tags": ["parser", "design"],
      "body": "Body text with [[other-note]] links.",
      "createdAt": "2026-08-11T12:00:00.000Z",
      "updatedAt": "2026-08-11T12:00:00.000Z"
    }
  ]
}
```

### Read one note (with backlinks)

```bash
curl -s "http://localhost:4317/api/memory/notes/why-the-parser-is-recursive?workspaceId=<WORKSPACE_ID>"
```

Same shape as above, plus `"backlinks": ["some-other-slug", ...]` — every
other note's slug that links here via `[[why-the-parser-is-recursive]]`.

### Create a note

```bash
curl -s -X POST http://localhost:4317/api/memory/notes \
  -H "Content-Type: application/json" \
  -d '{"workspaceId":"<WORKSPACE_ID>","title":"What I learned about the retry logic","body":"See [[why-the-parser-is-recursive]] for context.","tags":["retries"]}'
```

Response is `201` with the created note (its `slug` is derived from
`title` — see docs/MEMORY.md — and guaranteed unique). Only `workspaceId`
and `title` are required; `body`/`tags` default to `""`/`[]`.

### Update a note

```bash
curl -s -X PATCH http://localhost:4317/api/memory/notes/what-i-learned-about-the-retry-logic \
  -H "Content-Type: application/json" \
  -d '{"workspaceId":"<WORKSPACE_ID>","body":"Updated body text."}'
```

Send only the fields you're changing (`title`/`body`/`tags`, plus the
required `workspaceId`). The slug itself never changes, even if `title`
does.

### Delete a note

```bash
curl -s -X DELETE "http://localhost:4317/api/memory/notes/what-i-learned-about-the-retry-logic?workspaceId=<WORKSPACE_ID>"
```

`204` on success. Same caution as deleting a board card: don't delete a
note another agent (or a human) might still need unless you were
explicitly asked to.

### The link graph

```bash
curl -s "http://localhost:4317/api/memory/graph?workspaceId=<WORKSPACE_ID>"
```

```json
{
  "nodes": [{ "slug": "why-the-parser-is-recursive", "title": "Why the parser is recursive", "dangling": false }],
  "edges": [{ "source": "what-i-learned-about-the-retry-logic", "target": "why-the-parser-is-recursive", "dangling": false }]
}
```

A `dangling: true` node/edge means something links to a slug with no note
written yet — a real, meaningful signal ("this is worth writing"), not an
error.

### Error responses

Same conventions as the board endpoints above: `400` for a missing/invalid
field (`workspaceId`, an empty `title`, non-string `tags`), `404` for an
unknown `workspaceId` or note `slug`. The body is `{ "error": "..." }`.
