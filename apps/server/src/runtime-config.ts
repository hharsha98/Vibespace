/**
 * Pure, testable helpers for the three pieces of "how does this server get
 * started" logic that Phase 11a (the Tauri desktop wrapper, see
 * apps/desktop/) needs but that don't belong inlined into index.ts's
 * startup block:
 *
 *   1. Which port to listen on (resolveServerPort) — the desktop app can't
 *      hardcode 4317, because launching it while `pnpm dev` is already
 *      running would collide with the dev server on that exact port.
 *   2. Whether to serve the built web app as static files, and from where
 *      (resolveStaticDir) — there is no Vite in a packaged app.
 *   3. How the desktop app's Rust sidecar wrapper knows the server is
 *      actually ready to accept connections (formatReadyLine /
 *      parseReadyLine) — a fixed stdout line the Node process prints
 *      exactly once, right after `.listen()` resolves, instead of the
 *      wrapper guessing with a sleep or polling a port that might belong
 *      to something else entirely.
 *
 * All three are ordinary functions with injected inputs (env objects, an
 * `exists` check, a module directory string) rather than reading
 * `process.env`/`fs` directly, specifically so they can be unit tested
 * without a real filesystem or a real desktop build — see
 * runtime-config.test.ts. The Rust side (apps/desktop/src-tauri) is
 * deliberately kept "dumb": it just spawns node and greps its stdout for
 * the exact prefix below, so none of that logic needs a Rust test
 * framework, per this phase's own scope (no Rust tests, no
 * browser-dependent tests).
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** The port the server listens on when nothing overrides it — this is the
 * value every existing dev workflow, doc, and test already assumes. */
export const DEFAULT_PORT = 4317;

/**
 * The fixed port the desktop app's Tauri sidecar always sets `VIBEDECK_PORT`
 * to (`apps/desktop/src-tauri/src/main.rs`'s `DESKTOP_PORT` constant — kept
 * in sync with this value by hand, since Rust and TypeScript can't share a
 * literal across the process boundary; grep both if you ever change either
 * one). The `vibedeck` CLI (`./cli/vibedeck.ts`) checks this port, in
 * addition to `resolveServerPort`'s result, when deciding whether a server
 * is already running — a user with the desktop app open already has a
 * perfectly good server + database to reuse, and starting a second one on
 * `DEFAULT_PORT` would be redundant (both would share the same
 * `~/.vibedeck/vibedeck.db`, since the desktop sidecar never overrides
 * `VIBEDECK_DATA_DIR`, but would mean two Fastify processes and two
 * `node-pty` session managers alive at once for no reason).
 */
export const DESKTOP_SIDECAR_PORT = 45317;

/**
 * Resolves the port to listen on: `VIBEDECK_PORT` if it's set to a valid
 * positive integer, otherwise `DEFAULT_PORT`. `pnpm dev`/tests never set
 * this variable, so they get the exact same 4317 as before this phase —
 * only the desktop app's sidecar wrapper sets it (to a different, fixed
 * port — see apps/desktop's README for why 4317 itself is unsafe to reuse:
 * a user could have `pnpm dev` running in a terminal at the same time).
 */
export function resolveServerPort(env: NodeJS.ProcessEnv): number {
  const raw = env.VIBEDECK_PORT;
  if (!raw) return DEFAULT_PORT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) return DEFAULT_PORT;
  return parsed;
}

export interface ResolveStaticDirOptions {
  /** Process env to read `VIBEDECK_STATIC_DIR` from. */
  env: NodeJS.ProcessEnv;
  /** The directory this module itself lives in (`src/` under tsx/vitest,
   * `dist/` after `pnpm build`) — used to locate `apps/web/dist` by
   * relative position when no explicit override is given. Passed in
   * (rather than computed with `import.meta.url` inside this function) so
   * tests can point it at a fixture tree instead of the real repo. */
  moduleDir: string;
  /** Injectable existence check — defaults to `fs.existsSync`. Tests pass a
   * fake so this never touches the real disk. */
  exists?: (path: string) => boolean;
}

/**
 * Decides whether — and from where — to serve the built web app as static
 * files. Returns an absolute directory path, or `null` to mean "don't
 * serve static files at all; behave exactly as before this phase" (the
 * normal `pnpm dev` case, where Vite on :5317 serves the UI and proxies
 * `/api` to this server).
 *
 * Two ways a directory gets chosen:
 *
 *   - `VIBEDECK_STATIC_DIR` is set: use it verbatim. This is what the
 *     desktop sidecar wrapper sets (see apps/desktop/src-tauri/src/main.rs)
 *     — explicit and unambiguous, no guessing. If the directory doesn't
 *     exist, this throws rather than silently falling back to "no UI at
 *     all" — a desktop build that explicitly asked for static serving and
 *     can't find the build it asked for is a packaging bug that should
 *     fail loudly, not serve a blank app.
 *   - Unset: auto-detect `apps/web/dist` by its position relative to this
 *     module (`../../web/dist` — true both from `apps/server/src/` under
 *     tsx and `apps/server/dist/` after `tsc`, since both sit exactly one
 *     level under `apps/server/`). Used only if that directory actually
 *     exists. This makes `node dist/index.js` after a full `pnpm build`
 *     "just work" as a single-origin server with no flags, while leaving
 *     `pnpm dev` untouched — Vite's dev server lives on a different port
 *     entirely, so this server additionally serving a possibly-stale
 *     `apps/web/dist` under :4317 (if one happens to exist on disk from an
 *     earlier `pnpm build`) never affects what `pnpm dev`'s user sees at
 *     :5317.
 */
export function resolveStaticDir(options: ResolveStaticDirOptions): string | null {
  const exists = options.exists ?? existsSync;

  const override = options.env.VIBEDECK_STATIC_DIR;
  if (override) {
    if (!exists(override)) {
      throw new Error(
        `VIBEDECK_STATIC_DIR was set to "${override}", but that directory doesn't exist. ` +
          `Build the web app first (pnpm --filter @vibedeck/web build).`
      );
    }
    return override;
  }

  const autoDetected = resolve(options.moduleDir, "../../web/dist");
  return exists(autoDetected) ? autoDetected : null;
}

/** The exact stdout line prefix the desktop sidecar wrapper looks for.
 * Exported so both `formatReadyLine` and the Rust side's own comment (it
 * can't import this, but points back here) agree on one source of truth. */
export const READY_LINE_PREFIX = "VIBEDECK_SERVER_READY:";

/**
 * The line the server prints to stdout exactly once, right after
 * `.listen()` resolves. Read by apps/desktop's Rust wrapper (a plain
 * substring/line check, not a parser) to know the exact moment it's safe
 * to point the webview at the server — more reliable than a fixed sleep
 * (too slow or too fast depending on the machine) or polling a port with
 * retries (which can't distinguish "not up yet" from "something else is
 * already listening there"). A no-op when the server is run any other way
 * (`pnpm dev`, `node dist/index.js` from a terminal) — nothing reads it.
 */
export function formatReadyLine(port: number): string {
  return `${READY_LINE_PREFIX}${port}`;
}

/**
 * The inverse of `formatReadyLine` — not used by the Rust wrapper (which
 * only needs a substring check), but kept here so the format has one
 * tested round trip and is reusable from Node-side tooling/tests without
 * duplicating the parsing.
 */
export function parseReadyLine(line: string): number | null {
  if (!line.startsWith(READY_LINE_PREFIX)) return null;
  const portText = line.slice(READY_LINE_PREFIX.length).trim();
  const port = Number(portText);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}
