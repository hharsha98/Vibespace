/**
 * MailboxStore tests — ordering, broadcast vs directed messages, and the
 * `since` polling filter. Same temp-dir SQLite pattern as the other swarm
 * store tests. Uses fake timers to give messages deterministic, strictly
 * increasing `createdAt` timestamps (real-clock ms resolution would make
 * "since" tests flaky on a fast machine).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailboxStore } from "./mailbox.js";

let dataDir: string;
let store: MailboxStore;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "vibespace-mailbox-test-"));
  process.env.VIBESPACE_DATA_DIR = dataDir;
  store = new MailboxStore();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
});

afterEach(() => {
  store.close();
  delete process.env.VIBESPACE_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("MailboxStore.send", () => {
  it("null fromAgentId means the message is from the human", () => {
    const message = store.send({ missionId: "m1", toAgentId: "agent-1", body: "hello" });
    expect(message.fromAgentId).toBeNull();
    expect(message.toAgentId).toBe("agent-1");
  });

  it("null toAgentId means the message broadcasts to every agent", () => {
    const message = store.send({ missionId: "m1", fromAgentId: "agent-1", body: "status update" });
    expect(message.fromAgentId).toBe("agent-1");
    expect(message.toAgentId).toBeNull();
  });

  it("a message can be both from and to an agent (directed agent-to-agent)", () => {
    const message = store.send({ missionId: "m1", fromAgentId: "agent-1", toAgentId: "agent-2", body: "hi" });
    expect(message.fromAgentId).toBe("agent-1");
    expect(message.toAgentId).toBe("agent-2");
  });
});

describe("MailboxStore.list ordering", () => {
  it("returns messages oldest-first", () => {
    const first = store.send({ missionId: "m1", body: "first" });
    vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
    const second = store.send({ missionId: "m1", body: "second" });
    vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
    const third = store.send({ missionId: "m1", body: "third" });

    const listed = store.list("m1");
    expect(listed.map((m) => m.id)).toEqual([first.id, second.id, third.id]);
  });

  it("scopes to a mission — a different mission's messages never leak in", () => {
    store.send({ missionId: "m1", body: "for mission 1" });
    store.send({ missionId: "m2", body: "for mission 2" });

    expect(store.list("m1")).toHaveLength(1);
    expect(store.list("m2")).toHaveLength(1);
    expect(store.list("m1")[0].body).toBe("for mission 1");
  });

  it("mixes broadcast and directed messages in the same ordered list", () => {
    const broadcast = store.send({ missionId: "m1", fromAgentId: "agent-1", body: "broadcast" });
    vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
    const directed = store.send({
      missionId: "m1",
      fromAgentId: "agent-1",
      toAgentId: "agent-2",
      body: "directed",
    });

    const listed = store.list("m1");
    expect(listed).toEqual([
      expect.objectContaining({ id: broadcast.id, toAgentId: null }),
      expect.objectContaining({ id: directed.id, toAgentId: "agent-2" }),
    ]);
  });
});

describe("MailboxStore.list since", () => {
  it("with no 'since', returns every message", () => {
    store.send({ missionId: "m1", body: "one" });
    vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
    store.send({ missionId: "m1", body: "two" });

    expect(store.list("m1")).toHaveLength(2);
  });

  it("with 'since', returns only messages strictly after that timestamp", () => {
    const first = store.send({ missionId: "m1", body: "one" });
    vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
    const second = store.send({ missionId: "m1", body: "two" });
    vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
    const third = store.send({ missionId: "m1", body: "three" });

    const sinceFirst = store.list("m1", first.createdAt);
    expect(sinceFirst.map((m) => m.id)).toEqual([second.id, third.id]);

    const sinceSecond = store.list("m1", second.createdAt);
    expect(sinceSecond.map((m) => m.id)).toEqual([third.id]);
  });

  it("a 'since' timestamp at or after the last message returns an empty list", () => {
    const only = store.send({ missionId: "m1", body: "one" });
    expect(store.list("m1", only.createdAt)).toEqual([]);
  });
});
