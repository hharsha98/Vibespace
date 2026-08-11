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
