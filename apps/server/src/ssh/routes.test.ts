/**
 * Route tests for the SSH profile CRUD + Duplicate endpoints, exercised via
 * `app.inject()` (in-process, no real network port) — same pattern as
 * `agents/routes.test.ts`. `VIBESPACE_DATA_DIR` is pointed at a fresh temp
 * directory per test, never the developer's real `~/.vibespace`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SshProfile } from "@vibespace/shared";
import { buildApp } from "../index.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "vibespace-ssh-routes-test-"));
  process.env.VIBESPACE_DATA_DIR = dataDir;
});

afterEach(() => {
  delete process.env.VIBESPACE_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("GET /api/ssh-profiles", () => {
  it("returns an empty list with no profiles created yet", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/ssh-profiles" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ profiles: [] });
    await app.close();
  });
});

describe("POST /api/ssh-profiles", () => {
  it("creates a profile and returns 201", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/ssh-profiles",
      payload: {
        name: "prod-server",
        host: "prod.example.com",
        user: "deploy",
        port: 2222,
        defaultDirectory: "/srv/app",
        startupCommand: "source .venv/bin/activate",
      },
    });
    expect(response.statusCode).toBe(201);
    const profile = response.json() as SshProfile;
    expect(profile.name).toBe("prod-server");
    expect(profile.host).toBe("prod.example.com");
    expect(profile.user).toBe("deploy");
    expect(profile.port).toBe(2222);
    expect(profile.defaultDirectory).toBe("/srv/app");
    expect(profile.startupCommand).toBe("source .venv/bin/activate");
    await app.close();
  });

  it("accepts a minimal profile with only name and host", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/ssh-profiles",
      payload: { name: "minimal", host: "example.com" },
    });
    expect(response.statusCode).toBe(201);
    const profile = response.json() as SshProfile;
    expect(profile.user).toBeNull();
    expect(profile.port).toBeNull();
    expect(profile.defaultDirectory).toBeNull();
    expect(profile.startupCommand).toBeNull();
    await app.close();
  });

  it("400s when name is missing", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "POST", url: "/api/ssh-profiles", payload: { host: "example.com" } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: '"name" must be a non-empty string' });
    await app.close();
  });

  it("400s when host is missing", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "POST", url: "/api/ssh-profiles", payload: { name: "x" } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: '"host" must be a non-empty string' });
    await app.close();
  });

  it("400s on an out-of-range port", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/ssh-profiles",
      payload: { name: "x", host: "example.com", port: 99999 },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("400s on a non-integer port", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/ssh-profiles",
      payload: { name: "x", host: "example.com", port: 22.5 },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("409s naming the conflict when the name is already taken", async () => {
    const app = buildApp();
    await app.inject({ method: "POST", url: "/api/ssh-profiles", payload: { name: "dup", host: "a.example.com" } });
    const response = await app.inject({ method: "POST", url: "/api/ssh-profiles", payload: { name: "dup", host: "b.example.com" } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'An SSH profile named "dup" already exists' });
    await app.close();
  });
});

describe("GET /api/ssh-profiles/:id", () => {
  it("404s for an unknown id", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/ssh-profiles/does-not-exist" });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("returns a created profile by id", async () => {
    const app = buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/ssh-profiles",
      payload: { name: "findable", host: "example.com" },
    });
    const { id } = created.json() as SshProfile;

    const response = await app.inject({ method: "GET", url: `/api/ssh-profiles/${id}` });
    expect(response.statusCode).toBe(200);
    expect((response.json() as SshProfile).name).toBe("findable");
    await app.close();
  });
});

describe("PATCH /api/ssh-profiles/:id", () => {
  it("updates fields and returns the updated profile", async () => {
    const app = buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/ssh-profiles",
      payload: { name: "before", host: "before.example.com" },
    });
    const { id } = created.json() as SshProfile;

    const response = await app.inject({
      method: "PATCH",
      url: `/api/ssh-profiles/${id}`,
      payload: { name: "after", port: 2200 },
    });
    expect(response.statusCode).toBe(200);
    const updated = response.json() as SshProfile;
    expect(updated.name).toBe("after");
    expect(updated.port).toBe(2200);
    expect(updated.host).toBe("before.example.com"); // untouched
    await app.close();
  });

  it("404s for an unknown id", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "PATCH", url: "/api/ssh-profiles/does-not-exist", payload: { name: "x" } });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("409s naming the conflict when renaming into a taken name", async () => {
    const app = buildApp();
    await app.inject({ method: "POST", url: "/api/ssh-profiles", payload: { name: "one", host: "a.example.com" } });
    const two = await app.inject({ method: "POST", url: "/api/ssh-profiles", payload: { name: "two", host: "b.example.com" } });
    const { id } = two.json() as SshProfile;

    const response = await app.inject({ method: "PATCH", url: `/api/ssh-profiles/${id}`, payload: { name: "one" } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'An SSH profile named "one" already exists' });
    await app.close();
  });
});

describe("DELETE /api/ssh-profiles/:id", () => {
  it("deletes a profile and returns 204", async () => {
    const app = buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/ssh-profiles",
      payload: { name: "gone-soon", host: "example.com" },
    });
    const { id } = created.json() as SshProfile;

    const response = await app.inject({ method: "DELETE", url: `/api/ssh-profiles/${id}` });
    expect(response.statusCode).toBe(204);

    const after = await app.inject({ method: "GET", url: `/api/ssh-profiles/${id}` });
    expect(after.statusCode).toBe(404);
    await app.close();
  });

  it("404s for an unknown id", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "DELETE", url: "/api/ssh-profiles/does-not-exist" });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});

describe("POST /api/ssh-profiles/:id/duplicate", () => {
  it("creates a new profile with a derived name and the same fields", async () => {
    const app = buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/ssh-profiles",
      payload: {
        name: "original",
        host: "prod.example.com",
        user: "deploy",
        port: 2222,
        defaultDirectory: "/srv/app",
        startupCommand: "source .venv/bin/activate",
      },
    });
    const original = created.json() as SshProfile;

    const response = await app.inject({ method: "POST", url: `/api/ssh-profiles/${original.id}/duplicate` });
    expect(response.statusCode).toBe(201);
    const copy = response.json() as SshProfile;
    expect(copy.id).not.toBe(original.id);
    expect(copy.name).toBe("original copy");
    expect(copy.host).toBe(original.host);
    expect(copy.user).toBe(original.user);
    expect(copy.port).toBe(original.port);
    expect(copy.defaultDirectory).toBe(original.defaultDirectory);
    expect(copy.startupCommand).toBe(original.startupCommand);

    const list = await app.inject({ method: "GET", url: "/api/ssh-profiles" });
    expect((list.json() as { profiles: SshProfile[] }).profiles).toHaveLength(2);
    await app.close();
  });

  it("404s when duplicating an unknown id", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "POST", url: "/api/ssh-profiles/does-not-exist/duplicate" });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("duplicating twice picks distinct, non-colliding names each time", async () => {
    const app = buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/ssh-profiles",
      payload: { name: "server", host: "example.com" },
    });
    const original = created.json() as SshProfile;

    const first = await app.inject({ method: "POST", url: `/api/ssh-profiles/${original.id}/duplicate` });
    const second = await app.inject({ method: "POST", url: `/api/ssh-profiles/${original.id}/duplicate` });
    expect((first.json() as SshProfile).name).toBe("server copy");
    expect((second.json() as SshProfile).name).toBe("server copy 2");
    await app.close();
  });
});
