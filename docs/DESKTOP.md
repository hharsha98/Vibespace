# Desktop app (Phase 11a, PARITY #50, closes #48)

vibedeck's desktop app is a **Tauri 2** window wrapped around the exact same
web app the browser build serves. It is not a rewrite: the terminal grid,
the board, memory, swarm, skills — everything — is the same React app,
loaded from the same Fastify server. What Tauri adds is a real native
window: a dock icon, a menu bar, and (the actual point of this phase,
PARITY #48) keyboard shortcuts a browser tab can never see, like plain
⌘N/⌘W/⌘T.

This document: how to run it in dev, how to build the DMG, the sidecar
architecture, what a user actually needs installed, and — honestly — this
build's real limitations. If something below reads as a caveat rather than
a feature, that's deliberate; a Phase 11b (auto-updates, real cross-platform
installers, a portable bundle) is scoped separately and is not done yet.

## The central problem, and how this solves it

vibedeck's backend (`apps/server`) is a Node process with two native
addons — `node-pty` (spawns real ptys) and `better-sqlite3` (the
workspace/board/memory database). Neither can be rewritten in Rust; Tauri
only produces a Rust binary. So the desktop app does not reimplement the
server — it **spawns the real Node server as a child process** ("sidecar"),
waits for it to actually answer, and points the window's webview at it.
Tauri owns the native chrome; Node still owns everything it always owned.

See `apps/desktop/src-tauri/src/main.rs`'s own top doc comment for the
implementation; the summary:

1. On startup, Rust spawns `apps/server`'s TypeScript source directly via
   `tsx` (the same mechanism `pnpm dev` already uses — not the compiled
   `dist/index.js`; see "Why `tsx`, not the compiled server" below for why).
2. The server prints one exact line to stdout the instant it's actually
   listening: `VIBEDECK_SERVER_READY:<port>` (see
   `apps/server/src/runtime-config.ts`'s `formatReadyLine`). Rust reads
   stdout looking for that line — not a fixed sleep, not polling a port
   (which can't tell "not up yet" apart from "something else is listening
   there"). A 20-second timeout swaps the loading screen for a real error
   message if it never shows up.
3. Once ready, Rust calls `window.navigate()` to the real
   `http://127.0.0.1:<port>/?vibedeckDesktop=1` URL. The `?vibedeckDesktop=1`
   marker is how the web app tells the desktop build apart from the browser
   build (`hasDesktopMarker`/`isTauriApp` in `apps/web/src/keys/keymap.ts`)
   — see that file's comment for why a URL marker we control, rather than
   Tauri's `__TAURI_INTERNALS__`, which isn't confidently guaranteed to
   survive navigation to a non-`tauri://` origin.
4. On window close (or app quit, or a bare `kill <pid>` — see "Shutdown"
   below), Rust shuts the Node child down.

## What a user actually needs installed

**This is not a self-contained app.** Two real requirements:

1. **Node.js 22+ on `PATH`**, or in one of a short list of common install
   locations `resolve_node_dir` checks (Homebrew's `/opt/homebrew/bin` or
   `/usr/local/bin`, `~/.local/bin`, `~/.volta/bin`) — because a
   Finder-launched `.app` gets a minimal `PATH`
   (`/usr/bin:/bin:/usr/sbin:/sbin`) that doesn't include wherever a
   version manager or Homebrew actually put Node. This list is **not
   exhaustive** — nvm's per-version directories in particular aren't
   covered, since there's no one fixed path to check. If your Node lives
   somewhere else, the app shows a clear error instead of a blank window
   (see "What happens when the server can't start"), but it also won't
   have found Node — launching from a Terminal that already has the right
   `PATH` exported is the workaround.
2. **The exact vibedeck repo checkout this build was made from, still on
   disk at the same path.** The app is not relocatable — see "Why `tsx`,
   not the compiled server" for the full reason, but concretely:
   `apps/desktop/src-tauri/src/main.rs`'s `repo_root()` bakes an absolute
   path into the binary **at compile time** and runs the server straight
   out of that checkout's `apps/server/src` via `tsx`. Move or delete the
   checkout, and the app breaks. A real portable bundle is Phase 11b's job.

This build does **not** claim to be self-contained, and does not bundle a
Node runtime. That's a deliberate v1 trade-off — see the next section.

## Why `tsx`, not the compiled server

`apps/server/package.json` already has a `start` script
(`node dist/index.js`) that looks like the obvious way to run a "packaged"
build. It turns out to already be broken standalone, for a reason that
predates this phase: `packages/shared/package.json`'s `main` field points
at its TypeScript **source** (`./src/index.ts`), not a compiled `dist/`.
That resolves fine everywhere the rest of the monorepo runs it (`tsx`,
Vite, and Vitest all transpile on the fly), but a plain `node
dist/index.js` fails immediately with `ERR_MODULE_NOT_FOUND` trying to
import `@vibedeck/shared` — confirmed by hand while building this phase.

Fixing that repo-wide (giving `@vibedeck/shared` a real build output every
consumer resolves through, in both dev and "packaged" modes) is a bigger,
riskier change than this phase's scope — every package in the workspace
resolves that import today, and dev's whole point is "no build step needed
between edits." So the desktop sidecar sidesteps the bug entirely by
running the server the exact same way `pnpm dev` already does: `tsx`
against source, proven to work (see `spawn_server`'s doc comment). The
cost is the "repo checkout must still exist" requirement above. A proper
fix — either repairing `@vibedeck/shared`'s resolution, or bundling a
relocatable copy of the compiled server into the `.app` — is real work
Phase 11b should do, not something this phase quietly worked around
without saying so.

## Port: why 45317, not 4317

Hardcoding vibedeck's normal port (4317) would mean launching the desktop
app while `pnpm dev` is running in a terminal — a completely ordinary thing
to do while developing vibedeck itself — collides. The desktop app sets
`VIBEDECK_PORT=45317` when it spawns the sidecar; `apps/server`'s
`resolveServerPort` (in `runtime-config.ts`) reads that override, falling
back to 4317 for everyone else (dev, tests, a plain `node dist/index.js`).
45317 isn't registered for anything else and doesn't collide with either
4317 (the server) or 5317 (Vite) — picked to visually pair with both rather
than being an arbitrary number. This is a **fixed** port, not a
dynamically-chosen free one: fine for a single instance of the desktop app
(the only case this phase tests), but two copies of the desktop app running
at once would still collide with each other — a real, small limitation, not
one this phase's scope required solving.

## What happens when the server can't start

The window never shows blank/frozen indefinitely. `apps/desktop/loading/`
is what the window shows first (Tauri's `frontendDist`) — a small dark page
matching `docs/DESIGN.md`'s palette, with a spinner and a status line. Three
outcomes:

- **Ready in time** (typically ~1-2s on a warm machine): the window
  navigates straight to the real app. The loading page is never seen for
  long enough to read.
- **The server process couldn't even be spawned** (e.g., the `tsx` binary
  itself is missing — a corrupted/incomplete checkout): the loading page's
  status text is replaced with the actual OS error and a pointer to this
  doc.
- **The server exited before printing its ready line, or 20 seconds passed
  without it** (most likely cause: Node not found — see "What a user
  actually needs installed"): same error page, showing the last lines the
  server itself printed to stderr, so the actual failure (not just "it
  didn't work") is visible.

## Shutdown: no leaked server process

A Node process still holding the port after the user thinks they've quit is
a real, specifically-called-out bug for this phase, and one hand-testing
actually caught mid-build (see below) — not just handled speculatively.
Three independent paths all call the same `kill_server` (SIGTERM first, so
the server's own graceful shutdown — disposing every pty, closing the
SQLite handle — gets a chance to run; SIGKILL after a 3-second grace period
if it hasn't exited):

1. **Closing the window** — `on_window_event`'s `CloseRequested`.
2. **Quitting the app** (Cmd+Q, Dock > Quit, the menu's Quit item) —
   `.run`'s `RunEvent::Exit`.
3. **A bare `kill <pid>`** (`pkill vibedeck`, a process manager) — this one
   is NOT covered by paths 1/2: a raw Unix signal bypasses Cocoa's
   termination lifecycle entirely, so neither Tauri event fires. Confirmed
   by hand while building this phase — killing the dev binary directly left
   the sidecar orphaned on its port. Fixed with a `signal-hook`-based
   background thread (see `install_signal_handler`'s doc comment) that
   catches `SIGTERM`/`SIGINT` and runs the same `kill_server`.

All three were tested by hand: `pgrep -f "node.*apps/server"` (and
`lsof -iTCP:45317`) confirmed nothing survives any of the three paths.

## The native menu, and the shortcuts it does (and doesn't) bind

`apps/desktop/src-tauri/src/main.rs`'s `setup` builds a small menu:
**vibedeck** (About, Quit), **Edit** (Undo/Redo/Cut/Copy/Paste), **Pane**
(New Pane, Close Pane, Theme Picker). Two things worth knowing:

- Tauri's built-in default macOS menu is explicitly disabled
  (`enable_macos_default_menu(false)`). It includes a "Close Window" item
  on the standard ⌘W accelerator — which would intercept ⌘W at the OS level
  and close the whole window, fighting directly with vibedeck's own ⌘W
  ("close the focused pane"). Same reasoning kept `select_all` (⌘A) out of
  the Edit menu: ⌘A is vibedeck's own "View: Agents" shortcut.
- The **Pane** menu's three items deliberately have **no accelerator set**.
  A real OS-level menu accelerator is intercepted before the webview's own
  keydown listener ever sees it — binding one would make
  `matchShortcut`'s new `isDesktop` branch (the actual #48 fix, in
  `apps/web/src/keys/keymap.ts`) unreachable. Clicking a Pane item still
  works: the handler simulates the exact `KeyboardEvent` the physical
  shortcut would have produced, so both paths run through
  `useKeyboardShortcuts.ts`'s one real listener, not a second
  implementation.

The actual shortcut recovery is in `matchShortcut`'s `isDesktop` parameter:
`new-pane`/`close-pane`/`theme-picker` — the three ids the browser build's
top comment already explains got pushed onto ⌘⇧ variants because Chrome
reserves ⌘N/⌘W/⌘T — now ALSO match their plain form when running inside the
desktop build, on top of (not instead of) the ⌘⇧ form, which keeps matching
in both builds. `apps/web/src/keys/keymap.test.ts` covers this without a
browser: `matchShortcut(event, isMac, isDesktop)` takes a plain boolean, no
DOM required.

## Icon

Generated from vibedeck's own mark (`apps/web/public/favicon.svg` — same
rounded dark tile, same three shapes as `apps/web/src/shell/Logo.tsx`) via
`tauri icon`, not invented or placeholder. Only the macOS-relevant sizes
were kept (`apps/desktop/src-tauri/icons/`); the `tauri icon` command also
generates iOS/Android/Windows-Store assets by default, deleted here since
this phase targets macOS only.

## Running in dev

```bash
pnpm --filter @vibedeck/desktop run tauri:dev
```

This first builds `apps/web/dist` (`pnpm --filter @vibedeck/web build` —
there's no Vite dev server in the desktop build, so the sidecar always
serves a real build, not source), then runs `tauri dev`, which compiles the
Rust binary (a full first build pulls and compiles ~340 crates — expect a
few minutes the very first time; incremental rebuilds after that are
seconds) and launches it. The window shows the loading page, the sidecar
spawns, and it navigates to the real app once ready.

Running `pnpm dev` (the ordinary web dev flow) is **unaffected** — it
doesn't build or touch anything under `apps/desktop`, and the desktop
app's fixed port (45317) never collides with the dev server's 4317.

## Building the DMG

```bash
pnpm --filter @vibedeck/desktop run package:mac
```

Builds `apps/web/dist`, then runs `tauri build` — an optimized release
compile plus DMG packaging. **Unsigned**, per this phase's explicit scope:
no Apple Developer account, no signing identity, no notarization. The
built `.app`/`.dmg` land under
`apps/desktop/src-tauri/target/release/bundle/`. Actually built and run
while writing this phase: `.app` 9.5MB, final `.dmg` 2.7MB.

**If the build hangs at "Running AppleScript to make Finder stuff
pretty"**: the DMG bundler (`create-dmg`-derived `bundle_dmg.sh`) scripts
Finder via `osascript` to position icons and set the window's background —
in a non-interactive session with no Automation permission granted (hit
while building this phase, running from an agent-driven Terminal session
with no GUI-scripting permission), that `osascript` call blocks
indefinitely instead of failing. Fix: `CI=true pnpm --filter
@vibedeck/desktop run package:mac` — Tauri's bundler detects `CI` and
passes `--skip-jenkins` to `bundle_dmg.sh`, skipping the AppleScript
entirely (the DMG still works fine, just without the custom icon layout).
A normal interactive terminal session on a real desktop shouldn't hit this
at all.

### Gatekeeper, on first launch

Because it's unsigned, macOS Gatekeeper blocks a plain double-click on
first launch ("vibedeck can't be opened because Apple cannot check it for
malicious software" or similar). Workaround: right-click (or Control-click)
the app in Finder → **Open** → **Open** in the confirmation dialog. Only
needed once per machine; after that first approved launch, it opens
normally. This is expected for an unsigned build, not a bug — and exactly
what "unsigned" was asked for means (see this phase's own scope note: no
signing/notarization config was added).

## Known limitations, stated plainly

- **Not relocatable.** Tied to the exact repo checkout path it was built
  from (compile-time `CARGO_MANIFEST_DIR`) — see "Why `tsx`, not the
  compiled server."
- **Requires system Node**, not bundled. See "What a user actually needs
  installed."
- **`resolve_node_dir`'s fallback list is not exhaustive** — notably, nvm's
  per-version directories aren't covered.
- **Fixed port (45317), not dynamically chosen.** Fine for one instance;
  two copies of the desktop app running simultaneously would collide with
  each other (not with `pnpm dev`, which is the case this phase actually
  needed to solve).
- **Unsigned.** Gatekeeper's first-launch warning (above) is a direct,
  expected consequence, not a bug to fix here.
- **macOS only, this phase.** Windows/Linux builds, auto-updates, and
  proper multi-platform installers are Phase 11b.
- **Screen-capture tooling cannot see this window.** Not a limitation of
  the app — a limitation of capturing it. `screencapture` returns only the
  wallpaper for the region the window occupies, and `screencapture -l
  <windowid>` fails outright with "could not create image from window",
  even while CoreGraphics reports that same window as onscreen, `alpha=1.0`,
  `layer=0`, with correct bounds, and macOS shows the app's native menu bar.
  Worth writing down because those signals look exactly like a window that
  renders nothing, and they are not: the app was confirmed drawing its full
  UI correctly from a screenshot taken by hand at the machine. If you are
  automating against this app, do not treat an empty capture as evidence
  that it is broken — verify through the server (`curl
  http://127.0.0.1:45317/api/workspaces`) or by looking at the screen.

## Architecture reference

| File | Role |
|---|---|
| `apps/desktop/src-tauri/src/main.rs` | Spawns the sidecar, waits for readiness, navigates the window, builds the menu, handles shutdown (three paths — see "Shutdown" above). |
| `apps/desktop/src-tauri/tauri.conf.json` | Window config, icon set, unsigned bundle targets (`app`, `dmg`). |
| `apps/desktop/loading/index.html` | The window's first-shown content — spinner/status page `main.rs` `eval()`s into on error. |
| `apps/server/src/runtime-config.ts` | Pure, unit-tested logic shared by both dev and desktop: `resolveServerPort`, `resolveStaticDir`, `formatReadyLine`/`parseReadyLine`. See `runtime-config.test.ts`. |
| `apps/server/src/index.ts` | Serves `apps/web/dist` as static files when `staticDir` is set (via `@fastify/static`) — makes the server + browser bundle one origin, no Vite proxy. |
| `apps/web/src/keys/keymap.ts` | `matchShortcut`'s `isDesktop` branch (the #48 fix) and `hasDesktopMarker`/`isTauriApp` (desktop-build detection via a URL marker, not `__TAURI_INTERNALS__`). |
