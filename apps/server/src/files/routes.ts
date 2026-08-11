/**
 * The file tree / editor / preview endpoints (Phase 6). Every handler here
 * takes a `workspaceId` (looked up via `WorkspaceStore`, same as the
 * session/workspace routes in `index.ts`) plus a client-supplied relative
 * `path`, and MUST run that `path` through `safeResolve` before touching the
 * filesystem — see `safe-path.ts`'s top comment for why. Nothing in this
 * file calls `fs` with a path that hasn't been through `safeResolve` first.
 */
import chokidar, { type FSWatcher } from "chokidar";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { relative, sep } from "node:path";
import type { FastifyInstance } from "fastify";
import type { FileEntry, FileWatchEvent } from "@vibedeck/shared";
import type { WorkspaceStore } from "../db/workspaces.js";
import { isProbablyBinary, safeResolve } from "./safe-path.js";

/** Refuse to read/write anything bigger than this — both for the text
 * editor's own sanity (nobody wants a 50MB file dumped into CodeMirror) and
 * as a basic resource guard against a client hammering the endpoint with a
 * huge PUT body. */
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2MB

/** Directory names skipped by default in `GET /api/files/tree` (and never
 * watched by chokidar) — noisy, huge, or not source the user is likely to
 * want to browse/edit. `?showHidden=1` (tree) opts back into all of these
 * PLUS dotfiles; chokidar's ignore list is unconditional (watching
 * node_modules churn would be both useless and a performance problem). */
const IGNORED_DIR_NAMES = new Set(["node_modules", ".git", "dist"]);

function isIgnoredEntryName(name: string, showHidden: boolean): boolean {
  if (showHidden) return false; // showHidden=1 opts back into everything, dotfiles included
  if (IGNORED_DIR_NAMES.has(name)) return true;
  if (name.startsWith(".")) return true;
  return false;
}

/** Looks up a workspace by id, or replies 400 and returns null if it's
 * missing/unknown. Shared by every route below — same "workspaceId must
 * name a real workspace" rule `POST /api/sessions` already enforces. */
function requireWorkspace(
  workspaceStore: WorkspaceStore,
  workspaceId: unknown,
  reply: { status: (code: number) => { send: (body: unknown) => void } }
) {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    reply.status(400).send({ error: '"workspaceId" must be a string' });
    return null;
  }
  const workspace = workspaceStore.get(workspaceId);
  if (!workspace) {
    reply.status(400).send({ error: `No workspace with id "${workspaceId}"` });
    return null;
  }
  return workspace;
}

export function registerFileRoutes(app: FastifyInstance, workspaceStore: WorkspaceStore): void {
  // Every chokidar watcher this process has ever opened for a live "watch"
  // WebSocket, so they can all be closed on server shutdown — a leaked
  // watcher holds real OS file-descriptor/fsevents resources open and (in
  // tests especially) keeps the Node process alive after `app.close()`.
  const activeWatchers = new Set<FSWatcher>();
  app.addHook("onClose", (_instance, done) => {
    for (const watcher of activeWatchers) {
      watcher.close().catch(() => {
        // Already closing/closed — nothing else to do during shutdown.
      });
    }
    activeWatchers.clear();
    done();
  });

  app.get("/api/files/tree", async (request, reply) => {
    const query = request.query as { workspaceId?: unknown; path?: unknown; showHidden?: unknown };
    const workspace = requireWorkspace(workspaceStore, query.workspaceId, reply);
    if (!workspace) return;

    const relPath = typeof query.path === "string" && query.path.length > 0 ? query.path : ".";
    const resolved = safeResolve(workspace.rootPath, relPath);
    if (!resolved.ok) {
      return reply.status(403).send({ error: resolved.error });
    }

    let dirents;
    try {
      dirents = readdirSync(resolved.path, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return reply.status(404).send({ error: `"${relPath}" does not exist` });
      if (code === "ENOTDIR") return reply.status(400).send({ error: `"${relPath}" is not a directory` });
      return reply.status(500).send({ error: "Failed to read directory" });
    }

    const showHidden = query.showHidden === "1" || query.showHidden === "true";
    const base = relPath === "." ? "" : `${relPath}/`;

    const entries: FileEntry[] = dirents
      .filter((d) => !isIgnoredEntryName(d.name, showHidden))
      .map((d) => ({
        name: d.name,
        path: `${base}${d.name}`,
        kind: (d.isDirectory() ? "dir" : "file") as FileEntry["kind"],
      }))
      // Dirs first, then alphabetical (case-insensitive) within each group —
      // matches how virtually every file-tree UI (VS Code, Finder's "Sort by
      // Kind"...) presents a directory listing.
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      });

    return { entries };
  });

  app.get("/api/files/content", async (request, reply) => {
    const query = request.query as { workspaceId?: unknown; path?: unknown };
    const workspace = requireWorkspace(workspaceStore, query.workspaceId, reply);
    if (!workspace) return;

    const resolved = safeResolve(workspace.rootPath, query.path);
    if (!resolved.ok) {
      return reply.status(403).send({ error: resolved.error });
    }

    let stat;
    try {
      stat = statSync(resolved.path);
    } catch {
      return reply.status(404).send({ error: "File not found" });
    }

    if (!stat.isFile()) {
      return reply.status(400).send({ error: "Not a file" });
    }
    if (stat.size > MAX_FILE_BYTES) {
      return reply.status(413).send({ error: `File is larger than ${MAX_FILE_BYTES} bytes` });
    }

    const buf = readFileSync(resolved.path);
    if (isProbablyBinary(buf)) {
      return reply.status(415).send({ error: "File appears to be binary, not text" });
    }

    return {
      path: query.path,
      content: buf.toString("utf8"),
      truncated: false,
    };
  });

  app.put("/api/files/content", async (request, reply) => {
    const body = (request.body ?? {}) as { workspaceId?: unknown; path?: unknown; content?: unknown };
    const workspace = requireWorkspace(workspaceStore, body.workspaceId, reply);
    if (!workspace) return;

    if (typeof body.content !== "string") {
      return reply.status(400).send({ error: '"content" must be a string' });
    }
    if (Buffer.byteLength(body.content, "utf8") > MAX_FILE_BYTES) {
      return reply.status(413).send({ error: `Content is larger than ${MAX_FILE_BYTES} bytes` });
    }

    const resolved = safeResolve(workspace.rootPath, body.path);
    if (!resolved.ok) {
      return reply.status(403).send({ error: resolved.error });
    }

    try {
      writeFileSync(resolved.path, body.content, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return reply.status(404).send({ error: "Parent directory does not exist" });
      }
      if (code === "EISDIR") {
        return reply.status(400).send({ error: "Not a file" });
      }
      return reply.status(500).send({ error: "Failed to write file" });
    }

    return reply.status(204).send();
  });

  // Same reasoning as index.ts's session WebSocket route: @fastify/websocket
  // only reliably upgrades routes declared inside a nested `register()`.
  app.register(async (scoped) => {
    scoped.get("/api/files/watch", { websocket: true }, (socket, request) => {
      const query = request.query as { workspaceId?: unknown };
      const workspaceId = typeof query.workspaceId === "string" ? query.workspaceId : "";
      const workspace = workspaceStore.get(workspaceId);

      if (!workspace) {
        socket.close(1008, `No workspace with id "${workspaceId}"`);
        return;
      }

      const root = workspace.rootPath;
      const watcher = chokidar.watch(root, {
        ignoreInitial: true,
        // A path anywhere under an ignored directory name is skipped —
        // chokidar calls this for every candidate path it's considering.
        ignored: (watchedPath: string) => {
          const rel = relative(root, watchedPath);
          if (rel === "") return false; // never ignore the root itself
          return rel.split(sep).some((segment) => IGNORED_DIR_NAMES.has(segment));
        },
      });
      activeWatchers.add(watcher);

      // Debounce ~100ms per path: a formatter or editor autosave can fire
      // several raw fs events for one logical "the file changed" moment —
      // collapse those into a single emitted event per path.
      const pending = new Map<string, ReturnType<typeof setTimeout>>();
      const emit = (type: FileWatchEvent["type"], absPath: string) => {
        const relPath = relative(root, absPath);
        const existingTimer = pending.get(relPath);
        if (existingTimer) clearTimeout(existingTimer);
        const timer = setTimeout(() => {
          pending.delete(relPath);
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({ type, path: relPath } satisfies FileWatchEvent));
          }
        }, 100);
        pending.set(relPath, timer);
      };

      watcher.on("add", (p: string) => emit("add", p));
      watcher.on("change", (p: string) => emit("change", p));
      watcher.on("unlink", (p: string) => emit("unlink", p));

      const dispose = () => {
        for (const timer of pending.values()) clearTimeout(timer);
        pending.clear();
        watcher.close().catch(() => {
          // Already closing — fine.
        });
        activeWatchers.delete(watcher);
      };

      socket.on("close", dispose);
    });
  });
}
