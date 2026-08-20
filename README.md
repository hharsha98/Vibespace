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

## Download

**[Get v0.1.0 →](https://github.com/hharsha98/vibedeck/releases/latest)**

| Platform | File |
|---|---|
| macOS (Apple Silicon) | `vibedeck_0.1.0_aarch64.dmg` |
| Windows | `vibedeck_0.1.0_x64-setup.exe` |
| Linux | `.deb`, `.rpm`, or `.AppImage` |

Two things to know before you install:

- **You need [Node.js 22+](https://nodejs.org) installed.** vibedeck runs
  real terminals and a real database through Node, and the installer does
  not bundle a Node runtime.
- **The app is not code-signed**, so the first launch is blocked. On macOS,
  right-click the app → **Open** → **Open**. On Windows, SmartScreen shows
  "More info" → **Run anyway**. Once, then never again. This is a
  deliberate trade-off (signing certificates cost money annually), not a
  sign anything is wrong.

Honest about testing: **macOS is verified end-to-end** — the released DMG
was downloaded, installed, launched, and used to spawn real terminals. The
Windows and Linux packages build cleanly in CI but nobody has launched
them yet. If you are the first, and something breaks,
[open an issue](https://github.com/hharsha98/vibedeck/issues) — that is
genuinely useful information.

Prefer to run from source? See [Quickstart](#quickstart) below.

## Status: usable, and still being built

The core works today. You can open a workspace, split the screen into up to
16 panes, run Claude Code, cursor-agent, Codex or plain shells side by side,
browse and edit files, and dispatch work to an agent from a task board.
Closing the browser tab does not kill your agents — sessions live on the
server, so you can come back and pick up where you left off.

Multi-agent orchestration and skills are in too: missions with role-based
agents and database-arbitrated file ownership, and skills on the open
[agentskills.io](https://agentskills.io) standard — so skills you already
have installed for other tools are picked up as-is.

What is **not** here: real platform code-signing (Apple notarization, a
Windows certificate), so Gatekeeper and SmartScreen warn on first launch.
That is a deliberate trade-off, not a bug. There is no Windows MSI either —
WiX cannot build one for this app, so Windows gets an NSIS installer
instead ([docs/DESKTOP.md](./docs/DESKTOP.md) explains why).

Known limits worth reading before you rely on it: the desktop app needs
system Node, the "is the agent busy" signal is exact for shells but a
heuristic for agent TUIs, and swarm file ownership is cooperative rather
than OS-enforced. Each of those is documented where it lives rather than
glossed over — [docs/PARITY.md](./docs/PARITY.md) collects them. This is a
young project moving quickly; expect rough edges.

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
      see [docs/DESKTOP.md](./docs/DESKTOP.md).
- [x] **Phase 11b — Relocatable installers and auto-updates**: a packaged
      build no longer requires the repo checkout it was built from
      (verified by hand, launched from a fully relocated copy of the
      built `.app`); an auto-updater that checks silently in the
      background and only ever restarts after an explicit click, never
      losing a running session without asking; and a release workflow for
      macOS/Windows/Linux (macOS verified end-to-end, the workflow itself
      not yet run against a real CI runner). Still requires system Node,
      and still unsigned in the platform code-signing sense (Gatekeeper/
      SmartScreen warn on first launch) — see
      [docs/DESKTOP.md](./docs/DESKTOP.md) for exactly what's fixed and
      what isn't.
- [x] **SSH connection profiles**: open a pane on a remote machine over
      `ssh` — a saved host/user/port with a per-profile default directory
      and startup command applied after connect, plus one-click Duplicate.
      No credentials are stored; authentication is entirely your own
      ssh-agent/keys, the same as any terminal — see
      [docs/SSH.md](./docs/SSH.md).

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

## The `vibedeck` CLI

Once you have a build, `vibedeck [path]` opens any directory as a workspace
straight from the terminal — the equivalent of `cd`-ing into a project and
running `bridgespace .` — instead of opening the app and adding it by hand.

```bash
pnpm --filter @vibedeck/server build   # the CLI runs the built server, not TS source
pnpm --filter @vibedeck/server exec vibedeck .          # this directory
pnpm --filter @vibedeck/server exec vibedeck ~/code/foo # any other directory
```

What it does, in order:

1. Resolves the path (defaults to `.`), expanding `~` and requiring it to
   exist and be a directory — the same rule `apps/server/src/workspace-path.ts`
   applies when you add a workspace through the app itself, so an error here
   ("does not exist", "exists but is not a directory") is the same message
   you'd have gotten from the UI.
2. Checks whether a server is already listening — either the normal
   dev/prod one (port 4317 by default) or, if you already have the desktop
   app open, its sidecar (a fixed port, 45317 — see
   `apps/server/src/runtime-config.ts`'s `DESKTOP_SIDECAR_PORT`). If either
   is up, it's reused; nothing new is spawned.
3. If neither is up, starts `node dist/index.js` itself, detached, and waits
   up to 15s for it to answer `/api/health`.
4. Finds an existing workspace whose `rootPath` exactly matches the resolved
   path and reuses it, or creates one — never a duplicate for a path you've
   already opened before.
5. Opens your default browser at that server, with a `?workspace=<id>`
   query param the web app reads once (then strips from the URL) to select
   that workspace instead of whichever one happened to be first.

It deliberately does NOT try to launch the desktop `.app` fresh: the Tauri
wrapper (`apps/desktop/src-tauri/src/main.rs`) takes no CLI arguments and
registers no URL scheme today, so there'd be nothing for it to open *at* —
launching it would just show whatever workspace it last had selected, not
necessarily the one you asked for. If you already have it open, step 2
above finds and reuses its sidecar; vibedeck just doesn't know how to start
it pointed at a specific workspace yet.

**Putting it on your PATH** is up to you — nothing in this repo does it
automatically. Two common ways:

```bash
# Option A: pnpm link, so `vibedeck` resolves globally
cd apps/server && pnpm link --global

# Option B: add pnpm's per-project bin dir to PATH yourself, e.g. in
# ~/.zshrc (only if you already know you want this):
export PATH="/absolute/path/to/vibedeck/apps/server/node_modules/.bin:$PATH"
```

## Releasing

Desktop installers (DMG / NSIS / DEB+RPM+AppImage) are built and
published by `.github/workflows/release.yml`, triggered by pushing a tag
matching `v*` (or manually via the Actions tab's "Run workflow"). See
[docs/DESKTOP.md](./docs/DESKTOP.md#releasing) for the full process,
including where the auto-updater's signing key lives and why losing it
would be permanent. Short version: bump the version in
`apps/desktop/src-tauri/tauri.conf.json`, tag, push — three platform
builds run in parallel and land in one draft GitHub Release for a human to
review and publish.

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
