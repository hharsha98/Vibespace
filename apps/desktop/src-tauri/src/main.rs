// Prevents an extra console window from popping up alongside the app on
// Windows release builds — standard Tauri boilerplate, harmless (a no-op)
// on the macOS build this phase actually targets and tests.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! vibedeck's desktop wrapper (Phase 11a, PARITY #50, closes #48).
//!
//! # The central problem this file exists to solve
//!
//! vibedeck's backend (apps/server) is a Node process with two native
//! addons — `node-pty` and `better-sqlite3` — that cannot be rewritten in
//! Rust. So this Tauri app does not reimplement the server; it spawns the
//! REAL Node server as a child process ("sidecar"), waits for it to answer,
//! and points this window's webview at it. Tauri owns the native window
//! chrome (dock icon, menu bar, real ⌘N/⌘W/⌘T — see keymap.ts); Node still
//! owns everything the browser build already owned.
//!
//! # What this build actually requires on the machine running it
//!
//! **Updated by Phase 11b (PARITY #52).** A *packaged* build (`tauri
//! build` — the DMG/NSIS/DEB/RPM/AppImage a user actually installs) is now
//! relocatable: `resolve_server_source` below prefers a self-contained
//! server bundle shipped inside the app's own resources (built by
//! `apps/desktop/scripts/build-server-resources.mjs`, see that file's top
//! comment for how it sidesteps the `packages/shared` resolution bug
//! described below WITHOUT touching that package's real `package.json` —
//! the live monorepo's dev/test resolution is completely untouched). Only
//! `cargo tauri dev` (this crate compiled straight from a checkout, no
//! bundling step) still falls back to the ORIGINAL Phase 11a mechanism:
//! running `tsx` against `apps/server/src` inside `repo_root()`, tied to
//! that one checkout. One real requirement remains in BOTH modes, stated
//! plainly (see docs/DESKTOP.md for the full explanation):
//!
//!  - **System Node 22+ on PATH or in one of `resolve_node_dir`'s fallback
//!    locations.** No Node runtime is bundled into the .app — that's a
//!    genuinely bigger undertaking (embedding a ~100MB+ per-platform Node
//!    binary) this phase didn't take on. This is the exact same
//!    requirement the browser build already has for `pnpm dev`.
//!
//! # The `packages/shared` resolution bug, and how the bundle avoids it
//!
//! `apps/server/package.json`'s "start" script (`node dist/index.js`) is
//! broken standalone: `packages/shared`'s `package.json` `main` field
//! points at its TypeScript SOURCE (`./src/index.ts`), which only resolves
//! correctly when something in the require/import chain transpiles on the
//! fly (`tsx`, Vite, Vitest all do; plain `node` does not) — confirmed by
//! hand while building Phase 11a, and the reason that phase ran the server
//! via `tsx` against source instead. Phase 11b's `build-server-resources.mjs`
//! fixes this for the PACKAGED artifact only: it runs `pnpm deploy` to get
//! a real, dereferenced copy of `apps/server` + its production
//! dependencies (not a symlink into the live monorepo — verified by hand:
//! `pnpm deploy --legacy`'s target is a fully independent directory tree),
//! then patches ONLY that deployed copy's `@vibedeck/shared/package.json`
//! to point `main`/`types` at its own already-built `dist/`. The live
//! `packages/shared/package.json` in the actual monorepo is never touched
//! — every other consumer (`pnpm dev`, Vite, Vitest, `tsx`) keeps resolving
//! it exactly as before. See that script's own comments for the one sharp
//! edge this fix had to work around: pnpm's content-addressable store can
//! hardlink even local workspace-package files into a deploy target, so
//! the patch step explicitly unlinks before writing — a plain in-place
//! write risked silently mutating the real source file through the shared
//! inode (caught by hand while building this phase).

use std::collections::VecDeque;
use std::env;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, ChildStderr, ChildStdout, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;
#[cfg(unix)]
use std::time::Instant;

use tauri::menu::{MenuBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{Manager, WebviewWindow};
use url::Url;

/// The port the desktop app's sidecar server listens on. Deliberately NOT
/// 4317 (apps/server's own default, read by `resolveServerPort` in
/// runtime-config.ts when `VIBEDECK_PORT` is unset): launching the desktop
/// app while `pnpm dev` is already running in a terminal is a completely
/// normal thing to do while developing vibedeck itself, and both would try
/// to bind 4317 if this used the same value. 45317 was picked to visually
/// pair with the two ports the browser build already uses side by side —
/// :4317 (server) and :5317 (Vite) — rather than being an arbitrary number;
/// it isn't registered for anything else and collides with neither.
const DESKTOP_PORT: u16 = 45317;

/// Must match `READY_LINE_PREFIX` in apps/server/src/runtime-config.ts
/// EXACTLY — the two sides can't share a constant across the
/// Rust/TypeScript boundary, so this comment is the tether between them.
/// If you change one, change the other.
const READY_LINE_PREFIX: &str = "VIBEDECK_SERVER_READY:";

/// How long to wait for the ready line before giving up and showing an
/// error instead of an indefinitely spinning loading screen. Generous
/// (vs. the ~1-2s this actually takes on a warm machine — see
/// docs/DESKTOP.md's own measurement) to cover a cold `tsx`/esbuild first
/// run without making a genuine failure feel like it's still "just slow".
const READY_TIMEOUT: Duration = Duration::from_secs(20);

/// How many trailing stderr lines from the server to keep around for the
/// error page if startup fails — enough to be useful, not so much that a
/// runaway logger turns the error page into a wall of text.
const STDERR_TAIL_LINES: usize = 20;

/// Shared handle to the running server child process, managed as Tauri app
/// state so both the window-close handler and the app-exit handler (see
/// `main`'s `.on_window_event` / `.run` — belt and suspenders, see
/// `kill_server`'s doc comment for why both) can reach it. `None` means
/// "never started" or "already killed" — `kill_server` is written to be
/// safely callable from both places even if the other one got there first.
type ServerState = Arc<Mutex<Option<Child>>>;

/// What `watch_server`'s background thread found out about the server it's
/// watching, sent back to the thread that's waiting to either navigate the
/// window or show an error.
enum ServerStartup {
    /// The ready line appeared on stdout — here's the port it named.
    Ready(u16),
    /// stdout closed (the process exited) before the ready line ever
    /// appeared. Carries the last few stderr lines, if any, for the error
    /// page — see `STDERR_TAIL_LINES`.
    Exited(String),
}

/// The repo checkout this binary was built from, resolved at COMPILE time
/// from `CARGO_MANIFEST_DIR` (which `cargo`/`tauri` always sets to the
/// directory containing this crate's Cargo.toml: `apps/desktop/src-tauri`).
/// Three levels up lands on the repo root — see this file's top doc
/// comment for why baking in a path at compile time is this phase's
/// deliberate, documented v1 trade-off rather than an oversight.
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect(
            "repo root (three directories above apps/desktop/src-tauri) must exist — \
             this binary was built from a vibedeck checkout that has since moved or been deleted",
        )
}

/// Finds a directory containing an executable named `node`, trying (in
/// order): every directory already on `PATH`, then a short list of common
/// fixed install locations. The second half exists specifically for the
/// double-click-from-Finder launch path: a macOS GUI app gets a minimal
/// PATH (typically just `/usr/bin:/bin:/usr/sbin:/sbin`) that doesn't
/// include wherever Homebrew, a version manager, or a manual install put
/// Node — `cargo tauri dev` run from a terminal doesn't have this problem
/// (step 1 alone finds it), which is exactly why this bug is easy to miss
/// in dev and only shows up in the packaged .app.
///
/// This list is NOT exhaustive — nvm's per-version directories in
/// particular aren't covered, since there's no single fixed path to check
/// (it depends which version is "current"). See docs/DESKTOP.md's
/// limitations section for the honest version of this comment: if your
/// Node lives somewhere this function doesn't check, the app will show a
/// clear error (via `spawn_server`'s `Err` branch in `main`'s `.setup`)
/// rather than fail silently — but it also won't have found Node.
fn resolve_node_dir() -> Option<PathBuf> {
    if let Some(path_var) = env::var_os("PATH") {
        for dir in env::split_paths(&path_var) {
            if dir.join("node").is_file() {
                return Some(dir);
            }
        }
    }

    let mut fallback_candidates = vec![
        PathBuf::from("/opt/homebrew/bin"), // Homebrew on Apple Silicon
        PathBuf::from("/usr/local/bin"),    // Homebrew on Intel; many manual installs
    ];
    if let Some(home) = env::var_os("HOME") {
        // ~/.local/bin: where this exact dev machine's `node` actually
        // lives (confirmed via `which node` while building this phase) —
        // included specifically, not just as a generic guess.
        fallback_candidates.push(PathBuf::from(&home).join(".local/bin"));
        fallback_candidates.push(PathBuf::from(&home).join(".volta/bin"));
    }
    fallback_candidates.into_iter().find(|dir| dir.join("node").is_file())
}

/// Where `spawn_server` should run the vibedeck server FROM — resolved once
/// per app launch by `resolve_server_source`, below. Two variants, checked
/// in that order:
///
///  - `Bundled`: a packaged build (`tauri build`) shipping a self-contained
///    server (see `apps/desktop/scripts/build-server-resources.mjs`) inside
///    the app's own resources. Relocatable — nothing here points back at
///    the machine/checkout that built it.
///  - `Dev`: no bundled resources found (i.e. `cargo tauri dev`, run
///    straight from a checkout with no packaging step) — falls back to
///    Phase 11a's original mechanism, `tsx` against `apps/server/src`
///    inside `repo_root()`. This is the ONLY mode still tied to one
///    checkout's path; see this file's top doc comment.
enum ServerSource {
    Bundled { server_dir: PathBuf, static_dir: PathBuf },
    Dev { repo_root: PathBuf },
}

/// Decides which `ServerSource` this launch should use. `app.path()` (via
/// the `Manager` trait, already imported) resolves to the OS-appropriate
/// resources location for a packaged build (e.g. `VibeDeck.app/Contents/
/// Resources` on macOS) — but ALSO resolves to *something* during `cargo
/// tauri dev` (typically a debug target directory), where our bundle was
/// never copied. Rather than trying to distinguish "packaged" from "dev" by
/// asking Tauri, this just checks whether the one file `spawn_server` would
/// actually need (`server-bundle/dist/index.js`) exists at that location —
/// an honest, self-verifying check that can't drift out of sync with
/// reality the way an `#[cfg(...)]`-based guess could.
fn resolve_server_source(app: &tauri::App) -> ServerSource {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundle_dir = resource_dir.join("resources").join("server-bundle");
        let entry = bundle_dir.join("dist").join("index.js");
        let static_dir = resource_dir.join("resources").join("web");
        if entry.is_file() {
            return ServerSource::Bundled { server_dir: bundle_dir, static_dir };
        }
    }
    ServerSource::Dev { repo_root: repo_root() }
}

/// Spawns the real vibedeck server as a child process. Two paths, matching
/// `ServerSource`'s two variants:
///
///  - `Bundled`: runs `node dist/index.js` directly against the
///    self-contained, relocatable copy `build-server-resources.mjs`
///    produced (real files, not symlinks into the machine that built it —
///    see this file's top doc comment). `current_dir` is set to the bundle
///    root specifically so Node's own module resolution walks UP from
///    there and finds the bundle's own `node_modules` (holding
///    `better-sqlite3`/`node-pty` with correctly-built native binaries for
///    this platform) rather than any other `node_modules` that happens to
///    be an ancestor of wherever the app binary itself lives.
///  - `Dev`: unchanged from Phase 11a — `tsx` against `apps/server/src`,
///    proven to work by hand (see `ServerSource::Dev`'s doc comment).
///
/// Both paths need to actually find a `node` binary the same way (a
/// Finder-launched .app's minimal PATH doesn't include wherever Homebrew or
/// a version manager put it) — `resolve_node_dir` below is shared between
/// them.
fn spawn_server(source: &ServerSource) -> std::io::Result<Child> {
    match source {
        ServerSource::Bundled { server_dir, static_dir } => {
            // Unlike the Dev path's `tsx` shim (which does its OWN internal
            // `command -v node` PATH lookup once spawned), here WE are the
            // ones invoking `node` directly — so the executable path itself
            // has to be resolved before spawning, not handed off via a PATH
            // env var and hoped for. Using the full resolved path (rather
            // than relying on `Command::new("node")` + an env PATH override)
            // sidesteps any ambiguity about whether Rust's `Command` PATH
            // search honours an explicitly-set child env var at spawn time
            // versus the parent process's own inherited PATH — this way
            // there's nothing to be ambiguous about.
            let node_bin = resolve_node_dir()
                .map(|dir| dir.join("node"))
                .unwrap_or_else(|| PathBuf::from("node"));

            Command::new(node_bin)
                .arg(server_dir.join("dist").join("index.js"))
                .current_dir(server_dir)
                .env("VIBEDECK_PORT", DESKTOP_PORT.to_string())
                .env("VIBEDECK_STATIC_DIR", static_dir)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .stdin(Stdio::null())
                .spawn()
        }
        ServerSource::Dev { repo_root } => {
            let server_dir = repo_root.join("apps/server");
            let tsx_bin = server_dir.join("node_modules/.bin/tsx");
            let static_dir = repo_root.join("apps/web/dist");

            let mut command = Command::new(&tsx_bin);
            command
                .arg("src/index.ts")
                .current_dir(&server_dir)
                .env("VIBEDECK_PORT", DESKTOP_PORT.to_string())
                .env("VIBEDECK_STATIC_DIR", &static_dir)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .stdin(Stdio::null());

            // apps/server/node_modules/.bin/tsx is itself a `#!/bin/sh` shim
            // that falls back to `command -v node` on PATH if it can't find
            // a `node` binary sitting right next to it (read by hand while
            // building this phase — it's a standard pnpm-generated bin
            // shim). So what actually determines whether Node gets found on
            // a Finder-launched .app is whether the PATH override below
            // succeeds — NOT whether `node` itself is directly reachable
            // some other way.
            if let Some(node_dir) = resolve_node_dir() {
                let existing_path = env::var("PATH").unwrap_or_default();
                command.env("PATH", format!("{}:{existing_path}", node_dir.display()));
            }
            // else: leave PATH untouched. The spawn below will very likely
            // still succeed (spawning the shell script itself doesn't
            // require Node), but the script's own internal `node` lookup
            // will then fail and it will exit immediately with a real error
            // on stderr — which flows back through `watch_server`'s
            // `ServerStartup::Exited` path and is shown to the user, not
            // swallowed.

            command.spawn()
        }
    }
}

/// The inverse of `formatReadyLine` in apps/server/src/runtime-config.ts —
/// deliberately re-implemented here rather than shared, since Rust and
/// TypeScript can't share a function across that boundary. Kept as dumb as
/// possible on purpose (a prefix strip + parse, nothing more) — this
/// phase's own scope note says no Rust test framework, so the Rust side of
/// any shared logic stays this thin by design; the interesting, tested
/// logic lives once, on the TypeScript side that formats the line.
fn parse_ready_line(line: &str) -> Option<u16> {
    line.strip_prefix(READY_LINE_PREFIX)?.trim().parse().ok()
}

/// Runs on its own background thread for the lifetime of one server
/// startup attempt. Drains `stderr` concurrently (on a second thread) into
/// a capped tail buffer — both so a chatty process can't fill the OS pipe
/// buffer and block itself waiting for a reader that's busy elsewhere, and
/// so a startup failure's error page can show what the server actually
/// said. Reads `stdout` line by line looking for the ready line; reports
/// back over `tx` either way stdout can end (ready line seen, or the pipe
/// just closed because the process exited).
fn watch_server(stdout: ChildStdout, stderr: ChildStderr, tx: mpsc::Sender<ServerStartup>) {
    let stderr_tail: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
    {
        let stderr_tail = Arc::clone(&stderr_tail);
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let mut tail = stderr_tail.lock().unwrap();
                if tail.len() >= STDERR_TAIL_LINES {
                    tail.pop_front();
                }
                tail.push_back(line);
            }
        });
    }

    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        if let Some(port) = parse_ready_line(&line) {
            let _ = tx.send(ServerStartup::Ready(port));
            return;
        }
    }

    // stdout closed without ever printing the ready line — the process
    // exited (crashed, or `tsx`/`node` couldn't even start).
    let tail = stderr_tail
        .lock()
        .unwrap()
        .iter()
        .cloned()
        .collect::<Vec<_>>()
        .join("\n");
    let _ = tx.send(ServerStartup::Exited(tail));
}

/// Replaces the loading page's status text with an error message and hides
/// its spinner — see apps/desktop/loading/index.html's own top comment for
/// why that page exists at all. `serde_json::to_string` on the message
/// gives us a correctly-escaped JS string literal for free (quotes,
/// newlines, everything) instead of hand-rolling escaping for `eval`.
fn show_error(window: &WebviewWindow, message: &str) {
    let js_message =
        serde_json::to_string(message).unwrap_or_else(|_| "\"(error message could not be encoded)\"".into());
    let script = format!(
        "(function(){{\
           var s = document.getElementById('status');\
           var sp = document.getElementById('spinner');\
           if (s) {{ s.textContent = {js_message}; s.classList.add('error'); }}\
           if (sp) {{ sp.style.display = 'none'; }}\
         }})();"
    );
    let _ = window.eval(&script);
}

/// Shuts the sidecar server down. Called from TWO places in `main`
/// (`.on_window_event`'s `CloseRequested` AND `.run`'s `RunEvent::Exit`) —
/// belt and suspenders, because on macOS closing the last window and fully
/// quitting the app (Cmd+Q, or the Dock menu's Quit) are different events,
/// and a leaked Node process still holding the desktop port after the user
/// thinks they've quit is exactly the bug this phase was told to catch and
/// test, not just handle one way and hope. Safe to call twice — `.take()`
/// makes the second call a no-op (`None`, nothing to do).
fn kill_server(state: &ServerState) {
    let mut guard = state.lock().unwrap();
    let Some(mut child) = guard.take() else {
        return;
    };
    drop(guard);

    #[cfg(unix)]
    {
        // SIGTERM first, not straight to SIGKILL: apps/server/src/index.ts
        // already handles SIGTERM (see its own `shutdown` function) by
        // calling `app.close()`, which disposes every pty session AND
        // closes the SQLite handle before the process actually exits. A
        // bare SIGKILL would skip all of that — not just leaving the port
        // held, but potentially leaving orphaned shell/agent child
        // processes behind too.
        unsafe {
            libc::kill(child.id() as i32, libc::SIGTERM);
        }
        // Poll rather than a blocking `wait()` with no timeout: give the
        // graceful path above a real chance to run, but don't let a slow
        // shutdown (node-pty's native teardown, in particular) block the
        // app from actually quitting.
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return, // exited on its own — the common case
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(100)),
                _ => break, // still alive past the deadline, or try_wait itself errored
            }
        }
    }

    // Either not unix, or the graceful path above didn't finish in time.
    let _ = child.kill();
    let _ = child.wait();
}

/// Hardens against exactly the leaked-process bug this phase called out by
/// name: a bare `SIGTERM` sent straight to this process (`kill <pid>`,
/// `pkill vibedeck`, a process manager) bypasses Tauri's own event loop
/// entirely — neither `on_window_event`'s `CloseRequested` nor `.run`'s
/// `RunEvent::Exit` fire, because those only cover the normal GUI
/// termination lifecycle (window close, Cmd+Q, Dock > Quit), not raw Unix
/// signals. Confirmed by hand while building this phase: `kill`-ing the
/// dev binary directly left the sidecar Node process running, still
/// holding its port. `signal_hook::iterator::Signals::forever()` blocks on
/// an ordinary background thread — NOT inside actual signal-handler
/// context, where taking `state`'s mutex lock would be unsound (signal
/// handlers must be async-signal-safe; a blocking mutex lock is not) — so
/// calling `kill_server` from it is safe.
#[cfg(unix)]
fn install_signal_handler(state: ServerState) {
    use signal_hook::consts::{SIGINT, SIGTERM};
    use signal_hook::iterator::Signals;

    let Ok(mut signals) = Signals::new([SIGTERM, SIGINT]) else {
        return; // Best-effort — the normal GUI quit paths still work without this.
    };
    thread::spawn(move || {
        if signals.forever().next().is_some() {
            kill_server(&state);
            std::process::exit(0);
        }
    });
}

fn main() {
    let server_state: ServerState = Arc::new(Mutex::new(None));

    #[cfg(unix)]
    install_signal_handler(Arc::clone(&server_state));

    tauri::Builder::default()
        // Tauri's built-in default macOS menu includes a "Close Window"
        // item bound to the standard ⌘W accelerator (PredefinedMenuItem's
        // `close_window`) — which would intercept ⌘W at the OS level and
        // close the WHOLE WINDOW, never reaching the webview at all. That
        // directly fights this phase's own goal: ⌘W (no Shift) is supposed
        // to close the focused PANE (see keymap.ts's `DESKTOP_PLAIN_FORM_IDS`),
        // not the window. Disabled so `setup` below can build a menu that
        // deliberately leaves ⌘N/⌘W/⌘T unbound as real accelerators — see
        // that menu's own comment for the full reasoning.
        .enable_macos_default_menu(false)
        // Phase 11b (PARITY #51): the updater plugin only CHECKS/downloads/
        // installs when the web app (running desktop-detected via
        // `?vibedeckDesktop=1`, same marker as everywhere else) explicitly
        // asks it to — see apps/web/src/shell/UpdateBanner.tsx for the
        // actual check-on-startup-then-ask-before-restarting UX and why a
        // silent auto-restart would be actively harmful here (this app
        // hosts long-lived terminal sessions with real, unsaved agent work
        // running in them). Registering the plugin here only makes the
        // JS-side `check()`/`downloadAndInstall()`/relaunch APIs available
        // — it does not, by itself, check or install anything.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // The updater's JS side calls `@tauri-apps/plugin-process`'s
        // `relaunch()` after a user-approved install — Tauri splits
        // "restart the app" into its own small plugin rather than folding
        // it into core, so it has to be registered explicitly too.
        .plugin(tauri_plugin_process::init())
        .manage(server_state)
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .expect("the \"main\" window is declared in tauri.conf.json");
            let server_source = resolve_server_source(app);

            match spawn_server(&server_source) {
                Ok(mut child) => {
                    let stdout = child.stdout.take().expect("stdout was configured as piped");
                    let stderr = child.stderr.take().expect("stderr was configured as piped");
                    *app.state::<ServerState>().lock().unwrap() = Some(child);

                    let (tx, rx) = mpsc::channel();
                    thread::spawn(move || watch_server(stdout, stderr, tx));

                    let window_for_wait = window.clone();
                    thread::spawn(move || match rx.recv_timeout(READY_TIMEOUT) {
                        Ok(ServerStartup::Ready(port)) => {
                            // ?vibedeckDesktop=1 is how the served app tells
                            // apart the desktop build from the ordinary
                            // browser build — see keymap.ts's
                            // `hasDesktopMarker` for why a URL marker WE
                            // control, rather than relying on Tauri's
                            // `__TAURI_INTERNALS__` surviving navigation to
                            // a non-tauri:// origin (uncertain enough that
                            // betting the desktop shortcut fix on it felt
                            // wrong).
                            let url_string = format!("http://127.0.0.1:{port}/?vibedeckDesktop=1");
                            match Url::parse(&url_string) {
                                Ok(url) => {
                                    let _ = window_for_wait.navigate(url);
                                }
                                Err(err) => show_error(
                                    &window_for_wait,
                                    &format!("Internal error building the server URL: {err}"),
                                ),
                            }
                        }
                        Ok(ServerStartup::Exited(stderr_tail)) => show_error(
                            &window_for_wait,
                            &format!(
                                "The vibedeck server exited before it was ready.\n\n{}",
                                if stderr_tail.is_empty() {
                                    "(it printed nothing to stderr)".to_string()
                                } else {
                                    stderr_tail
                                }
                            ),
                        ),
                        Err(_) => show_error(
                            &window_for_wait,
                            &format!(
                                "Timed out after {}s waiting for the vibedeck server to start.\n\n\
                                 Make sure Node.js 22+ is installed, then quit and relaunch vibedeck. \
                                 See docs/DESKTOP.md if this keeps happening.",
                                READY_TIMEOUT.as_secs()
                            ),
                        ),
                    });
                }
                Err(err) => {
                    show_error(
                        &window,
                        &format!(
                            "Couldn't start the vibedeck server: {err}\n\n\
                             Make sure Node.js 22+ is installed and on your PATH. \
                             See docs/DESKTOP.md for what this build actually requires.",
                        ),
                    );
                }
            }

            // --- Native menu -------------------------------------------
            // See the `.enable_macos_default_menu(false)` comment above for
            // why the built-in default menu is off. This one is
            // deliberately minimal: it exists for discoverability (a menu
            // bar with nothing in it looks broken) and — for the three
            // Pane items — as a SECOND way to trigger the same three
            // shortcuts Phase 11a recovers from Chrome, not a
            // native-accelerator implementation of them. None of the Pane
            // items below set an `accelerator`: doing so would make the OS
            // intercept the keypress before the webview's own keydown
            // listener (useKeyboardShortcuts.ts) ever sees it, which would
            // make `matchShortcut`'s new `isDesktop` branch (the actual fix
            // for #48) unreachable. Clicking a Pane item instead simulates
            // the exact keydown the physical shortcut would have produced
            // (see `.on_menu_event` below), so both paths run through the
            // one real implementation.
            let handle = app.handle();

            let app_menu = SubmenuBuilder::new(handle, "vibedeck")
                .item(&PredefinedMenuItem::about(handle, None, None)?)
                .separator()
                .item(&PredefinedMenuItem::quit(handle, None)?)
                .build()?;

            // Undo/Redo/Cut/Copy/Paste only — deliberately NOT
            // `PredefinedMenuItem::select_all` (default accelerator ⌘A,
            // which is vibedeck's OWN "View: Agents" shortcut — see
            // keymap.ts's KEYMAP) and NOT `::close_window` (⌘W — see the
            // `.enable_macos_default_menu` comment above for why that one
            // specifically had to go). Every accelerator that IS set below
            // (⌘Z, ⇧⌘Z, ⌘X, ⌘C, ⌘V) was checked against KEYMAP and none of
            // those letters are bound to anything in vibedeck.
            let edit_menu = SubmenuBuilder::new(handle, "Edit")
                .item(&PredefinedMenuItem::undo(handle, None)?)
                .item(&PredefinedMenuItem::redo(handle, None)?)
                .separator()
                .item(&PredefinedMenuItem::cut(handle, None)?)
                .item(&PredefinedMenuItem::copy(handle, None)?)
                .item(&PredefinedMenuItem::paste(handle, None)?)
                .build()?;

            let pane_menu = SubmenuBuilder::new(handle, "Pane")
                .text("vibedeck-new-pane", "New Pane                     ⌘N")
                .text("vibedeck-close-pane", "Close Pane                   ⌘W")
                .separator()
                .text("vibedeck-theme-picker", "Theme Picker                 ⌘T")
                .build()?;

            let menu = MenuBuilder::new(handle)
                .item(&app_menu)
                .item(&edit_menu)
                .item(&pane_menu)
                .build()?;
            app.set_menu(menu)?;

            app.on_menu_event(move |app, event| {
                // Maps a Pane menu click to the plain KeyboardEvent that
                // pressing the real shortcut would have produced —
                // dispatched into the SAME window's `window`, so it goes
                // through useKeyboardShortcuts.ts's one real listener
                // instead of a second, parallel implementation of "new
                // pane"/"close pane"/"theme picker".
                let key = match event.id().as_ref() {
                    "vibedeck-new-pane" => Some("n"),
                    "vibedeck-close-pane" => Some("w"),
                    "vibedeck-theme-picker" => Some("t"),
                    _ => None,
                };
                if let Some(key) = key {
                    if let Some(window) = app.get_webview_window("main") {
                        let script = format!(
                            "window.dispatchEvent(new KeyboardEvent('keydown',{{key:{},metaKey:true,bubbles:true}}));",
                            serde_json::to_string(key).unwrap_or_else(|_| "\"\"".into())
                        );
                        let _ = window.eval(&script);
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                kill_server(&window.app_handle().state::<ServerState>());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the vibedeck desktop app")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                kill_server(&app_handle.state::<ServerState>());
            }
        });
}
