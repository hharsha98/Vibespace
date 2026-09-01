/**
 * Route tests for the Phase 8 memory endpoints, exercised via `app.inject()`
 * — same pattern as board/routes.test.ts. `VIBESPACE_DATA_DIR` redirects the
 * workspace SQLite db to a temp dir (workspaces are still DB-backed); a
 * SEPARATE temp dir stands in for the workspace's own project directory,
 * which is where `.vibespace/memory/*.md` actually gets written — same two-
 * temp-dir split files/routes.test.ts uses.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../index.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "vibespace-memory-routes-test-"));
  process.env.VIBESPACE_DATA_DIR = dataDir;
});

afterEach(() => {
  delete process.env.VIBESPACE_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

/** Creates a throwaway workspace (via the real REST route) for tests that
 * need a valid workspaceId to hang notes off of — same helper shape as
 * board/routes.test.ts's `createWorkspace`. */
async function createWorkspace(app: ReturnType<typeof buildApp>) {
  const projectDir = mkdtempSync(join(tmpdir(), "vibespace-memory-workspace-"));
  const response = await app.inject({
    method: "POST",
    url: "/api/workspaces",
    payload: { name: "memory-test", rootPath: projectDir },
  });
  return response.json() as { id: string; rootPath: string };
}

describe("GET /api/memory/notes", () => {
  it("400s when workspaceId is missing", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/memory/notes" });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("404s for an unknown workspace", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/memory/notes?workspaceId=nope" });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("returns an empty list for a fresh workspace", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const response = await app.inject({ method: "GET", url: `/api/memory/notes?workspaceId=${workspace.id}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ notes: [] });
    await app.close();
  });
});

describe("POST /api/memory/notes", () => {
  it("creates a note with defaults and returns 201", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/memory/notes",
      payload: { workspaceId: workspace.id, title: "My first note" },
    });
    expect(response.statusCode).toBe(201);
    const note = response.json();
    expect(note.slug).toBe("my-first-note");
    expect(note.title).toBe("My first note");
    expect(note.tags).toEqual([]);
    expect(note.body).toBe("");
    await app.close();
  });

  it("accepts body and tags", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/memory/notes",
      payload: { workspaceId: workspace.id, title: "With extras", body: "Hello [[other]].", tags: ["a", "b"] },
    });
    const note = response.json();
    expect(note.body).toBe("Hello [[other]].");
    expect(note.tags).toEqual(["a", "b"]);
    await app.close();
  });

  it("400s on an empty title", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/memory/notes",
      payload: { workspaceId: workspace.id, title: "  " },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("400s when tags is not an array of strings", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/memory/notes",
      payload: { workspaceId: workspace.id, title: "Bad tags", tags: [1, 2] },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("actually writes a real .md file under <workspace>/.vibespace/memory/", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    await app.inject({
      method: "POST",
      url: "/api/memory/notes",
      payload: { workspaceId: workspace.id, title: "On disk note", body: "Some content." },
    });
    const raw = readFileSync(join(workspace.rootPath, ".vibespace", "memory", "on-disk-note.md"), "utf8");
    expect(raw).toContain("title: On disk note");
    expect(raw).toContain("Some content.");
    await app.close();
  });

  it("guarantees unique slugs across repeated POSTs with the same title", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const first = await app.inject({
      method: "POST",
      url: "/api/memory/notes",
      payload: { workspaceId: workspace.id, title: "Dup" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/memory/notes",
      payload: { workspaceId: workspace.id, title: "Dup" },
    });
    expect(first.json().slug).toBe("dup");
    expect(second.json().slug).toBe("dup-2");
    await app.close();
  });
});

describe("GET /api/memory/notes/:slug", () => {
  it("404s for an unknown slug", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const response = await app.inject({
      method: "GET",
      url: `/api/memory/notes/does-not-exist?workspaceId=${workspace.id}`,
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("returns a note with its backlinks", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    await app.inject({
      method: "POST",
      url: "/api/memory/notes",
      payload: { workspaceId: workspace.id, title: "Target note" },
    });
    await app.inject({
      method: "POST",
      url: "/api/memory/notes",
      payload: { workspaceId: workspace.id, title: "Linker note", body: "See [[target-note]]." },
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/memory/notes/target-note?workspaceId=${workspace.id}`,
    });
    expect(response.statusCode).toBe(200);
    const note = response.json();
    expect(note.backlinks).toEqual(["linker-note"]);
    await app.close();
  });
});

describe("PATCH /api/memory/notes/:slug", () => {
  it("404s for an unknown slug", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const response = await app.inject({
      method: "PATCH",
      url: "/api/memory/notes/nope",
      payload: { workspaceId: workspace.id, title: "x" },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("updates title/body/tags, keeping the slug the same", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/memory/notes",
      payload: { workspaceId: workspace.id, title: "Original" },
    });
    const slug = created.json().slug;

    const response = await app.inject({
      method: "PATCH",
      url: `/api/memory/notes/${slug}`,
      payload: { workspaceId: workspace.id, title: "Renamed", body: "New body", tags: ["z"] },
    });
    expect(response.statusCode).toBe(200);
    const updated = response.json();
    expect(updated.slug).toBe(slug); // slug is immutable
    expect(updated.title).toBe("Renamed");
    expect(updated.body).toBe("New body");
    expect(updated.tags).toEqual(["z"]);
    await app.close();
  });
});

describe("DELETE /api/memory/notes/:slug", () => {
  it("404s for an unknown slug", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const response = await app.inject({
      method: "DELETE",
      url: `/api/memory/notes/nope?workspaceId=${workspace.id}`,
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("deletes a note and returns 204", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/memory/notes",
      payload: { workspaceId: workspace.id, title: "To delete" },
    });
    const slug = created.json().slug;

    const response = await app.inject({
      method: "DELETE",
      url: `/api/memory/notes/${slug}?workspaceId=${workspace.id}`,
    });
    expect(response.statusCode).toBe(204);

    const getResponse = await app.inject({
      method: "GET",
      url: `/api/memory/notes/${slug}?workspaceId=${workspace.id}`,
    });
    expect(getResponse.statusCode).toBe(404);
    await app.close();
  });
});

describe("GET /api/memory/graph", () => {
  it("400s when workspaceId is missing", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/memory/graph" });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("returns nodes and edges, including a dangling node for an unwritten link target", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    await app.inject({
      method: "POST",
      url: "/api/memory/notes",
      payload: { workspaceId: workspace.id, title: "Has a dangling link", body: "See [[not-written-yet]]." },
    });

    const response = await app.inject({ method: "GET", url: `/api/memory/graph?workspaceId=${workspace.id}` });
    expect(response.statusCode).toBe(200);
    const { nodes, edges } = response.json();

    expect(nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: "has-a-dangling-link", dangling: false }),
        expect.objectContaining({ slug: "not-written-yet", dangling: true }),
      ])
    );
    expect(edges).toEqual([{ source: "has-a-dangling-link", target: "not-written-yet", dangling: true }]);
    await app.close();
  });
});
