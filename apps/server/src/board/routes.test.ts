/**
 * Route tests for the Phase 7 board endpoints, exercised via `app.inject()`
 * (in-process, no real network port) — same pattern as `index.test.ts`.
 * `VIBESPACE_DATA_DIR` is pointed at a fresh temp directory per test, same
 * reasoning as every other SQLite-backed test in this repo.
 *
 * Every dispatch test below uses the "shell" agent ONLY — CI runs on
 * ubuntu-latest, where claude/cursor-agent/codex are not installed, and
 * shell is deterministic/cheap to assert against (see session-manager.test.ts
 * for the same convention).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoardCard } from "@vibespace/shared";
import { buildApp } from "../index.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "vibespace-board-routes-test-"));
  process.env.VIBESPACE_DATA_DIR = dataDir;
});

afterEach(() => {
  delete process.env.VIBESPACE_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

/** Waits (polling) until `condition()` is true or `timeoutMs` elapses. */
async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: condition never became true within timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Creates a throwaway workspace (via the real REST route) for tests that
 * need a valid workspaceId to hang cards off of. */
async function createWorkspace(app: ReturnType<typeof buildApp>) {
  const projectDir = mkdtempSync(join(tmpdir(), "vibespace-board-workspace-"));
  const response = await app.inject({
    method: "POST",
    url: "/api/workspaces",
    payload: { name: "board-test", rootPath: projectDir },
  });
  return response.json() as { id: string; rootPath: string };
}

describe("GET /api/board/cards", () => {
  it("400s when workspaceId is missing", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/board/cards" });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("404s for an unknown workspace", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/board/cards?workspaceId=nope" });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("returns an empty list for a fresh workspace", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const response = await app.inject({ method: "GET", url: `/api/board/cards?workspaceId=${workspace.id}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ cards: [] });
    await app.close();
  });
});

describe("POST /api/board/cards", () => {
  it("creates a card with defaults and returns 201", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/board/cards",
      payload: { workspaceId: workspace.id, title: "Fix the bug" },
    });
    expect(response.statusCode).toBe(201);
    const card = response.json() as BoardCard;
    expect(card.title).toBe("Fix the bug");
    expect(card.columnId).toBe("todo");
    expect(card.priority).toBe("medium");
    expect(card.workspaceId).toBe(workspace.id);

    const listed = await app.inject({ method: "GET", url: `/api/board/cards?workspaceId=${workspace.id}` });
    expect((listed.json() as { cards: BoardCard[] }).cards.map((c) => c.id)).toEqual([card.id]);

    await app.close();
  });

  it("400s for a missing/empty title", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/board/cards",
      payload: { workspaceId: workspace.id, title: "  " },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("400s for an invalid priority", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/board/cards",
      payload: { workspaceId: workspace.id, title: "x", priority: "urgent" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("400s for an invalid columnId", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/board/cards",
      payload: { workspaceId: workspace.id, title: "x", columnId: "done" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("404s for an unknown workspace", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/board/cards",
      payload: { workspaceId: "nope", title: "x" },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("creates a card with taskKnowledge, and 400s when it exceeds the length cap", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);

    const ok = await app.inject({
      method: "POST",
      url: "/api/board/cards",
      payload: { workspaceId: workspace.id, title: "x", taskKnowledge: "Auth lives in src/auth/*.ts." },
    });
    expect(ok.statusCode).toBe(201);
    expect((ok.json() as BoardCard).taskKnowledge).toBe("Auth lives in src/auth/*.ts.");

    const tooLong = await app.inject({
      method: "POST",
      url: "/api/board/cards",
      payload: { workspaceId: workspace.id, title: "x", taskKnowledge: "a".repeat(50_001) },
    });
    expect(tooLong.statusCode).toBe(400);

    await app.close();
  });

  it("400s when description exceeds the length cap", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/board/cards",
      payload: { workspaceId: workspace.id, title: "x", description: "a".repeat(5001) },
    });
    expect(response.statusCode).toBe(400);

    await app.close();
  });
});

describe("PATCH /api/board/cards/:id", () => {
  it("updates fields and returns the updated card", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/board/cards",
        payload: { workspaceId: workspace.id, title: "Original" },
      })
    ).json() as BoardCard;

    const response = await app.inject({
      method: "PATCH",
      url: `/api/board/cards/${created.id}`,
      payload: { title: "Renamed", priority: "critical", columnId: "in_review" },
    });
    expect(response.statusCode).toBe(200);
    const updated = response.json() as BoardCard;
    expect(updated.title).toBe("Renamed");
    expect(updated.priority).toBe("critical");
    expect(updated.columnId).toBe("in_review");

    await app.close();
  });

  it("accepts an explicit fractional position", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const a = (
      await app.inject({
        method: "POST",
        url: "/api/board/cards",
        payload: { workspaceId: workspace.id, title: "A" },
      })
    ).json() as BoardCard;
    const b = (
      await app.inject({
        method: "POST",
        url: "/api/board/cards",
        payload: { workspaceId: workspace.id, title: "B" },
      })
    ).json() as BoardCard;
    const c = (
      await app.inject({
        method: "POST",
        url: "/api/board/cards",
        payload: { workspaceId: workspace.id, title: "C" },
      })
    ).json() as BoardCard;

    const midpoint = (a.position + b.position) / 2;
    const response = await app.inject({
      method: "PATCH",
      url: `/api/board/cards/${c.id}`,
      payload: { position: midpoint },
    });
    expect(response.statusCode).toBe(200);

    const listed = (
      await app.inject({ method: "GET", url: `/api/board/cards?workspaceId=${workspace.id}` })
    ).json() as { cards: BoardCard[] };
    expect(listed.cards.map((card) => card.id)).toEqual([a.id, c.id, b.id]);

    await app.close();
  });

  it("400s for an invalid priority/columnId/position", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/board/cards",
        payload: { workspaceId: workspace.id, title: "x" },
      })
    ).json() as BoardCard;

    const badPriority = await app.inject({
      method: "PATCH",
      url: `/api/board/cards/${created.id}`,
      payload: { priority: "nope" },
    });
    expect(badPriority.statusCode).toBe(400);

    const badColumn = await app.inject({
      method: "PATCH",
      url: `/api/board/cards/${created.id}`,
      payload: { columnId: "nope" },
    });
    expect(badColumn.statusCode).toBe(400);

    const badPosition = await app.inject({
      method: "PATCH",
      url: `/api/board/cards/${created.id}`,
      payload: { position: "nope" },
    });
    expect(badPosition.statusCode).toBe(400);

    await app.close();
  });

  it("404s for an unknown card id", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/board/cards/does-not-exist",
      payload: { title: "x" },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("updates taskKnowledge independently, clears it back to null, and 400s past the length cap", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/board/cards",
        payload: { workspaceId: workspace.id, title: "x" },
      })
    ).json() as BoardCard;

    const set = await app.inject({
      method: "PATCH",
      url: `/api/board/cards/${created.id}`,
      payload: { taskKnowledge: "See ADR-3 for the schema decision." },
    });
    expect(set.statusCode).toBe(200);
    expect((set.json() as BoardCard).taskKnowledge).toBe("See ADR-3 for the schema decision.");

    const cleared = await app.inject({
      method: "PATCH",
      url: `/api/board/cards/${created.id}`,
      payload: { taskKnowledge: null },
    });
    expect((cleared.json() as BoardCard).taskKnowledge).toBeNull();

    const tooLong = await app.inject({
      method: "PATCH",
      url: `/api/board/cards/${created.id}`,
      payload: { taskKnowledge: "a".repeat(50_001) },
    });
    expect(tooLong.statusCode).toBe(400);

    await app.close();
  });

  it("accepts moving a card to the cancelled column", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/board/cards",
        payload: { workspaceId: workspace.id, title: "x" },
      })
    ).json() as BoardCard;

    const response = await app.inject({
      method: "PATCH",
      url: `/api/board/cards/${created.id}`,
      payload: { columnId: "cancelled" },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as BoardCard).columnId).toBe("cancelled");

    await app.close();
  });
});

describe("DELETE /api/board/cards/:id", () => {
  it("deletes a card and returns 204, then 404s on a second delete", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/board/cards",
        payload: { workspaceId: workspace.id, title: "Delete me" },
      })
    ).json() as BoardCard;

    const response = await app.inject({ method: "DELETE", url: `/api/board/cards/${created.id}` });
    expect(response.statusCode).toBe(204);

    const again = await app.inject({ method: "DELETE", url: `/api/board/cards/${created.id}` });
    expect(again.statusCode).toBe(404);

    await app.close();
  });

  it("404s for an unknown card id", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "DELETE", url: "/api/board/cards/does-not-exist" });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});

describe("POST /api/board/cards/:id/dispatch", () => {
  it(
    "spawns a shell session, moves the card to in_progress, records sessionId/agent, and actually types the prompt into the pty",
    async () => {
      const app = buildApp();
      const workspace = await createWorkspace(app);
      const created = (
        await app.inject({
          method: "POST",
          url: "/api/board/cards",
          payload: {
            workspaceId: workspace.id,
            title: "echo DISPATCH_TEST_MARKER",
            description: "A shell card whose title is itself a runnable echo command.",
          },
        })
      ).json() as BoardCard;

      const response = await app.inject({
        method: "POST",
        url: `/api/board/cards/${created.id}/dispatch`,
        payload: { agent: "shell" },
      });
      expect(response.statusCode).toBe(200);
      const dispatched = response.json() as BoardCard;
      expect(dispatched.columnId).toBe("in_progress");
      expect(dispatched.agent).toBe("shell");
      expect(dispatched.sessionId).toBeTruthy();

      // The whole point of dispatch: the card's title (a shell command,
      // for this test) must actually reach the pty and get executed. If
      // writePromptWhenReady dropped or mistimed the write, this history
      // check would time out.
      await waitFor(() => app.sessionManager.getHistory(dispatched.sessionId!).includes("DISPATCH_TEST_MARKER"));
      expect(app.sessionManager.getHistory(dispatched.sessionId!)).toContain("DISPATCH_TEST_MARKER");

      await app.close();
    },
    10_000
  );

  it("400s when no agent is given and the card has none set yet", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/board/cards",
        payload: { workspaceId: workspace.id, title: "x" },
      })
    ).json() as BoardCard;

    const response = await app.inject({ method: "POST", url: `/api/board/cards/${created.id}/dispatch` });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("400s for an unknown agent id", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/board/cards",
        payload: { workspaceId: workspace.id, title: "x" },
      })
    ).json() as BoardCard;

    const response = await app.inject({
      method: "POST",
      url: `/api/board/cards/${created.id}/dispatch`,
      payload: { agent: "not-a-real-agent" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("404s for an unknown card id", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/board/cards/does-not-exist/dispatch",
      payload: { agent: "shell" },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
