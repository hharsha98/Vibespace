import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { AddressInfo } from "node:net";
import type { ServerMessage } from "@vibedeck/shared";
import { buildApp } from "./index.js";

/**
 * All PTY-backed tests below use the "shell" agent only. CI runs on
 * ubuntu-latest, where claude/cursor-agent/codex are not installed — a
 * test that assumes one of those exists would only pass on Harsha's Mac.
 */

describe("GET /api/health", () => {
  it("returns 200 with status, version, and the supported agent list", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body).toEqual({
      status: "ok",
      version: expect.any(String),
      agents: ["claude", "cursor-agent", "codex", "shell"],
    });

    await app.close();
  });
});

describe("GET /api/agents", () => {
  it("reports availability for every known agent, shell always available", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/agents" });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      agents: { id: string; displayName: string; available: boolean }[];
    };
    expect(body.agents).toHaveLength(4);
    const shell = body.agents.find((a) => a.id === "shell");
    expect(shell?.available).toBe(true);
    expect(shell?.displayName).toBe("Shell");

    await app.close();
  });
});

describe("session REST endpoints", () => {
  it("POST /api/sessions rejects an unknown agent with 400", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { agent: "not-a-real-agent" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("POST /api/sessions returns 409 with an install hint for a missing agent binary", async () => {
    // codex is guaranteed absent on the ubuntu-latest CI runner, and may
    // also be absent locally — either way this exercises the 409 path
    // whenever it's actually missing. If codex happens to be installed
    // (e.g. some future dev machine), skip rather than false-fail.
    const app = buildApp();
    const agentsResponse = await app.inject({ method: "GET", url: "/api/agents" });
    const agents = (agentsResponse.json() as { agents: { id: string; available: boolean }[] })
      .agents;
    const codex = agents.find((a) => a.id === "codex");

    if (codex?.available) {
      await app.close();
      return;
    }

    const response = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { agent: "codex" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: expect.stringContaining("codex") });
    await app.close();
  });

  it(
    "creates, lists, and deletes a shell session",
    async () => {
      const app = buildApp();

      const createResponse = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { agent: "shell" },
      });
      expect(createResponse.statusCode).toBe(201);
      const info = createResponse.json() as { id: string; agent: string; status: string };
      expect(info.agent).toBe("shell");
      expect(info.status).toBe("running");

      const listResponse = await app.inject({ method: "GET", url: "/api/sessions" });
      const { sessions } = listResponse.json() as { sessions: { id: string }[] };
      expect(sessions.map((s) => s.id)).toContain(info.id);

      const deleteResponse = await app.inject({
        method: "DELETE",
        url: `/api/sessions/${info.id}`,
      });
      expect(deleteResponse.statusCode).toBe(204);

      const deleteUnknown = await app.inject({
        method: "DELETE",
        url: "/api/sessions/does-not-exist",
      });
      expect(deleteUnknown.statusCode).toBe(404);

      await app.close();
    },
    10_000
  );
});

describe("WebSocket session stream", () => {
  let closeServer: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await closeServer?.();
    closeServer = undefined;
  });

  it(
    "sends a ready handshake with history/size, then streams live output for input",
    async () => {
      const app = buildApp();
      await app.listen({ port: 0, host: "127.0.0.1" });
      closeServer = () => app.close();

      const { port } = app.server.address() as AddressInfo;

      const createResponse = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { agent: "shell", cols: 100, rows: 30 },
      });
      const info = createResponse.json() as { id: string };

      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${info.id}/ws`);

      const messages: ServerMessage[] = [];
      const gotOutput = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("timed out waiting for output")), 8_000);
        ws.on("message", (raw: Buffer) => {
          const message = JSON.parse(raw.toString()) as ServerMessage;
          messages.push(message);

          if (message.type === "ready") {
            // Now that we're attached, send input and wait for it to echo back.
            ws.send(JSON.stringify({ type: "input", sessionId: info.id, data: "echo WS_TEST_OK\n" }));
          }

          if (message.type === "output" && message.data.includes("WS_TEST_OK")) {
            clearTimeout(timeout);
            resolve();
          }
        });
        ws.on("error", reject);
      });

      await gotOutput;
      ws.close();

      const ready = messages.find((m) => m.type === "ready");
      expect(ready).toBeDefined();
      if (ready?.type === "ready") {
        expect(ready.cols).toBe(100);
        expect(ready.rows).toBe(30);
        expect(ready.sessionId).toBe(info.id);
      }

      await app.close();
      closeServer = undefined;
    },
    10_000
  );

  it(
    "closes the socket with a clear reason for an unknown session id",
    async () => {
      const app = buildApp();
      await app.listen({ port: 0, host: "127.0.0.1" });
      closeServer = () => app.close();
      const { port } = app.server.address() as AddressInfo;

      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/does-not-exist/ws`);

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
