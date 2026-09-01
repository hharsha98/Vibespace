#!/usr/bin/env node
/**
 * The runnable `vibespace` bin entry — `node dist/cli/bin.js [path]` after
 * `pnpm build` (what the `"vibespace"` field in package.json's `bin` points
 * at), or `pnpm --filter @vibespace/server exec vibespace [path]` once pnpm
 * has linked that bin. All the actual decision-making lives in
 * `./vibespace.ts`'s `runVibespaceCli` (unit-testable with fake deps, no real
 * process/network involved); this file's only job is wiring REAL
 * implementations of those deps — an actual `fetch`, an actual detached
 * `child_process.spawn`, an actual platform "open a URL" command — and
 * translating the returned exit code into `process.exitCode`. Same
 * thin-wrapper split `memory/mcp-server.ts` uses for `memory/mcp.ts`.
 *
 * NOT registered on the user's PATH by anything in this repo — per this
 * phase's own constraints, that's the user's own machine to change (see
 * the README section this ships alongside for how they'd do it themselves,
 * e.g. `pnpm link` or adding `node_modules/.bin` to `PATH`).
 */
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRootPath } from "../workspace-path.js";
import { resolveServerPort, DESKTOP_SIDECAR_PORT } from "../runtime-config.js";
import { runVibespaceCli, ensureWorkspace, type VibespaceCliDeps } from "./vibespace.js";

/** Fetches `/api/health` with a short timeout — used both to decide "is a
 * server already up on this port" and, while waiting for a freshly-started
 * one, "is it up YET". A short per-attempt timeout (not the overall
 * `CLI_SERVER_START_TIMEOUT_MS` budget) means one slow/hung attempt can't
 * eat the whole startup budget by itself. */
async function isServerUpReal(port: number): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_000);
  try {
    const res = await fetch(`http://localhost:${port}/api/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForServerUpReal(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isServerUpReal(port)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/**
 * Spawns `dist/index.js` (this CLI's own sibling once built — see the
 * package layout comment below) as a detached, backgrounded process, the
 * same "just run node on the built server" a plain `node dist/index.js`
 * deployment does. `VIBESPACE_PORT` is set explicitly to `port` even though
 * it usually already resolves to the same default — makes the spawned
 * process's port a hard guarantee rather than "whatever it happens to
 * compute", in case `bin.ts` and the spawned server ever see a different
 * environment for any reason.
 *
 * `detached: true` + `child.unref()` is what lets the started server
 * outlive THIS short-lived CLI process — `vibespace .` should hand off to a
 * long-running server and exit, not stay attached to it like a foreground
 * `pnpm dev` would.
 */
function startServerReal(port: number): void {
  // This file lives at `dist/cli/bin.js` after `pnpm build` (mirrors
  // `src/cli/bin.ts`'s position under `src/`) — `dist/index.js` is one
  // level up and one dir over, i.e. `../index.js` relative to this file.
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const serverEntry = resolve(moduleDir, "../index.js");
  if (!existsSync(serverEntry)) {
    throw new Error(
      `Cannot find the built server at "${serverEntry}". Run "pnpm --filter @vibespace/server build" first ` +
        `(the vibespace CLI needs a built server to start — it doesn't run one from TypeScript source).`
    );
  }
  const child = spawn(process.execPath, [serverEntry], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, VIBESPACE_PORT: String(port) },
  });
  child.unref();
}

/**
 * Opens `url` in the system's default browser. There is no cross-platform
 * "open a URL" API in Node itself and this phase's constraints forbid
 * installing a package (e.g. the popular `open` npm package) for it — so
 * this shells out to the OS-native opener command instead: `open` on
 * macOS, `cmd /c start` on Windows (the empty `""` title argument works
 * around `start`'s own quirk of treating a quoted first argument as a
 * window title rather than the thing to open), `xdg-open` on Linux/BSD.
 * Failure to launch a browser (missing command, no display, headless box)
 * is caught and swallowed rather than failing the whole CLI — the URL was
 * already printed to stdout by `runVibespaceCli`, so the user can still open
 * it by hand; the workspace itself was already created/found either way.
 */
async function openUrlReal(url: string): Promise<void> {
  const platform = process.platform;
  const [command, args] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["cmd", ["/c", "start", '""', url]]
        : ["xdg-open", [url]];

  await new Promise<void>((resolvePromise) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => resolvePromise()); // opener not found — non-fatal, see doc comment above.
    child.on("spawn", () => resolvePromise());
    child.unref();
  });
}

async function main(): Promise<void> {
  const defaultPort = resolveServerPort(process.env);
  // De-duped in case VIBESPACE_PORT happens to already equal the desktop
  // sidecar's port (unlikely, but `new Set` makes it harmless either way).
  const candidatePorts = [...new Set([defaultPort, DESKTOP_SIDECAR_PORT])];

  const deps: VibespaceCliDeps = {
    resolvePath: resolveRootPath,
    candidatePorts,
    defaultPort,
    isServerUp: isServerUpReal,
    startServer: startServerReal,
    waitForServerUp: waitForServerUpReal,
    ensureWorkspace,
    openUrl: openUrlReal,
    log: (message) => console.log(message),
    logError: (message) => console.error(message),
  };

  process.exitCode = await runVibespaceCli(process.argv.slice(2), deps);
}

main().catch((err: unknown) => {
  console.error("vibespace: fatal error", err);
  process.exitCode = 1;
});
