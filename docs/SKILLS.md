# Skills (Phase 10, PARITY #37)

A **skill** is a reusable instruction pack — a directory containing a
`SKILL.md` file that tells an agent how to do something specific well
("how to audit a feature against our parity checklist", "how to write a
migration for this project's ORM", etc). vibedeck implements the **open
[agentskills.io](https://agentskills.io) standard** rather than a private
format — see `docs/RESEARCH.md` §4 for why: it's the one place in this
project's whole feature set where an interoperable public format already
exists, so a skill written for another agentskills.io-compatible client
works here unmodified, and a skill you write for vibedeck works elsewhere
too.

This document covers the **server half** only: discovery, parsing, the
REST/MCP surface, and injecting a skill into a running pane. The web UI
(browsing skills, dragging one onto a pane) is a separate follow-up — see
`docs/PARITY.md` #37's status note.

## The file format

```
my-skill/
  SKILL.md          # required
  scripts/          # optional — conventional, not enforced
  references/       # optional
  assets/           # optional
```

`SKILL.md` is YAML frontmatter between `---` delimiters, then a Markdown
body:

```markdown
---
name: my-skill
description: What this skill is for and when to use it.
license: MIT
compatibility: Requires bash and python3.
allowed-tools: bash python
metadata:
  author: someone
  category: docs
---
# My Skill

Step-by-step instructions for the agent to follow.
```

| Field | Required | Constraints |
|---|---|---|
| `name` | Yes | 1–64 chars, lowercase `a-z0-9-`, no leading/trailing/double hyphens. Should match the parent directory name. |
| `description` | Yes | 1–1024 chars, non-empty — this is what makes progressive disclosure work (see below). |
| `license` | No | Free text. |
| `compatibility` | No | 1–500 chars. |
| `metadata` | No | A nested map of string keys to string values. |
| `allowed-tools` | No | A space-separated string of tool names. Experimental, per the spec. |

### Progressive disclosure

The whole point of the `name`/`description` split: an agent (or the future
web UI) can see every available skill's name and description cheaply — the
**catalog** — and only pull in a specific skill's full body once it looks
relevant. `GET /api/skills` and the `list_skills` MCP tool return the
catalog only; `GET /api/skills/:name` and `get_skill` return everything,
including the body.

### The parser is hand-rolled, not a real YAML parser

`apps/server/src/skills/parse.ts` follows the same philosophy as
`apps/server/src/memory/frontmatter.ts`: this repo doesn't take a `js-yaml`
dependency for a frontmatter shape this small (flat scalars plus one
nested string→string map). It's lenient by design, because a `SKILL.md` you
load was very possibly authored for a different agentskills.io client:

- **Skips the skill** (records an `error` diagnostic, nothing loads) when:
  - the frontmatter block is missing or unparseable
  - `description` is missing or empty — it's the one field disclosure
    depends on, so there's nothing useful to show without it
- **Loads the skill anyway** (records a `warning` diagnostic) when:
  - `name` doesn't match its parent directory
  - `name` is missing (falls back to the directory name), too long, or
    uses characters outside `a-z0-9-`
  - `description`/`compatibility` exceed the spec's length ceilings

The single most common real-world breakage — an unquoted value containing
its own colon, e.g. `description: Use this skill when: the user asks about
PDFs` — is handled by splitting each frontmatter line at its **first**
colon, not attempting real YAML scalar parsing. See `parse.test.ts` for the
exact case.

Every parse result carries its diagnostics forward to the REST/MCP
response, tagged with the `SKILL.md` path they came from, so a human (or an
agent) can see exactly what's odd about a given skill rather than it just
silently failing to appear.

## Where skills are discovered

`apps/server/src/skills/discover.ts` scans six directories, in this
**precedence order** — a later scope wins on a name collision:

| # | Scope | Path |
|---|---|---|
| 1 | User | `~/.agents/skills/` (cross-client convention) |
| 2 | User | `~/.vibedeck/skills/` (vibedeck's own) |
| 3 | User | `~/.claude/skills/` (pragmatic compatibility — many existing skills already live here) |
| 4 | Project | `<workspace root>/.agents/skills/` |
| 5 | Project | `<workspace root>/.vibedeck/skills/` |
| 6 | Project | `<workspace root>/.claude/skills/` |

Project scopes are listed last so "project overrides user" — the universal
convention every dotfile-style tool follows — falls out of plain list
order. A collision is never silent: the shadowed skill's directory is named
in a `warning` diagnostic.

A skill is a **subdirectory** containing a file named exactly `SKILL.md`.
A loose `README.md`, or any file sitting directly in a scope root, is not a
skill. Missing scope directories are normal (most workspaces won't have all
six) and never produce a diagnostic. Scanning is bounded: only one level
below a scope root is ever examined (a skill directory itself, not
anything inside its `scripts/`/`references/`/`assets/` subdirectories), and
the total number of directory entries examined across all six scopes is
capped at 2000 — if that cap is hit, a diagnostic says so rather than
silently returning a partial list.

### The trust boundary: project skills are untrusted input

The three **project** scopes live inside the repository being worked on. A
freshly `git clone`d repo is, by definition, content nobody has reviewed
yet — and a `SKILL.md` is prose an agent is meant to read and act on. A
malicious repo could ship a skill whose description or body tries to steer
a connected agent into doing something the user never asked for. This is
the same class of risk as any other prompt injection, just delivered as a
"skill" instead of a code comment, and vibedeck does **not** solve it —
nothing short of not reading the file would.

What this phase *does* do:

1. Every discovered skill carries its `scope` (`"user"` vs `"project"`,
   plus which of the three directories) all the way through to the
   REST/MCP response, so it's always possible to tell "this came from the
   repo I just cloned" from "this is one of my own skills".
2. A symlinked skill directory that resolves **outside** its scope root
   (e.g. a repo shipping `.agents/skills/leak -> /etc`, trying to read
   arbitrary host files as if they were skill content) is refused, via the
   same `safeResolve` path-containment check `apps/server/src/files/safe-path.ts`
   uses everywhere else in this codebase. A symlink that stays inside its
   own scope root is followed; one that escapes is not — see
   `discover.ts`'s top comment for the reasoning.

Neither of these makes a project skill's *instructions* trustworthy. That
judgement call belongs to a human, and the UI (when it lands) must make
`scope` visible enough to support making it.

## REST API

| Method | Path | What |
|---|---|---|
| `GET` | `/api/skills?workspaceId=` | The catalog: name, description, scope, source directory, diagnostics — never the full body |
| `GET` | `/api/skills/:name?workspaceId=` | One skill in full: frontmatter + complete body |
| `POST` | `/api/skills/:name/inject` | Type a skill into a running pane — body `{ sessionId }` |

## MCP

The same composed MCP server memory/board/agents/prompts already use
(`apps/server/src/mcp/build-server.ts`) also exposes:

| Tool | What |
|---|---|
| `list_skills` | The catalog (name/description/scope/dir, not the body) |
| `get_skill` | One skill's full body by name |

Unlike the board/agent/prompt tools, neither needs a `workspace_id` lookup
against SQLite — skills, like memory notes, are addressed by a filesystem
root alone.

## Injecting a skill into a running pane

This is PARITY #37's actual point: drag (or, today, `POST`) a skill onto a
pane that's already running an agent, and have its instructions actually
land there. `apps/server/src/skills/inject.ts` reuses the exact solution
`apps/server/src/board/dispatch.ts` already built for board cards, rather
than re-deriving it:

- **Newline folding.** A bare newline inside a TUI agent's pty is
  "submit" — writing a multi-line skill body raw would submit itself in
  ragged fragments instead of landing as one message. Every character
  actually written is folded through `dispatch.ts`'s own `toSingleLine`
  (imported, not re-implemented) and ends in **exactly one** trailing
  newline — the deliberate submit.
- **Shell panes are refused.** A `shell` pane is not an agent; it cannot
  act on an English instruction, it would just try to *execute* it as a
  command. Unlike a board card (whose body a human wrote *as* the command
  when targeting shell), a skill body has no sensible "command" reading at
  all, so `POST /api/skills/:name/inject` against a shell-agent session
  returns `400` with a clear explanation rather than guessing.
- **Body size is capped, not rejected outright.** `SKILL_INJECT_MAX_LENGTH`
  (20,000 characters) bounds how much of a skill's description + body is
  actually typed into a pty — `SKILL.md` bodies are meant to be concise
  per the spec (bulk material belongs in `references/`, which injection
  never reads at all). A body over the cap is **truncated** with a
  trailing marker, not refused — a partial skill is still useful context.
  The response's `truncated` field tells the caller which happened.
- **"Injected" means typed, not accepted.** Writing to a pty is exactly the
  user typing at the keyboard, so a `200` here says the keystrokes reached
  the pane — it does not say the agent took them in. An agent that is still
  booting, busy mid-task, or showing a modal of its own will discard them,
  and a pty offers no signal back that would let us notice. This is not
  hypothetical: it was found by injecting into a freshly spawned
  `cursor-agent`, which was sitting on its own "Workspace Trust Required"
  prompt and silently swallowed the text. The UI therefore says "Typed into
  the pane — check it acted on it" rather than a confident "Sent."

## An example skill

`.agents/skills/vibedeck-parity-audit/SKILL.md`, shipped in this repo, is a
real, working skill — not a placeholder — that walks an agent through
checking one of vibedeck's own features against `docs/PARITY.md`. It's a
useful worked example of everything above: valid frontmatter, a project
scope, and a body worth actually reading.
