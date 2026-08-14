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
//! This is NOT a self-contained, relocatable app. Two real requirements,
//! stated plainly (see docs/DESKTOP.md for the full explanation):
//!
//!  1. **System Node 22+ on PATH or in one of `resolve_node_dir`'s fallback
//!     locations.** No Node runtime is bundled into the .app. This is the
//!     exact same requirement the browser build already has for `pnpm dev`
//!     — Phase 11a doesn't add a new dependency, it just needs to *find*
//!     the same Node a terminal-launched shell would.
//!  2. **The vibedeck repo checkout this app was built from must still
//!     exist at the same path on disk.** `repo_root()` bakes in an
//!     absolute path at COMPILE time (`env!("CARGO_MANIFEST_DIR")`) and
//!     runs the server from THERE via `tsx` against its TypeScript source
//!     — not from a bundled, compiled copy inside the .app. Why: the
//!     server's own `apps/server/package.json` "start" script
//!     (`node dist/index.js`) turns out to already be broken standalone —
//!     `packages/shared`'s `package.json` `main` field points at its
//!     TypeScript SOURCE (`./src/index.ts`), which only resolves correctly
//!     when something in the chain transpiles on the fly (`tsx`, Vite,
//!     Vitest all do; plain `node` does not). That's a pre-existing
//!     monorepo convention this phase didn't introduce and — given the
//!     blast radius of changing how every package in the workspace
//!     resolves `@vibedeck/shared` — deliberately didn't try to fix here.
//!     Running via `tsx` against source sidesteps it entirely, at the cost
//!     of tying this build to one machine's checkout. Real, portable
//!     packaging (a relocatable bundle, or a proper fix to the shared
//!     package's resolution) is Phase 11b's job, not this one's.

use std::collections::VecDeque;
use std::env;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
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

/// Spawns the real vibedeck server as a child process, running its
/// TypeScript source directly via the `tsx` binary already sitting in
/// apps/server's own `node_modules/.bin` (the exact same mechanism `pnpm
/// dev`'s `tsx watch src/index.ts` uses — proven to work by hand while
/// building this phase, including with `VIBEDECK_STATIC_DIR` set). See this
/// file's top doc comment for why source-via-tsx instead of the compiled
/// `dist/index.js`.
fn spawn_server(repo_root: &Path) -> std::io::Result<Child> {
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

    // apps/server/node_modules/.bin/tsx is itself a `#!/bin/sh` shim that
    // falls back to `command -v node` on PATH if it can't find a `node`
    // binary sitting right next to it (read by hand while building this
    // phase — it's a standard pnpm-generated bin shim). So what actually
    // determines whether Node gets found on a Finder-launched .app is
    // whether the PATH override below succeeds — NOT whether `node` itself
    // is directly reachable some other way.
    if let Some(node_dir) = resolve_node_dir() {
        let existing_path = env::var("PATH").unwrap_or_default();
        command.env("PATH", format!("{}:{existing_path}", node_dir.display()));
    }
    // else: leave PATH untouched. The spawn below will very likely still
    // succeed (spawning the shell script itself doesn't require Node), but
    // the script's own internal `node` lookup will then fail and it will
    // exit immediately with a real error on stderr — which flows back
    // through `watch_server`'s `ServerStartup::Exited` path and is shown to
    // the user, not swallowed.

    command.spawn()
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
        .manage(server_state)
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .expect("the \"main\" window is declared in tauri.conf.json");
            let repo_root = repo_root();

            match spawn_server(&repo_root) {
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
