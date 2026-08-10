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

## Status: early, Phase 0

This project is **brand new**. Right now it's just the toolchain skeleton —
a pnpm workspace with a server, a web app, and a shared package, wired
together and proven to build, lint, test, and boot. There is no terminal
grid, no kanban board, and no agent orchestration yet. If you're looking for
a working product, this isn't it yet — check back as the roadmap below
fills in.

## Roadmap

- [x] **Phase 0 — Foundation**: pnpm workspace, TypeScript config, CI,
      a Fastify server and a React web app that can talk to each other.
- [ ] **Phase 1 — Terminal core**: run a real terminal session (a shell, or
      an AI agent's CLI) inside the browser — input and output streamed over
      a WebSocket, rendered on the GPU, with scrollback that survives a page
      refresh.
- [ ] **Phase 2 — The grid**: split panes in any direction, 1 to 16 at once,
      with preset layout templates.
- [ ] **Phase 3 — Agents and workspaces**: pick which agent runs in each pane
      (Claude Code, cursor-agent, Codex, or a plain shell), and save a layout
      per project so it comes back when you reopen it.
- [ ] **Phase 4 — Keyboard-first and themes**: drive the whole app without a
      mouse, plus a set of dark-first colour themes.
- [ ] **Phase 5 — Command blocks**: treat each command and its output as one
      collapsible block with its exit code, the way Warp does.
- [ ] **Phase 6 — Files, editor, preview**: a file tree, a built-in code
      editor, and an embedded browser for checking `localhost` without
      leaving the window.
- [ ] **Phase 7 — The board**: a kanban board where dragging a card
      dispatches an agent to work on it, and agents move their own cards
      as they progress.
- [ ] **Phase 8 — Shared memory**: plain markdown notes in `.vibedeck/memory/`,
      linked into a graph and shared with every agent over MCP, so what one
      agent learns the next one starts with.
- [ ] **Phase 9 — Swarm**: multiple agents on one mission with defined roles,
      a shared mailbox, file ownership so two agents never edit the same file,
      and quality gates.
- [ ] **Phase 10 — Skills**: reusable prompt packs you drag onto a running
      pane to change what that agent is doing.
- [ ] **Phase 11 — Desktop app**: package it as a real installable desktop
      application with automatic updates.

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

Then open `http://localhost:5317` in your browser. It should show a
health check against the server.

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
