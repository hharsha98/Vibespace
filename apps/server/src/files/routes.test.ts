/**
 * Route-level tests for the Phase 6 file endpoints. Complements
 * safe-path.test.ts (which tests the traversal/symlink logic in isolation)
 * by checking the routes actually USE that logic and wire it up to the
 * right HTTP status codes, plus the ordinary read/write/list behaviour.
 *
 * Same `VIBEDECK_DATA_DIR` temp-dir pattern as index.test.ts — every test
 * here builds its own SQLite temp dir so nothing touches a real
 * `~/.vibedeck`, and a separate temp dir for the workspace's project files.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { AddressInfo } from "node:net";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileWatchEvent } from "@vibedeck/shared";
import { buildApp } from "../index.js";

let dataDir: string;
let projectDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "vibedeck-files-test-data-"));
  process.env.VIBEDECK_DATA_DIR = dataDir;
  projectDir = mkdtempSync(join(tmpdir(), "vibedeck-files-test-project-"));
});

afterEach(() => {
  delete process.env.VIBEDECK_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

/** Creates a workspace rooted at `projectDir` and returns its id. */
async function createWorkspace(app: ReturnType<typeof buildApp>): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/workspaces",
    payload: { name: "files-test", rootPath: projectDir },
  });
  return (response.json() as { id: string }).id;
}

describe("GET /api/files/tree", () => {
  it("lists entries sorted dirs-first then alphabetically, skipping node_modules/.git/dist by default", async () => {
    const app = buildApp();
    const workspaceId = await createWorkspace(app);

    mkdirSync(join(projectDir, "node_modules"));
    mkdirSync(join(projectDir, ".git"));
    mkdirSync(join(projectDir, "dist"));
    mkdirSync(join(projectDir, "zeta-dir"));
    mkdirSync(join(projectDir, "alpha-dir"));
    writeFileSync(join(projectDir, "b-file.txt"), "b");
    writeFileSync(join(projectDir, "a-file.txt"), "a");

    const response = await app.inject({
      method: "GET",
      url: `/api/files/tree?workspaceId=${workspaceId}&path=.`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { entries: { name: string; kind: string }[] };

    expect(body.entries.map((e) => e.name)).not.toContain("node_modules");
    expect(body.entries.map((e) => e.name)).not.toContain(".git");
    expect(body.entries.map((e) => e.name)).not.toContain("dist");

    // Dirs first (alpha-dir, zeta-dir), then files (a-file.txt, b-file.txt).
    expect(body.entries.map((e) => e.name)).toEqual([
      "alpha-dir",
      "zeta-dir",
      "a-file.txt",
      "b-file.txt",
    ]);
    expect(body.entries.find((e) => e.name === "alpha-dir")?.kind).toBe("dir");
    expect(body.entries.find((e) => e.name === "a-file.txt")?.kind).toBe("file");

    await app.close();
  });

  it("includes node_modules/.git/dist and dotfiles when showHidden=1", async () => {
    const app = buildApp();
    const workspaceId = await createWorkspace(app);
    mkdirSync(join(projectDir, "node_modules"));
    writeFileSync(join(projectDir, ".env"), "SECRET=1");

    const response = await app.inject({
      method: "GET",
      url: `/api/files/tree?workspaceId=${workspaceId}&path=.&showHidden=1`,
    });
    const body = response.json() as { entries: { name: string }[] };
    expect(body.entries.map((e) => e.name)).toContain("node_modules");
    expect(body.entries.map((e) => e.name)).toContain(".env");

    await app.close();
  });

  it("lists a nested subdirectory using workspace-relative paths", async () => {
    const app = buildApp();
    const workspaceId = await createWorkspace(app);
    mkdirSync(join(projectDir, "src"));
    writeFileSync(join(projectDir, "src", "index.ts"), "export {}");

    const response = await app.inject({
      method: "GET",
      url: `/api/files/tree?workspaceId=${workspaceId}&path=src`,
    });
    const body = response.json() as { entries: { name: string; path: string }[] };
    expect(body.entries).toEqual([{ name: "index.ts", path: "src/index.ts", kind: "file" }]);

    await app.close();
  });

  it("rejects a traversal path with 403", async () => {
    const app = buildApp();
    const workspaceId = await createWorkspace(app);
    const response = await app.inject({
      method: "GET",
      url: `/api/files/tree?workspaceId=${workspaceId}&path=${encodeURIComponent("../../etc")}`,
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("rejects an unknown workspaceId with 400", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/files/tree?workspaceId=does-not-exist&path=.",
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

describe("GET /api/files/content", () => {
  it("reads a text file's content", async () => {
    const app = buildApp();
    const workspaceId = await createWorkspace(app);
    writeFileSync(join(projectDir, "README.md"), "# Hello\n");

    const response = await app.inject({
      method: "GET",
      url: `/api/files/content?workspaceId=${workspaceId}&path=README.md`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ path: "README.md", content: "# Hello\n", truncated: false });
    await app.close();
  });

  it("returns 404 for a missing file", async () => {
    const app = buildApp();
    const workspaceId = await createWorkspace(app);
    const response = await app.inject({
      method: "GET",
      url: `/api/files/content?workspaceId=${workspaceId}&path=nope.txt`,
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("returns 403 for a path-traversal attempt", async () => {
    const app = buildApp();
    const workspaceId = await createWorkspace(app);
    const response = await app.inject({
      method: "GET",
      url: `/api/files/content?workspaceId=${workspaceId}&path=${encodeURIComponent("../../etc/passwd")}`,
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("returns 403 for a symlink escaping the workspace root", async () => {
    const app = buildApp();
    const workspaceId = await createWorkspace(app);
    const outside = mkdtempSync(join(tmpdir(), "vibedeck-files-outside-"));
    writeFileSync(join(outside, "secret.txt"), "top secret");
    symlinkSync(join(outside, "secret.txt"), join(projectDir, "link.txt"), "file");

    const response = await app.inject({
      method: "GET",
      url: `/api/files/content?workspaceId=${workspaceId}&path=link.txt`,
    });
    expect(response.statusCode).toBe(403);

    rmSync(outside, { recursive: true, force: true });
    await app.close();
  });

  it("returns 415 for binary content", async () => {
    const app = buildApp();
    const workspaceId = await createWorkspace(app);
    writeFileSync(join(projectDir, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));

    const response = await app.inject({
      method: "GET",
      url: `/api/files/content?workspaceId=${workspaceId}&path=image.png`,
    });
    expect(response.statusCode).toBe(415);
    await app.close();
  });

  it("returns 413 for a file over 2MB", async () => {
    const app = buildApp();
    const workspaceId = await createWorkspace(app);
    writeFileSync(join(projectDir, "big.txt"), "a".repeat(2 * 1024 * 1024 + 1));

    const response = await app.inject({
      method: "GET",
      url: `/api/files/content?workspaceId=${workspaceId}&path=big.txt`,
    });
    expect(response.statusCode).toBe(413);
    await app.close();
  });

  it("returns 400 for a directory", async () => {
    const app = buildApp();
    const workspaceId = await createWorkspace(app);
    mkdirSync(join(projectDir, "a-dir"));
    const response = await app.inject({
      method: "GET",
      url: `/api/files/content?workspaceId=${workspaceId}&path=a-dir`,
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

describe("PUT /api/files/content", () => {
  it("writes a new file and round-trips it through GET", async () => {
    const app = buildApp();
    const workspaceId = await createWorkspace(app);

    const putResponse = await app.inject({
      method: "PUT",
      url: "/api/files/content",
      payload: { workspaceId, path: "notes.md", content: "hello world" },
    });
    expect(putResponse.statusCode).toBe(204);

    const getResponse = await app.inject({
      method: "GET",
      url: `/api/files/content?workspaceId=${workspaceId}&path=notes.md`,
    });
    expect(getResponse.json()).toEqual({ path: "notes.md", content: "hello world", truncated: false });
    await app.close();
  });

  it("overwrites an existing file", async () => {
    const app = buildApp();
    const workspaceId = await createWorkspace(app);
    writeFileSync(join(projectDir, "notes.md"), "old content");

    await app.inject({
      method: "PUT",
      url: "/api/files/content",
      payload: { workspaceId, path: "notes.md", content: "new content" },
    });

    const getResponse = await app.inject({
      method: "GET",
      url: `/api/files/content?workspaceId=${workspaceId}&path=notes.md`,
    });
    expect((getResponse.json() as { content: string }).content).toBe("new content");
    await app.close();
  });

  it("rejects a traversal write attempt with 403 and never touches the filesystem outside root", async () => {
    const app = buildApp();
    const workspaceId = await createWorkspace(app);
    const response = await app.inject({
      method: "PUT",
      url: "/api/files/content",
      payload: { workspaceId, path: "../../tmp/vibedeck-pwned.txt", content: "pwned" },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("rejects an absolute path with 403", async () => {
    const app = buildApp();
    const workspaceId = await createWorkspace(app);
    const response = await app.inject({
      method: "PUT",
      url: "/api/files/content",
      payload: { workspaceId, path: "/etc/passwd", content: "pwned" },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("rejects content over 2MB with 413", async () => {
    const app = buildApp();
    const workspaceId = await createWorkspace(app);
    const response = await app.inject({
      method: "PUT",
      url: "/api/files/content",
      payload: { workspaceId, path: "big.txt", content: "a".repeat(2 * 1024 * 1024 + 1) },
    });
    expect(response.statusCode).toBe(413);
    await app.close();
  });
});

describe("POST /api/files/paste-image", () => {
  // A tiny valid 1x1 PNG, base64-encoded — real bytes, not a placeholder
  // string, so `isProbablyBinary`-style content sanity (if this endpoint
  // ever added it) and simple byte-count assertions both have something
  // real to check.
  const TINY_PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

  it("writes the decoded image under .vibedeck/pastes and returns its relative path", async () => {
    const app = buildApp();
    const workspaceId = await createWorkspace(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/files/paste-image",
      payload: { workspaceId, mimeType: "image/png", dataBase64: TINY_PNG_BASE64 },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as { path: string };
    expect(body.path.startsWith(".vibedeck/pastes/")).toBe(true);
    expect(body.path.endsWith(".png")).toBe(true);

    const written = readFileSync(join(projectDir, body.path));
    expect(written.equals(Buffer.from(TINY_PNG_BASE64, "base64"))).toBe(true);
    await app.close();
  });

  it("rejects an unrecognized MIME type with 400 and writes nothing", async () => {
    const app = buildApp();
    const workspaceId = await createWorkspace(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/files/paste-image",
      payload: { workspaceId, mimeType: "application/pdf", dataBase64: TINY_PNG_BASE64 },
    });

    expect(response.statusCode).toBe(400);
    expect(existsSync(join(projectDir, ".vibedeck", "pastes"))).toBe(false);
    await app.close();
  });

  it("rejects a missing dataBase64 with 400", async () => {
    const app = buildApp();
    const workspaceId = await createWorkspace(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/files/paste-image",
      payload: { workspaceId, mimeType: "image/png" },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects an unknown workspaceId with 400", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/files/paste-image",
      payload: { workspaceId: "no-such-workspace", mimeType: "image/png", dataBase64: TINY_PNG_BASE64 },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects an image over the size cap with 413", async () => {
    const app = buildApp();
    const workspaceId = await createWorkspace(app);

    // One byte over MAX_PASTE_IMAGE_BYTES (20MB), base64-encoded.
    const oversized = Buffer.alloc(20 * 1024 * 1024 + 1, 1).toString("base64");
    const response = await app.inject({
      method: "POST",
      url: "/api/files/paste-image",
      payload: { workspaceId, mimeType: "image/png", dataBase64: oversized },
    });

    expect(response.statusCode).toBe(413);
    await app.close();
  });

  it("two pastes in the workspace each get their own file, neither overwriting the other", async () => {
    const app = buildApp();
    const workspaceId = await createWorkspace(app);

    const first = await app.inject({
      method: "POST",
      url: "/api/files/paste-image",
      payload: { workspaceId, mimeType: "image/png", dataBase64: TINY_PNG_BASE64 },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/files/paste-image",
      payload: { workspaceId, mimeType: "image/png", dataBase64: TINY_PNG_BASE64 },
    });

    const firstPath = (first.json() as { path: string }).path;
    const secondPath = (second.json() as { path: string }).path;
    expect(firstPath).not.toBe(secondPath);
    expect(existsSync(join(projectDir, firstPath))).toBe(true);
    expect(existsSync(join(projectDir, secondPath))).toBe(true);
    await app.close();
  });
});

describe("POST /api/files/move", () => {
  it("moves a file to a new location within the workspace", async () => {
    const app = buildApp();
    const workspaceId = await createWorkspace(app);
    writeFileSync(join(projectDir, "a.txt"), "hello");
    mkdirSync(join(projectDir, "sub"));

    const response = await app.inject({
      method: "POST",
      url: "/api/files/move",
      payload: { workspaceId, from: "a.txt", to: "sub/a.txt" },
    });
    expect(response.statusCode).toBe(204);
    expect(existsSync(join(projectDir, "a.txt"))).toBe(false);
    expect(existsSync(join(projectDir, "sub", "a.txt"))).toBe(true);
    expect(readFileSync(join(projectDir, "sub", "a.txt"), "utf8")).toBe("hello");
    await app.close();
  });

  it("renames a file in place (same directory, new basename)", async () => {
    const app = buildApp();
    const workspaceId = await createWorkspace(app);
    writeFileSync(join(projectDir, "old-name.txt"), "content");

    const response = await app.inject({
      method: "POST",
      url: "/api/files/move",
      payload: { workspaceId, from: "old-name.txt", to: "new-name.txt" },
    });
    expect(response.statusCode).toBe(204);
    expect(existsSync(join(projectDir, "old-name.txt"))).toBe(false);
    expect(existsSync(join(projectDir, "new-name.txt"))).toBe(true);
    await app.close();
  });

  it("moves a directory (and its contents) to a new parent", async () => {
    const app = buildApp();
    const workspaceId = await createWorkspace(app);
    mkdirSync(join(projectDir, "dir-a"));
    writeFileSync(join(projectDir, "dir-a", "inner.txt"), "inner");
    mkdirSync(join(projectDir, "dir-b"));

    const response = await app.inject({
      method: "POST",
      url: "/api/files/move",
      payload: { workspaceId, from: "dir-a", to: "dir-b/dir-a" },
    });
    expect(response.statusCode).toBe(204);
    expect(existsSync(join(projectDir, "dir-a"))).toBe(false);
    expect(readFileSync(join(projectDir, "dir-b", "dir-a", "inner.txt"), "utf8")).toBe("inner");
    await app.close();
  });

  it("404s when the source doesn't exist", async () => {
    const app = buildApp();
    const workspaceId = await createWorkspace(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/files/move",
      payload: { workspaceId, from: "does-not-exist.txt", to: "somewhere.txt" },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("403s a source path that traverses outside the workspace root", async () => {
    const app = buildApp();
    const workspaceId = await createWorkspace(app);
    writeFileSync(join(projectDir, "a.txt"), "hello");
    const response = await app.inject({
      method: "POST",
      url: "/api/files/move",
      payload: { workspaceId, from: "../../etc/passwd", to: "a.txt" },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("403s a destination path that traverses outside the workspace root", async () => {
    const app = buildApp();
    const workspaceId = await createWorkspace(app);
    writeFileSync(join(projectDir, "a.txt"), "hello");
    const response = await app.inject({
      method: "POST",
      url: "/api/files/move",
      payload: { workspaceId, from: "a.txt", to: "../../etc/passwd" },
    });
    expect(response.statusCode).toBe(403);
    // The refused move must not have happened — the source file is untouched.
    expect(existsSync(join(projectDir, "a.txt"))).toBe(true);
    await app.close();
  });

  it("403s a destination path that escapes via an absolute path", async () => {
    const app = buildApp();
    const workspaceId = await createWorkspace(app);
    writeFileSync(join(projectDir, "a.txt"), "hello");
    const response = await app.inject({
      method: "POST",
      url: "/api/files/move",
      payload: { workspaceId, from: "a.txt", to: "/etc/passwd" },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("409s when the destination already exists — never silently overwrites", async () => {
    const app = buildApp();
    const workspaceId = await createWorkspace(app);
    writeFileSync(join(projectDir, "a.txt"), "source content");
    writeFileSync(join(projectDir, "b.txt"), "existing destination content");

    const response = await app.inject({
      method: "POST",
      url: "/api/files/move",
      payload: { workspaceId, from: "a.txt", to: "b.txt" },
    });
    expect(response.statusCode).toBe(409);
    // Neither file was touched by the refused move.
    expect(readFileSync(join(projectDir, "a.txt"), "utf8")).toBe("source content");
    expect(readFileSync(join(projectDir, "b.txt"), "utf8")).toBe("existing destination content");
    await app.close();
  });

  it("400s moving a directory into itself", async () => {
    const app = buildApp();
    const workspaceId = await createWorkspace(app);
    mkdirSync(join(projectDir, "dir-a"));

    const response = await app.inject({
      method: "POST",
      url: "/api/files/move",
      payload: { workspaceId, from: "dir-a", to: "dir-a" },
    });
    expect(response.statusCode).toBe(400);
    expect(existsSync(join(projectDir, "dir-a"))).toBe(true);
    await app.close();
  });

  it("400s moving a directory into one of its own descendants", async () => {
    const app = buildApp();
    const workspaceId = await createWorkspace(app);
    mkdirSync(join(projectDir, "dir-a"));
    mkdirSync(join(projectDir, "dir-a", "nested"));

    const response = await app.inject({
      method: "POST",
      url: "/api/files/move",
      payload: { workspaceId, from: "dir-a", to: "dir-a/nested/dir-a" },
    });
    expect(response.statusCode).toBe(400);
    // The refused move must not have partially applied.
    expect(existsSync(join(projectDir, "dir-a", "nested"))).toBe(true);
    await app.close();
  });

  it("400s when workspaceId is missing", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/files/move",
      payload: { from: "a.txt", to: "b.txt" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

describe("GET /api/files/watch (WebSocket)", () => {
  let closeServer: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await closeServer?.();
    closeServer = undefined;
  });

  it(
    "streams add/change/unlink events for the watched workspace, debounced",
    async () => {
      const app = buildApp();
      await app.listen({ port: 0, host: "127.0.0.1" });
      closeServer = () => app.close();
      const { port } = app.server.address() as AddressInfo;

      const workspaceId = await createWorkspace(app);

      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/files/watch?workspaceId=${workspaceId}`);
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
      });

      // Every event received so far, plus a nudge fired on each arrival.
      // `waitForEvent` scans what has ALREADY landed before it sleeps, so
      // an event arriving between two awaits can't be missed.
      const events: FileWatchEvent[] = [];
      let nudge = (): void => {};
      ws.on("message", (raw: Buffer) => {
        events.push(JSON.parse(raw.toString()) as FileWatchEvent);
        nudge();
      });

      // Each wait gets its OWN fresh budget, deliberately. One shared
      // deadline started at socket-open lets a slow `ready` eat the `add`
      // budget too — under parallel load `ready` can take seconds, leaving
      // `add` almost none and failing for entirely the wrong reason.
      const waitForEvent = async (
        matches: (e: FileWatchEvent) => boolean,
        label: string,
        timeoutMs = 10_000
      ): Promise<void> => {
        const deadline = Date.now() + timeoutMs;
        while (!events.some(matches)) {
          if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
          await new Promise<void>((resolve) => {
            nudge = resolve;
            setTimeout(resolve, 100);
          });
        }
      };

      // Wait for the watcher to SAY it is watching, rather than sleeping a
      // guessed 300ms and hoping. That guess was the entire flake: under
      // parallel load chokidar's initial scan outlasted it, so
      // "new-file.txt" was created DURING the scan and `ignoreInitial`
      // folded it into the initial listing — the "add" event was never
      // emitted at all. The test then waited the full 8s for an event that
      // could not arrive, which is why raising that timeout would never
      // have helped.
      await waitForEvent((e) => e.type === "ready", "watcher ready");

      // Keep creating files until the watcher reports one, rather than
      // creating exactly one and demanding that specific notification
      // survive. macOS fsevents genuinely drops notifications under load —
      // measured here, with the suite running 50+ files in parallel, each
      // spawning ptys and watchers: `ready` had arrived and a full 10s
      // budget still expired with no `add`, repeatably, a few runs in ten.
      // That is the platform's behaviour, not this route's, and no timeout
      // can fix a notification that was never delivered.
      //
      // A fresh NAME each attempt on purpose: rewriting the same path
      // yields `change`, not `add`, so retrying the identical write could
      // never produce the event being waited for.
      //
      // This still fails loudly if the watcher is actually broken — no
      // `add` for ANY of the files, across the whole 20s. It only tolerates
      // losing individual notifications, which is the one thing the route
      // has no control over.
      const addSeen = () => events.some((e) => e.type === "add" && e.path.startsWith("new-file-"));
      const addDeadline = Date.now() + 20_000;
      let attempt = 0;
      while (!addSeen()) {
        if (Date.now() >= addDeadline) {
          throw new Error(`no add event after creating ${attempt} files; watcher is not reporting creations`);
        }
        attempt += 1;
        writeFileSync(join(projectDir, `new-file-${attempt}.txt`), "hello");
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      ws.close();
      await app.close();
      closeServer = undefined;
    },
    30_000
  );

  it(
    "closes with a clear reason for an unknown workspaceId",
    async () => {
      const app = buildApp();
      await app.listen({ port: 0, host: "127.0.0.1" });
      closeServer = () => app.close();
      const { port } = app.server.address() as AddressInfo;

      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/files/watch?workspaceId=does-not-exist`);
      const closeEvent = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("timed out waiting for close")), 8_000);
        ws.on("close", (code: number, reasonBuf: Buffer) => {
          clearTimeout(timeout);
          resolve({ code, reason: reasonBuf.toString() });
        });
        ws.on("error", reject);
      });
      expect(closeEvent.reason).toContain("does-not-exist");

      await app.close();
      closeServer = undefined;
    },
    10_000
  );
});
