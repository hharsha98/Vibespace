# Desktop app (Phase 11a, PARITY #50, closes #48; auto-updates and
# relocatable installers added by Phase 11b, PARITY #51/#52)

vibedeck's desktop app is a **Tauri 2** window wrapped around the exact same
web app the browser build serves. It is not a rewrite: the terminal grid,
the board, memory, swarm, skills — everything — is the same React app,
loaded from the same Fastify server. What Tauri adds is a real native
window: a dock icon, a menu bar, and (the actual point of Phase 11a,
PARITY #48) keyboard shortcuts a browser tab can never see, like plain
⌘N/⌘W/⌘T.

This document: how to run it in dev, how to build a packaged installer, the
sidecar architecture, what a user actually needs installed, how the
auto-updater works and why, how to cut a release, and — honestly — this
build's real remaining limitations. If something below reads as a caveat
rather than a feature, that's deliberate.

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

**Updated by Phase 11b.** A packaged build (the DMG/NSIS/DEB/RPM/
AppImage a user actually installs) is now relocatable — it no longer
requires the repo checkout it was built from to still exist. One real
requirement remains:

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
   `PATH` exported is the workaround. **No Node runtime is bundled into
   the .app** — that's a genuinely bigger undertaking (embedding a
   ~100MB+ per-platform Node binary) Phase 11b didn't take on; see
   "Relocatable installers" below for exactly what Phase 11b DID fix.

Only `cargo tauri dev` (running this crate straight from a checkout, no
packaging step) still requires the checkout to exist — see "Relocatable
installers" for why that's fine, not an oversight.

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
consumer resolves through, in both dev and "packaged" modes) was
deliberately NOT done in Phase 11a — every package in the workspace
resolves that import today, and dev's whole point is "no build step needed
between edits." So Phase 11a's desktop sidecar sidesteps the bug entirely
by running the server the exact same way `pnpm dev` already does: `tsx`
against source, proven to work (see `spawn_server`'s `ServerSource::Dev`
doc comment). That's still exactly what `cargo tauri dev` does today. The
cost was the "repo checkout must still exist" requirement — which Phase
11b fixes for PACKAGED builds specifically. See "Relocatable installers"
below for how, and why `packages/shared/package.json` itself was still
deliberately left untouched.

## Relocatable installers (Phase 11b, PARITY #52)

**A packaged build (DMG/NSIS/DEB/RPM/AppImage) now works when moved to
a different location, or a different machine entirely** — verified by
hand: building the DMG, copying the extracted `.app` to a directory
completely outside the repo, and launching the binary directly. It served
the real API (`/api/health`, `/api/workspaces`) and the real built web app,
with the response's own `cwd` field confirming it was running from the
relocated copy, not silently falling back to the original checkout.

The fix has two parts, both in `apps/desktop/scripts/build-server-resources.mjs`
(run by `pnpm --filter @vibedeck/desktop run package` before `tauri build`,
never by `cargo tauri dev`):

1. **A real, deployed copy of `apps/server` and its production
   dependencies**, via `pnpm deploy --prod`. This is what makes
   `better-sqlite3` and `node-pty`'s native `.node` binaries — built for
   whichever OS/arch actually ran the packaging step — present as real
   files instead of symlinks into a pnpm store that won't exist on
   whoever installs the app.
2. **`packages/shared`'s `main`/`types` fields, patched to point at its
   own `dist/` — but only inside that ONE deployed copy, never the real
   `packages/shared/package.json` in the live monorepo.** That file is
   deliberately untouched (see "Why `tsx`, not the compiled server"
   above) — every other consumer (`pnpm dev`, Vite, Vitest, `tsx`) keeps
   resolving `@vibedeck/shared` exactly as it always has.

`apps/desktop/src-tauri/src/main.rs`'s `resolve_server_source` picks
between this bundled copy and the original `tsx`-against-source mechanism
by checking whether the bundle actually exists at the expected path inside
the app's own resources — not by asking "is this a dev build or a release
build", which could drift out of sync with reality. `cargo tauri dev`
never produces that bundle, so it transparently keeps using the Phase 11a
mechanism; a packaged build always has it, so it always uses the new one.

**Two sharp edges found by hand while building this, both worth knowing
about if this script is ever touched again:**

- **pnpm's content-addressable store can hardlink files — even for a
  local, `file:`-referenced workspace package like `@vibedeck/shared` —
  not just symlink them.** A first attempt at patching the deployed
  copy's `package.json` with a plain `fs.writeFileSync` silently rewrote
  the REAL `packages/shared/package.json` in the live repo through a
  shared inode (caught via `stat -f "dev=%d inode=%i links=%l"` showing
  the same device+inode on both files). The fix: always unlink the file
  before writing a replacement, unconditionally — see
  `patchSharedPackageJson`'s own comment.
- **`pnpm deploy`'s default output is NOT symlink-free**, and **Tauri's
  own resource-bundling step does not preserve the symlinks it does
  contain** — a built `.app` was found, by actually launching a relocated
  copy of it, to be missing `fastify`, `@vibedeck/shared`, and every other
  top-level package from `node_modules` (while still carrying their real
  content under a now-unreachable `.pnpm/` store), failing immediately
  with `ERR_MODULE_NOT_FOUND`. The fix: `pnpm deploy --config.node-linker=
  hoisted`, which lays `node_modules` out the classic flat/npm way instead
  of pnpm's default per-package virtual-store symlink maze — confirmed by
  hand to drop the symlink count from "every top-level package" to 7
  harmless `node_modules/.bin/*` shims (unused; this bundle only ever runs
  `node dist/index.js` directly), while landing at a SMALLER total size
  (roughly 120MB) than a first attempt at hand-rolling a recursive
  symlink-dereferencer instead (roughly 530MB — hoisted mode's own
  deduplication does this better than a naive walk).

**The honest cost**: this adds roughly 100-150MB to the installer (a
9.5MB `.app` becomes ~135MB; a 2.7MB DMG becomes ~30MB) — mostly
`node-pty`, which ships prebuilt native binaries for every platform inside
one npm package regardless of host OS. That is the real price of "actually
works when you move it," not an oversight.

**What is still NOT bundled**: a Node.js runtime itself. See "What a user
actually needs installed" above — that requirement is unchanged.

## Auto-updates (Phase 11b, PARITY #51)

**The UX decision, and why**: this app hosts long-lived terminal sessions
— real agent work that can run for hours. An update that silently
restarts the app the moment one becomes available would kill every one of
those sessions' underlying processes without warning (see "Shutdown"
below: closing the window already tears every pty down). That's
unacceptable for a background check the user never explicitly asked to run
right now. So:

1. **Checks silently, on startup and then every 4 hours** while the app
   stays open (`CHECK_INTERVAL_MS` in `apps/web/src/shell/updater.ts`).
   A failed check — offline, GitHub unreachable, a corporate proxy in the
   way — is swallowed with nothing shown to the user; a background check
   must never block startup or look like an error. See `UpdateBanner.tsx`'s
   `runCheck`.
2. **Shows a small, dismissible banner only once a real update is found**
   — never a modal, never anything that blocks the rest of the app.
   Dismissing a version doesn't suppress a LATER version's own banner —
   each new version gets to ask once (`shouldShowUpdateBanner` in
   `updater.ts`, unit-tested).
3. **Only downloads, installs, and restarts after the user clicks "Update
   & Restart"** — an explicit, one-click action. There is no code path in
   this app that calls `relaunch()` without that click having happened
   first (see `UpdateBanner.tsx`'s `handleUpdate`).

**Signing**: `tauri-plugin-updater`'s own public/private keypair —
unrelated to Apple, no developer account needed. The public key lives
inline in `apps/desktop/src-tauri/tauri.conf.json`'s `plugins.updater.
pubkey` (safe to commit — it can only verify signatures, not create them).
The endpoint points at this repo's GitHub Releases `latest.json`
(`https://github.com/hharsha98/vibedeck/releases/latest/download/
latest.json`), which `.github/workflows/release.yml` publishes.

**Where the private key lives, and why it must never move**: `~/.vibedeck/
updater.key`, outside this repo, mode 600, with no password. It is ALSO
stored as the `TAURI_SIGNING_PRIVATE_KEY` secret on this GitHub repo,
which is what `.github/workflows/release.yml` actually signs releases
with — nothing in this repo's source or history ever contains it.
**If this key is lost, every already-installed copy of vibedeck becomes
permanently unable to verify (and therefore install) any future update.**
The public key baked into already-shipped installers can only verify
signatures made by the matching private key; a new keypair would mean
every past installer needs to be manually reinstalled from a fresh
download, not updated in place. Back this file up somewhere durable
outside both this repo and the machine that holds the only copy.

**Extra npm/Rust dependencies beyond `@tauri-apps/plugin-updater`/
`tauri-plugin-updater`**: `@tauri-apps/plugin-process`/`tauri-plugin-
process`, for the `relaunch()` call after an approved install — Tauri
splits "restart the process" into its own small companion plugin rather
than folding it into the updater or core.

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

## Building a package locally

```bash
pnpm --filter @vibedeck/desktop run package:mac    # or package:win / package:linux —
                                                      # all three are the same command;
                                                      # tauri build picks the targets
                                                      # valid for whatever OS you're on
```

Builds `apps/web/dist`, then `apps/desktop/scripts/build-server-resources.mjs`
(the relocatable server bundle — see "Relocatable installers" above), then
`tauri build` — an optimized release compile plus platform packaging
(DMG on macOS, NSIS on Windows, DEB+RPM+AppImage on Linux, chosen
automatically for the host OS since `tauri.conf.json`'s `bundle.targets`
is `"all"`). The built artifacts land under
`apps/desktop/src-tauri/target/release/bundle/`. Actually built and run on
macOS while writing Phase 11b: `.app` ~135MB, final `.dmg` ~30MB (up from
Phase 11a's 9.5MB/2.7MB — see "Relocatable installers" for the honest
reason: the server bundle's own `node_modules`, including `node-pty`'s
per-platform prebuilt binaries).

**Signing is required for EVERY build now, including a local unsigned test
build** — not just real releases. `bundle.createUpdaterArtifacts: true`
(needed so the updater has something to check against) means `tauri build`
refuses to finish without `TAURI_SIGNING_PRIVATE_KEY` set, even on a
machine that never intends to publish anything:

```bash
TAURI_SIGNING_PRIVATE_KEY="$HOME/.vibedeck/updater.key" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
CI=true pnpm --filter @vibedeck/desktop run package:mac
```

The app itself is still genuinely unsigned in the Apple/Microsoft/Linux
distro sense — no Apple Developer account, no code-signing identity, no
notarization, no MSI Authenticode certificate. This is ONLY the updater's
own independent signing (see "Auto-updates" above — a completely different
keypair, unrelated to platform code-signing).

**If the build hangs at "Running AppleScript to make Finder stuff
pretty"**: the DMG bundler (`create-dmg`-derived `bundle_dmg.sh`) scripts
Finder via `osascript` to position icons and set the window's background —
in a non-interactive session with no Automation permission granted (hit
while building Phase 11a, running from an agent-driven Terminal session
with no GUI-scripting permission), that `osascript` call blocks
indefinitely instead of failing. Fix: add `CI=true` to the command above —
Tauri's bundler detects `CI` and passes `--skip-jenkins` to
`bundle_dmg.sh`, skipping the AppleScript entirely (the DMG still works
fine, just without the custom icon layout). A normal interactive terminal
session on a real desktop shouldn't hit this at all.

### Gatekeeper, on first launch

Because the app itself is unsigned, macOS Gatekeeper blocks a plain
double-click on first launch ("vibedeck can't be opened because Apple
cannot check it for malicious software" or similar). Workaround:
right-click (or Control-click) the app in Finder → **Open** → **Open** in
the confirmation dialog. Only needed once per machine; after that first
approved launch, it opens normally. This is expected for an unsigned
build, not a bug. Windows SmartScreen and most Linux package managers show
an analogous "unknown publisher" warning for the same reason on their
platforms.

## Two ways the packaging step can quietly ship a broken app

Both were found by *using* a relocated build, not by inspecting one. Note
what they have in common: the app starts, serves its whole HTTP API, and
renders the UI in both cases. Nothing short of exercising the actual
feature reveals either.

1. **`spawn-helper` loses its executable bit.** node-pty exec's this binary
   to start every pty, and `pnpm deploy` emits it `-rw-r--r--` where the
   repo has `-rwxr-xr-x`. The result is that every terminal fails with
   `posix_spawnp failed` — the product's entire purpose — while everything
   else looks healthy. `build-server-resources.mjs`'s
   `restoreSpawnHelperPermissions` fixes it. This is the *same* bug the
   root `scripts/fix-native-perms.mjs` postinstall has guarded the repo's
   own `node_modules` against since Phase 1; packaging simply created a
   second place for it to happen.
2. **Packaging prunes the workspace's devDependencies.** `pnpm deploy
   --prod` leaves the repo without `tsc`, `vite` and `vitest`, so the very
   next `pnpm build` or `pnpm test` fails with `tsc: command not found`.
   Recover with `CI=true pnpm install` (the `CI=true` is needed because
   pnpm asks for TTY confirmation before purging `node_modules`). Worth
   knowing before you conclude the build is broken.

**If you change the bundling script, re-verify by spawning a terminal in a
relocated copy** — not by checking that the app opens.

## Known limitations, stated plainly

- **Requires system Node**, not bundled. See "What a user actually needs
  installed." This is the one requirement Phase 11b did NOT remove.
- **Local packaging exits non-zero without the signing key.** `pnpm
  --filter @vibedeck/desktop run package` builds the `.app` and `.dmg`
  fine, then fails at the updater-signing step with "A public key has been
  found, but no private key" — because the key lives in CI, not on your
  machine. The artifacts are still produced and usable. To sign locally,
  export `TAURI_SIGNING_PRIVATE_KEY_PATH=~/.vibedeck/updater.key` first.
- **`resolve_node_dir`'s fallback list is not exhaustive** — notably, nvm's
  per-version directories aren't covered.
- **Fixed port (45317), not dynamically chosen.** Fine for one instance;
  two copies of the desktop app running simultaneously would collide with
  each other (not with `pnpm dev`, which is the case Phase 11a actually
  needed to solve).
- **Unsigned, in the platform code-signing sense.** Gatekeeper's
  first-launch warning (above) is a direct, expected consequence, not a
  bug to fix here. The AUTO-UPDATER'S OWN signing (a separate, unrelated
  keypair — see "Auto-updates" above) is real and required for every
  build.
- **No Windows MSI, only NSIS.** WiX's `light.exe` fails on this app: it
  gets through `candle` and then dies after ~30s with no diagnostic beyond
  "failed to run light.exe". The likely cause is the bundled server's deep
  `node_modules` tree crossing Windows' 260-character `MAX_PATH`, which WiX
  handles badly and NSIS doesn't care about. NSIS is what Tauri recommends
  for Windows and what Windows users expect, so the release builds that
  and skips MSI. Anyone wanting an MSI should expect to solve the path
  lengths first.
- **Only the runner's native architecture per platform.** The release
  workflow's macOS runner is Apple Silicon (`macos-latest`'s default) —
  no separate Intel (`x86_64-apple-darwin`) build. Windows/Linux are
  x86_64. Real cross-compilation (e.g. a universal macOS binary, or ARM
  Linux) is out of this phase's scope.
- **The release workflow itself has never actually run.** It was written
  against the exact commands verified by hand locally (macOS only, the
  only platform available while building this phase) and reviewed
  carefully, but no GitHub Actions runner executed it before this phase
  shipped — see `.github/workflows/release.yml`'s own top comment and the
  "Releasing" section below.
- **Auto-update installs still require the same system Node the base app
  does.** The updater replaces the `.app`/installer itself; it doesn't
  change what the newly-installed version needs to run.
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

## Releasing

How to actually cut a release once `.github/workflows/release.yml` has run
at least once successfully (it hasn't yet — see "Known limitations" above):

1. **Bump the version.** `apps/desktop/src-tauri/tauri.conf.json`'s
   top-level `"version"` field (currently `"0.0.0"`) is what the updater
   compares against — it needs to actually change for `check()` to ever
   report a newer version available. Bump `apps/desktop/package.json`'s
   version too, for consistency (not read by the updater itself, but
   confusing if it drifts from `tauri.conf.json`'s).
2. **Tag and push.** `git tag v0.1.0 && git push origin v0.1.0` — any tag
   matching `v*` triggers the release workflow. `workflow_dispatch` (the
   Actions tab's "Run workflow" button) also works, for re-running a
   release without pushing a new tag; it asks for the tag to release
   explicitly.
3. **Three jobs run in parallel** — macOS, Windows (`ubuntu-22.04` for
   Linux, pinned rather than `ubuntu-latest` — see the workflow's own
   comment for why), each building and signing its own platform's
   installer(s) and contributing them to ONE shared GitHub Release (all
   three jobs use the same `tagName`, which is what `tauri-action` uses to
   find and merge into the same release rather than creating three).
4. **The release is created as a DRAFT**, not published immediately —
   check that all three jobs actually attached their artifacts (a DMG, an
   NSIS, a DEB + RPM + AppImage, plus each platform's signed
   `.tar.gz`/`.zip` updater artifact and a merged `latest.json`) before
   clicking Publish on GitHub.
5. **Existing installs pick up the new version** within `CHECK_INTERVAL_MS`
   (4 hours) of it going live, or immediately on next launch — see
   "Auto-updates" above for the actual UX (never silent, never without a
   click).

**Where the private signing key lives, and what losing it means**:
`~/.vibedeck/updater.key`, outside this repo (never committed, mode 600,
no password), and mirrored as the `TAURI_SIGNING_PRIVATE_KEY` GitHub
Actions secret on this repo — that secret is the ONLY thing
`.github/workflows/release.yml` actually signs releases with; nothing
reads the local file directly in CI. **If this key is lost (not backed up
anywhere, and the GitHub secret is somehow cleared), every already-shipped
installer becomes permanently unable to verify a signature from a
replacement key** — there is no recovery path that updates existing
installs in place; users would need to manually download and reinstall
from a fresh release built with the new keypair. Back this file up
somewhere durable, outside both this repo and the one machine that
currently holds it.

## Architecture reference

| File | Role |
|---|---|
| `apps/desktop/src-tauri/src/main.rs` | Spawns the sidecar (`ServerSource::Bundled` or `::Dev`, see `resolve_server_source`), waits for readiness, navigates the window, builds the menu, registers the updater/process plugins, handles shutdown (three paths — see "Shutdown" above). |
| `apps/desktop/src-tauri/tauri.conf.json` | Window config, icon set, bundle targets (`"all"`), `bundle.resources` (the relocatable server bundle), `bundle.createUpdaterArtifacts`, `plugins.updater` (pubkey + GitHub Releases endpoint). |
| `apps/desktop/scripts/build-server-resources.mjs` | Builds the relocatable server bundle — `pnpm deploy` + the `packages/shared` `package.json` patch + the symlink-flattening fix. See "Relocatable installers" above. |
| `apps/desktop/loading/index.html` | The window's first-shown content — spinner/status page `main.rs` `eval()`s into on error. |
| `apps/server/src/runtime-config.ts` | Pure, unit-tested logic shared by both dev and desktop: `resolveServerPort`, `resolveStaticDir`, `formatReadyLine`/`parseReadyLine`. See `runtime-config.test.ts`. |
| `apps/server/src/index.ts` | Serves `apps/web/dist` as static files when `staticDir` is set (via `@fastify/static`) — makes the server + browser bundle one origin, no Vite proxy. |
| `apps/web/src/keys/keymap.ts` | `matchShortcut`'s `isDesktop` branch (the #48 fix) and `hasDesktopMarker`/`isTauriApp` (desktop-build detection via a URL marker, not `__TAURI_INTERNALS__`). |
| `apps/web/src/shell/updater.ts` | Pure logic behind the update banner — `shouldShowUpdateBanner`, the download-progress reducer, `CHECK_INTERVAL_MS`. Unit-tested (`updater.test.ts`). |
| `apps/web/src/shell/UpdateBanner.tsx` | The actual `check()`/`downloadAndInstall()`/`relaunch()` wiring and UI — a no-op outside the desktop build (`isTauriApp()`-gated). |
| `.github/workflows/release.yml` | Builds and publishes the desktop app on macOS/Windows/Linux runners on a `v*` tag — see "Releasing" above. Never actually run (no CI runner available while building this phase). |
