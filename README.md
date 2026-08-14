# vibedeck

**vibedeck** is an open-source *agentic development environment* — a home base
for running multiple AI coding agents (like Claude, Cursor, or Codex) at the
same time, side by side, instead of juggling them in separate terminal
windows.

Think of it as a mission control screen for AI coding agents:

- **A terminal grid** — multiple terminal sessions arranged on screen at
  once, each one running a different AI agent (or a plain shell), so you can
  watch several agents work in parallel.
- **A kanban board that dispatches agents** — drag a task into a column and
  it kicks off an agent to work on it, the same way you'd assign a ticket to
  a teammate.
- **Shared agent memory** — context and notes that every agent in the
  workspace can read from and write to, so agents don't have to
  re-discover the same facts about your codebase over and over.
- **Multi-agent orchestration** — coordinating several agents working
  together on related pieces of a bigger task.

"Agentic" just means the software takes actions on its own toward a goal
(here: AI coding agents editing code, running commands, etc.) rather than
just answering questions.

## Status: usable, and still being built

The core works today. You can open a workspace, split the screen into up to
16 panes, run Claude Code, cursor-agent, Codex or plain shells side by side,
browse and edit files, and dispatch work to an agent from a task board.
Closing the browser tab does not kill your agents — sessions live on the
server, so you can come back and pick up where you left off.

What is **not** here yet: multi-agent orchestration, drag-and-drop skills,
and a fully cross-platform, signed, auto-updating desktop installer (a
native macOS desktop window — the wrapper itself — does exist now, unsigned;
see [docs/DESKTOP.md](./docs/DESKTOP.md)). Those are the remaining slices of
Phases 9–11 below. This is a young project moving quickly; expect rough
edges.

## Roadmap

- [x] **Phase 0 — Foundation**: pnpm workspace, TypeScript config, CI,
      a Fastify server and a React web app that can talk to each other.
- [x] **Phase 1 — Terminal core**: run a real terminal session (a shell, or
      an AI agent's CLI) inside the browser — input and output streamed over
      a WebSocket, rendered on the GPU, with scrollback that survives a page
      refresh.
- [x] **Phase 2 — The grid**: split panes in any direction, 1 to 16 at once,
      with preset layout templates.
- [x] **Phase 3 — Agents and workspaces**: pick which agent runs in each pane
      (Claude Code, cursor-agent, Codex, or a plain shell), and save a layout
      per project so it comes back when you reopen it.
- [x] **Phase 4 — Keyboard-first and themes**: drive the whole app without a
      mouse, plus 26 dark-first colour themes.
- [x] **Phase 4.5 — The workroom layout**: a three-column shell (workspace
      rail, pane grid, right dock) and a design token system — see
      [docs/DESIGN.md](./docs/DESIGN.md).
- [x] **Phase 5 — Command blocks**: each command and its output tracked as
      one block with its exit code and duration, via OSC 133 shell
      integration that never touches your own dotfiles.
- [x] **Phase 6 — Files, editor, preview**: a file tree, a built-in code
      editor, and an embedded browser for checking `localhost` without
      leaving the window.
- [x] **Phase 7 — The board**: a kanban board where dispatching a card
      starts an agent working on it — see
      [docs/AGENT-API.md](./docs/AGENT-API.md) for how an agent moves its
      own card.
- [x] **Phase 8 — Shared memory**: plain markdown notes in `.vibedeck/memory/`,
      linked into a graph and shared with every agent over MCP, so what one
      agent learns the next one starts with — see
      [docs/MEMORY.md](./docs/MEMORY.md).
- [ ] **Phase 9 — Swarm**: multiple agents on one mission with defined roles,
      a shared mailbox, file ownership so two agents never edit the same file,
      and quality gates.
- [ ] **Phase 10 — Skills**: reusable prompt packs you drag onto a running
      pane to change what that agent is doing. Server done (discovery, the
      open `agentskills.io` format, REST/MCP, and pane injection) — see
      [docs/SKILLS.md](./docs/SKILLS.md). Drag-and-drop web UI not built yet.
- [x] **Phase 11a — Desktop app shell**: a real native macOS window (Tauri
      2) wrapping the same web app, spawning the Node server as a sidecar —
      see [docs/DESKTOP.md](./docs/DESKTOP.md). Unsigned, macOS-only, and
      requires the repo checkout + system Node (documented limitations, not
      hidden ones).
- [ ] **Phase 11b — Real packaging**: signed builds, auto-updates, and
      cross-platform installers (Windows/Linux).

## Prerequisites

- **Node.js 22** (see `.nvmrc` — use `nvm use` if you have nvm installed)
- **pnpm** — a faster, disk-efficient alternative to npm for installing
  JavaScript packages. This repo pins pnpm 11.15.1 via the
  `packageManager` field in `package.json`, so tools like Corepack (bundled
  with Node) will use the right version automatically.

## Quickstart

```bash
pnpm install   # download and link dependencies for every package in the workspace
pnpm dev       # start the server (port 4317) and the web app (port 5317) together
```

Then open `http://localhost:5317` in your browser.

On first run you'll be asked to create a **workspace** — give it a name and
point it at any project directory. Panes you open will start in that
directory. From there: pick an agent for a pane, press `⌘K` for the command
palette, or `?` for the full keyboard shortcut list.

Whichever agents you want to run need to be installed and on your `PATH`
already — vibedeck launches `claude`, `cursor-agent` and `codex`, it does not
bundle them. Anything missing is shown as "not installed" rather than
failing when you click it.

## Project layout

This is a **pnpm workspace monorepo** — one git repository containing
several separate npm packages that can depend on each other locally.

```
vibedeck/
├── apps/
│   ├── server/    # Fastify backend (port 4317)
│   └── web/       # React + Vite frontend (port 5317)
└── packages/
    └── shared/    # Types shared between server and web (e.g. the
                    # WebSocket message protocol), so both sides always
                    # agree on the shape of the data they send each other.
```

## License

MIT — see [LICENSE](./LICENSE).
