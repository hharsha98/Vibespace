import { describe, expect, it } from "vitest";
import { buildApp } from "./index.js";

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
  });
});
