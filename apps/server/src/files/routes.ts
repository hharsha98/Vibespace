/**
 * The file tree / editor / preview endpoints (Phase 6). Every handler here
 * takes a `workspaceId` (looked up via `WorkspaceStore`, same as the
 * session/workspace routes in `index.ts`) plus a client-supplied relative
 * `path`, and MUST run that `path` through `safeResolve` before touching the
 * filesystem — see `safe-path.ts`'s top comment for why. Nothing in this
 * file calls `fs` with a path that hasn't been through `safeResolve` first.
 */
import chokidar, { type FSWatcher } from "chokidar";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join, relative, sep } from "node:path";
import type { FastifyInstance } from "fastify";
import type { FileChangeEventType, FileEntry, FileWatchEvent } from "@vibespace/shared";
import type { WorkspaceStore } from "../db/workspaces.js";
import { migrateLegacyWorkspaceDotDir } from "./legacy-dot-dir.js";
import { isInside, isProbablyBinary, safeResolve } from "./safe-path.js";
import { PASTE_IMAGE_DIR_NAME, pickPasteImagePath } from "./paste-image.js";

/** Refuse to read/write anything bigger than this — both for the text
 * editor's own sanity (nobody wants a 50MB file dumped into CodeMirror) and
 * as a basic resource guard against a client hammering the endpoint with a
 * huge PUT body. */
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2MB

/** Refuse a pasted image bigger than this, decoded — generous for a
 * screenshot (even a large multi-monitor capture is usually a few MB as
 * PNG) while still bounding memory use for one request. The server's own
 * `bodyLimit` (see `index.ts`'s `Fastify({...})` call) is set well above
 * this once you account for base64's ~33% size overhead over raw bytes, so
 * a request under this cap should never be rejected at the body-parsing
 * layer before it even reaches this check. */
const MAX_PASTE_IMAGE_BYTES = 20 * 1024 * 1024; // 20MB

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

  // BridgeSpace parity item 2: "paste a screenshot into an agent pane".
  // Agent CLIs (claude, cursor-agent, codex) read an image by its file
  // PATH, not a clipboard bitmap, so Terminal.tsx's paste handler (see that
  // file's "Paste a screenshot" comment) intercepts an image paste,
  // base64-encodes it, and POSTs it here rather than ever trying to type
  // raw image bytes into the pty. This endpoint just writes those bytes
  // into the workspace and hands back the relative path Terminal.tsx then
  // types into the pty — same "type a path, don't paste content" idiom
  // `handleDrop` (dragged files) already uses client-side.
  //
  // `pickPasteImagePath` (paste-image.ts) decides WHERE inside the
  // workspace the image lands (`.vibespace/pastes/...`); this handler only
  // owns request validation and the actual write, and — same rule as every
  // other route in this file — runs that decision's relative path through
  // `safeResolve` before ever touching `fs`, even though it's a
  // server-generated path, not raw client input: a write endpoint that
  // ever skips that check even once, "because this particular path is
  // trusted," is exactly the kind of thing that stops being true after the
  // next refactor.
  app.post("/api/files/paste-image", async (request, reply) => {
    const body = (request.body ?? {}) as { workspaceId?: unknown; mimeType?: unknown; dataBase64?: unknown };
    const workspace = requireWorkspace(workspaceStore, body.workspaceId, reply);
    if (!workspace) return;

    if (typeof body.mimeType !== "string" || body.mimeType.length === 0) {
      return reply.status(400).send({ error: '"mimeType" must be a non-empty string' });
    }
    if (typeof body.dataBase64 !== "string" || body.dataBase64.length === 0) {
      return reply.status(400).send({ error: '"dataBase64" must be a non-empty string' });
    }

    const decision = pickPasteImagePath(body.mimeType, Date.now(), randomUUID().slice(0, 8));
    if (!decision.ok) {
      return reply.status(400).send({ error: decision.error });
    }

    let buf: Buffer;
    try {
      buf = Buffer.from(body.dataBase64, "base64");
    } catch {
      return reply.status(400).send({ error: '"dataBase64" is not valid base64' });
    }
    if (buf.length === 0) {
      return reply.status(400).send({ error: "Decoded image is empty" });
    }
    if (buf.length > MAX_PASTE_IMAGE_BYTES) {
      return reply.status(413).send({ error: `Image must be under ${MAX_PASTE_IMAGE_BYTES} bytes` });
    }

    // A vibedeck-era workspace may still have its pastes (and memory notes,
    // and skills) sitting under `.vibedeck` instead of `.vibespace` — move
    // the whole dot-directory across before creating anything new inside
    // it, same lazy per-workspace migration `memory/store.ts`'s
    // `ensureMemoryDir` triggers from its own write path (see
    // `legacy-dot-dir.ts`'s top comment for why this can't just happen
    // once at startup).
    migrateLegacyWorkspaceDotDir(workspace.rootPath);

    // safeResolve requires the target's parent to already exist on disk to
    // realpath it (see safe-path.ts's top comment) — ensure the dot-dir
    // first, same "mkdir, then resolve into it" order memory/store.ts's
    // ensureMemoryDir already uses for the same reason.
    mkdirSync(join(workspace.rootPath, PASTE_IMAGE_DIR_NAME), { recursive: true });

    const resolved = safeResolve(workspace.rootPath, decision.relPath);
    if (!resolved.ok) {
      // Should never actually happen for a path this handler generated
      // itself (not raw client input) — but see this route's own top
      // comment for why that's not a reason to skip the check.
      return reply.status(500).send({ error: resolved.error });
    }

    try {
      writeFileSync(resolved.path, buf);
    } catch {
      return reply.status(500).send({ error: "Failed to write pasted image" });
    }

    return reply.status(201).send({ path: decision.relPath });
  });

  // Phase 9.5c (PARITY #20): move/rename a file or directory within a
  // workspace — the server side of file-tree drag-and-drop (see
  // apps/web/src/files/FileTree.tsx). Named "move" (not "rename") because
  // it's the same operation either way: `to` can change the basename
  // (rename), the parent directory (move), or both at once.
  //
  // This is the highest-risk endpoint in the file-tree feature, so every
  // refusal below is deliberate and tested (see routes.test.ts):
  //   1. Both `from` and `to` go through `safeResolve` independently — a
  //      malicious `to` escaping the workspace root is just as dangerous as
  //      a malicious `from`, so neither gets a pass.
  //   2. Refuse if `from` doesn't exist (404) — nothing to move.
  //   3. Refuse moving a path into itself or one of its own descendants
  //      (400) — `rename("a", "a/b")` would otherwise corrupt the
  //      directory (this check runs on the RESOLVED absolute paths, via the
  //      same `isInside` helper `safeResolve` itself uses for containment).
  //   4. Refuse if `to` already exists (409) — never silently overwrite;
  //      the client can retry with a different destination name.
  //   5. Only then attempt the actual `fs.renameSync`.
  app.post("/api/files/move", async (request, reply) => {
    const body = (request.body ?? {}) as { workspaceId?: unknown; from?: unknown; to?: unknown };
    const workspace = requireWorkspace(workspaceStore, body.workspaceId, reply);
    if (!workspace) return;

    const src = safeResolve(workspace.rootPath, body.from);
    if (!src.ok) {
      return reply.status(403).send({ error: `Source path: ${src.error}` });
    }
    const dest = safeResolve(workspace.rootPath, body.to);
    if (!dest.ok) {
      return reply.status(403).send({ error: `Destination path: ${dest.error}` });
    }

    if (!existsSync(src.path)) {
      return reply.status(404).send({ error: `"${body.from}" does not exist` });
    }

    // Checked BEFORE the "already exists" check below: if `to` names the
    // same path as `from` (or a path inside it), that's always the more
    // specific and more honest error, even though a same-path move would
    // technically also fail the "already exists" check (the source IS the
    // thing that already exists at that path).
    if (isInside(src.path, dest.path)) {
      return reply
        .status(400)
        .send({ error: "Cannot move a directory into itself or one of its own descendants" });
    }

    if (existsSync(dest.path)) {
      return reply.status(409).send({ error: `"${body.to}" already exists` });
    }

    try {
      // Note: `renameSync` can fail with EXDEV if `to` somehow lands on a
      // different filesystem/mount than `from` — not expected within a
      // single workspace root, and not specially handled (no copy+delete
      // fallback) here; it surfaces as the generic 500 below.
      renameSync(src.path, dest.path);
    } catch {
      return reply.status(500).send({ error: "Failed to move file" });
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
      const emit = (type: FileChangeEventType, absPath: string) => {
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

      // Announce readiness once chokidar's initial scan is done, NOT
      // debounced — it carries no path, and it's the one message whose
      // whole value is arriving promptly. Before this, a client had no way
      // to know when the watcher went live, and anything created during
      // the scan window was silently folded into the initial listing by
      // `ignoreInitial` and never reported at all. See `FileWatchEvent`'s
      // own comment, and `swarm/watch.ts`, which solved this first.
      watcher.on("ready", () => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: "ready" } satisfies FileWatchEvent));
        }
      });

      // WITHOUT this the whole server dies. chokidar's FSWatcher is an
      // EventEmitter, and an 'error' event with no listener is a Node
      // process-level crash — not a caught exception, not a 500, the
      // process. Watching a directory means watching whatever happens to
      // be in it, and some entries simply cannot be watched: unix sockets,
      // files that vanish mid-scan, entries with no read permission.
      //
      // Found by opening a workspace on /tmp, which had a stray
      // `cursor-askpass-*.sock` in it: `fs.watch` threw
      // `UNKNOWN: unknown error, watch '/tmp/cursor-askpass-….sock'` and
      // took down the server — and with it every running agent session in
      // EVERY workspace, not just this one. One unwatchable file is not
      // worth anyone's sessions, so it is logged and skipped.
      watcher.on("error", (err: unknown) => {
        console.warn(
          `vibespace: file watcher error under "${root}" (continuing to watch): ` +
            `${err instanceof Error ? err.message : String(err)}`
        );
      });

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
