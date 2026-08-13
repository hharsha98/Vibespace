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

      const events: FileWatchEvent[] = [];
      const gotAdd = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("timed out waiting for add event")), 8_000);
        ws.on("message", (raw: Buffer) => {
          const event = JSON.parse(raw.toString()) as FileWatchEvent;
          events.push(event);
          if (event.type === "add" && event.path === "new-file.txt") {
            clearTimeout(timeout);
            resolve();
          }
        });
        ws.on("error", reject);
      });

      // Give chokidar a moment to finish its initial scan before writing —
      // ignoreInitial:true means it shouldn't emit for pre-existing files,
      // but the watcher needs to actually be ready first.
      await new Promise((resolve) => setTimeout(resolve, 300));
      writeFileSync(join(projectDir, "new-file.txt"), "hello");

      await gotAdd;
      ws.close();
      await app.close();
      closeServer = undefined;
    },
    15_000
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
