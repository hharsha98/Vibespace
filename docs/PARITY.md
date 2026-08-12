# Feature parity audit

The target: everything BridgeSpace does, vibedeck should do. This file is the
checklist that decides when that is true, so "are we there yet" is an
auditable question rather than an opinion.

Sources, read 2026-08-12: `docs.bridgemind.ai/docs/bridgespace` (their own
documentation) and the BridgeSpace / BridgeSwarm product pages.

Scope note: this tracks **BridgeSpace**, the workroom. Their separate
products — an autonomous server-resident agent, a voice dictation tool, a
screenshot utility — are not in scope; they are different applications that
happen to share a vendor.

Two deliberate differences, neither a gap:

- **No account or sign-in.** BridgeSpace requires an account and gates
  features behind a paid tier. vibedeck is local-first and unlicensed;
  everything is available to everyone.
- **Our own themes and mark.** We ship an equivalent *number* of themes drawn
  from long-established community palettes, not their proprietary named set,
  and vibedeck uses its own logo. Matching a design language is fair;
  copying a brand is not.

Legend: ✅ done · 🟡 partial · ⛔ not started · 🚫 not possible as specified

---

## Terminals

| # | Capability | Status | Notes |
|---|---|---|---|
| 1 | 1–16 panes in one workspace | ✅ | Phase 2 |
| 2 | Split any pane horizontally / vertically | ✅ | Phase 2 |
| 3 | Resize panes by dragging | ✅ | Phase 2 |
| 4 | GPU-accelerated rendering | ✅ | Phase 1; capped at 8 WebGL contexts, rest fall back |
| 5 | Command block: command text, output, exit code, timestamp | ✅ | Phase 5, via OSC 133 |
| 6 | Command blocks **collapsible** | 🚫 | xterm.js cannot hide buffer lines. We ship gutter markers, a block list, exit codes, durations and jump-to-block instead. Faking a collapse would be worse than not having one. |
| 7 | Search terminal output (⌘F) | ✅ | Phase 1 |
| 8 | Context menu: copy / paste / clear | ✅ | Phase 1 |
| 9 | Context menu: **split** entry | ⛔ | Split exists on the pane header, not in the right-click menu |
| 10 | Drag a file in to paste its path | ✅ | Phase 1 |
| 11 | **Inline image preview** (terminal image protocols) | ⛔ | Needs the xterm image addon wired up |
| 12 | **Scroll-to-bottom floating indicator** | ⛔ | |
| 13 | Sessions survive closing the window | ✅ | Better than parity — server-owned sessions |

## Editor and files

| # | Capability | Status | Notes |
|---|---|---|---|
| 14 | Syntax highlighting, many languages | ✅ | Phase 6, CodeMirror 6 |
| 15 | Language detection by extension | ✅ | Phase 6 |
| 16 | File watching — external edits reflected | ✅ | Phase 6; also protects unsaved edits with a conflict bar |
| 17 | Quick Open (⌘P) | ✅ | Phase 6 |
| 18 | Open files in tabs | ✅ | Phase 6 |
| 19 | File tree with expand/collapse and icons | ✅ | Phase 6 |
| 20 | **Drag and drop in the file sidebar** | ⛔ | Move/reorder files by dragging |
| 21 | Embedded browser for localhost | ✅ | Phase 6 |

## Agent workflows

| # | Capability | Status | Notes |
|---|---|---|---|
| 22 | Kanban: Todo / In Progress / In Review / Complete | ✅ | Phase 7 |
| 23 | Dispatch a task to an agent from the board | ✅ | Phase 7 |
| 24 | Wait for the shell prompt before sending | ✅ | Phase 7, settle delay after first output |
| 25 | Agents read and move their own cards | ✅ | Phase 7, `docs/AGENT-API.md` |
| 26 | **Agents page — per-agent custom system prompts** | ⛔ | |
| 27 | **Prompts library — save and reuse prompts** | ⛔ | |
| 28 | Shared agent memory | ✅ | Phase 8 |
| 29 | Memory shared with every agent over MCP | ✅ | Phase 8 |
| 30 | Memory as a linked graph with backlinks | ✅ | Phase 8 |
| 31 | **Swarm: roles (coordinator/builder/scout/reviewer)** | ⛔ | Phase 9 |
| 32 | **Swarm: shared mailbox between agents** | ⛔ | Phase 9 |
| 33 | **Swarm: file ownership, no two agents on one file** | ⛔ | Phase 9 |
| 34 | **Swarm: quality gates** | ⛔ | Phase 9 |
| 35 | **Swarm: live mission tree canvas** | ⛔ | Phase 9 |
| 36 | **Swarm: @-target one agent, or all, from one bar** | ⛔ | Phase 9 |
| 37 | **Skills: drag a skill onto a running pane** | ⛔ | Phase 10 |

## Workspaces

| # | Capability | Status | Notes |
|---|---|---|---|
| 38 | Multiple workspaces, each with its own layout | ✅ | Phase 3 — a rail rather than tabs; same capability |
| 39 | Layout persists across restart | ✅ | Phase 3 |
| 40 | Panes open in the workspace's directory | ✅ | Phase 3 |
| 41 | **Colour-code a workspace** | ⛔ | |
| 42 | Templates: 1/2/4/6/8/10/12/14/16 | ✅ | Phase 2 |

## Shell

| # | Capability | Status | Notes |
|---|---|---|---|
| 43 | 25+ themes, dark-first | ✅ | 26, Phase 4 |
| 44 | Theme picker in the nav bar | ✅ | Phase 4 |
| 45 | **Settings screen** | ⛔ | Preferences are scattered across the top bar today |
| 46 | Keyboard-first operation | ✅ | Phase 4 |
| 47 | ⌘P quick open · ⌘F search · ⌘D split | ✅ | Exact parity |
| 48 | ⌘T new tab · ⌘W close tab · ⌘1–9 switch tab | 🟡 | Chrome reserves ⌘T/⌘W/⌘N — we use ⌘⇧ variants, and ⌘1–9 focuses panes. Full parity arrives with the desktop build (#50). |
| 49 | Command palette | ✅ | Better than parity — BridgeSpace has no palette |

## Packaging

| # | Capability | Status | Notes |
|---|---|---|---|
| 50 | Native desktop app (macOS / Windows / Linux) | ⛔ | Phase 11 |
| 51 | Auto-updates | ⛔ | Phase 11 |
| 52 | Installers: DMG / Windows / DEB, RPM, AppImage | ⛔ | Phase 11 |

---

## Remaining work, in order

**Phase 9 — Swarm** (#31–36). The largest piece. Split in two:
- *9a, server:* missions, roles, mailbox, file-ownership registry, quality
  gates, REST API, agent docs. The ownership registry must be arbitrated by a
  database uniqueness constraint, not a check-then-write, or two agents will
  eventually claim the same file.
- *9b, canvas:* the live mission tree — dotted canvas, role-coloured nodes and
  curved edges, zoom controls, and a single command bar that can address one
  agent or all of them.

**Phase 9.5 — Parity sweep.** The scattered gaps that don't belong to a big
feature: terminal image preview (#11), scroll-to-bottom indicator (#12),
split in the context menu (#9), file-tree drag and drop (#20), workspace
colours (#41), a Settings screen (#45), the Agents page (#26) and the Prompts
library (#27).

**Phase 10 — Skills** (#37).

**Phase 11 — Desktop** (#50–52). Also closes #48, because a desktop window
can claim ⌘T/⌘W/⌘N that a browser tab cannot.

## Where we will still differ when this is finished

- **#6, collapsible command blocks** — a real limitation of the terminal
  renderer, documented rather than faked.
- **No account, no paid tier** — deliberate.
- **Different theme names and our own logo** — deliberate.

Everything else on this list is reachable, and this file is the record of
whether we got there.
