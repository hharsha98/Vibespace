/**
 * CRUD + duplicate-name + Duplicate() tests for SshProfileStore, run against
 * a real SQLite file inside a fresh `mkdtempSync` temp directory — same
 * pattern as `agents/store.test.ts`/`db/board.test.ts`. NEVER the
 * developer's real `~/.vibespace/vibespace.db`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SshProfileStore } from "./store.js";

let dataDir: string;
let store: SshProfileStore;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "vibespace-ssh-store-test-"));
  process.env.VIBESPACE_DATA_DIR = dataDir;
  store = new SshProfileStore();
});

afterEach(() => {
  store.close();
  delete process.env.VIBESPACE_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("SshProfileStore CRUD", () => {
  it("starts empty", () => {
    expect(store.list()).toEqual([]);
  });

  it("creates a profile with a generated id and matching timestamps", () => {
    const result = store.create({
      name: "prod-server",
      host: "prod.example.com",
      user: "deploy",
      port: 2222,
      defaultDirectory: "/srv/app",
      startupCommand: "source .venv/bin/activate",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.profile.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(result.profile.name).toBe("prod-server");
    expect(result.profile.host).toBe("prod.example.com");
    expect(result.profile.user).toBe("deploy");
    expect(result.profile.port).toBe(2222);
    expect(result.profile.defaultDirectory).toBe("/srv/app");
    expect(result.profile.startupCommand).toBe("source .venv/bin/activate");
    expect(result.profile.createdAt).toBe(result.profile.updatedAt);
  });

  it("creates a minimal profile with every optional field null", () => {
    const result = store.create({
      name: "minimal",
      host: "example.com",
      user: null,
      port: null,
      defaultDirectory: null,
      startupCommand: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.user).toBeNull();
    expect(result.profile.port).toBeNull();
    expect(result.profile.defaultDirectory).toBeNull();
    expect(result.profile.startupCommand).toBeNull();
  });

  it("get() returns undefined for an unknown id", () => {
    expect(store.get("does-not-exist")).toBeUndefined();
  });

  it("get() returns the profile for a known id", () => {
    const created = store.create({
      name: "findable",
      host: "example.com",
      user: null,
      port: null,
      defaultDirectory: null,
      startupCommand: null,
    });
    if (!created.ok) throw new Error("setup failed");
    expect(store.get(created.profile.id)).toEqual(created.profile);
  });

  it("list() returns every profile sorted by name", () => {
    store.create({ name: "zeta", host: "z.example.com", user: null, port: null, defaultDirectory: null, startupCommand: null });
    store.create({ name: "alpha", host: "a.example.com", user: null, port: null, defaultDirectory: null, startupCommand: null });
    store.create({ name: "mid", host: "m.example.com", user: null, port: null, defaultDirectory: null, startupCommand: null });

    expect(store.list().map((p) => p.name)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("create() rejects a duplicate name with a discriminated result, not a thrown error", () => {
    store.create({ name: "taken", host: "a.example.com", user: null, port: null, defaultDirectory: null, startupCommand: null });
    const result = store.create({ name: "taken", host: "b.example.com", user: null, port: null, defaultDirectory: null, startupCommand: null });
    expect(result).toEqual({ ok: false, reason: "duplicate-name" });
    // The name really is still owned by the FIRST profile — the failed
    // second create() must not have partially written anything.
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].host).toBe("a.example.com");
  });

  it("update() changes only the given fields, leaving the rest untouched", () => {
    const created = store.create({
      name: "before",
      host: "before.example.com",
      user: "olduser",
      port: 22,
      defaultDirectory: "/old",
      startupCommand: "old-cmd",
    });
    if (!created.ok) throw new Error("setup failed");

    const updated = store.update(created.profile.id, { name: "after", port: 2200 });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.profile.name).toBe("after");
    expect(updated.profile.port).toBe(2200);
    // Untouched fields survive the partial patch.
    expect(updated.profile.host).toBe("before.example.com");
    expect(updated.profile.user).toBe("olduser");
    expect(updated.profile.defaultDirectory).toBe("/old");
    expect(updated.profile.startupCommand).toBe("old-cmd");
  });

  it("update() can explicitly clear a nullable field back to null", () => {
    const created = store.create({
      name: "clearable",
      host: "example.com",
      user: "someone",
      port: 22,
      defaultDirectory: "/somewhere",
      startupCommand: "echo hi",
    });
    if (!created.ok) throw new Error("setup failed");

    const updated = store.update(created.profile.id, {
      user: null,
      port: null,
      defaultDirectory: null,
      startupCommand: null,
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.profile.user).toBeNull();
    expect(updated.profile.port).toBeNull();
    expect(updated.profile.defaultDirectory).toBeNull();
    expect(updated.profile.startupCommand).toBeNull();
  });

  it("update() returns not-found for an unknown id", () => {
    expect(store.update("does-not-exist", { name: "x" })).toEqual({ ok: false, reason: "not-found" });
  });

  it("update() rejects renaming to a name another profile already holds", () => {
    store.create({ name: "one", host: "a.example.com", user: null, port: null, defaultDirectory: null, startupCommand: null });
    const two = store.create({ name: "two", host: "b.example.com", user: null, port: null, defaultDirectory: null, startupCommand: null });
    if (!two.ok) throw new Error("setup failed");

    expect(store.update(two.profile.id, { name: "one" })).toEqual({ ok: false, reason: "duplicate-name" });
    // The rename must not have partially applied.
    expect(store.get(two.profile.id)!.name).toBe("two");
  });

  it("remove() deletes a profile and returns true", () => {
    const created = store.create({ name: "gone-soon", host: "example.com", user: null, port: null, defaultDirectory: null, startupCommand: null });
    if (!created.ok) throw new Error("setup failed");

    expect(store.remove(created.profile.id)).toBe(true);
    expect(store.get(created.profile.id)).toBeUndefined();
  });

  it("remove() returns false for an unknown id", () => {
    expect(store.remove("does-not-exist")).toBe(false);
  });
});

describe("SshProfileStore.duplicate", () => {
  it("copies every field except id/timestamps into a new profile", () => {
    const original = store.create({
      name: "original",
      host: "prod.example.com",
      user: "deploy",
      port: 2222,
      defaultDirectory: "/srv/app",
      startupCommand: "source .venv/bin/activate",
    });
    if (!original.ok) throw new Error("setup failed");

    const copy = store.duplicate(original.profile.id);
    expect(copy.ok).toBe(true);
    if (!copy.ok) return;

    expect(copy.profile.id).not.toBe(original.profile.id);
    expect(copy.profile.name).toBe("original copy");
    expect(copy.profile.host).toBe(original.profile.host);
    expect(copy.profile.user).toBe(original.profile.user);
    expect(copy.profile.port).toBe(original.profile.port);
    expect(copy.profile.defaultDirectory).toBe(original.profile.defaultDirectory);
    expect(copy.profile.startupCommand).toBe(original.profile.startupCommand);

    // The original is untouched, and both now exist independently.
    expect(store.list()).toHaveLength(2);
    expect(store.get(original.profile.id)!.name).toBe("original");
  });

  it("picks the next free numbered name when 'X copy' is already taken", () => {
    const original = store.create({ name: "server", host: "a.example.com", user: null, port: null, defaultDirectory: null, startupCommand: null });
    if (!original.ok) throw new Error("setup failed");

    // Pre-occupy "server copy" by hand, simulating a previous duplicate.
    store.create({ name: "server copy", host: "b.example.com", user: null, port: null, defaultDirectory: null, startupCommand: null });

    const second = store.duplicate(original.profile.id);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.profile.name).toBe("server copy 2");

    const third = store.duplicate(original.profile.id);
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.profile.name).toBe("server copy 3");
  });

  it("returns not-found when duplicating an unknown id", () => {
    expect(store.duplicate("does-not-exist")).toEqual({ ok: false, reason: "not-found" });
  });
});
