/**
 * ClaimsStore tests, run against a real SQLite file inside a fresh
 * `mkdtempSync` temp directory — same pattern as `board.test.ts`. This is
 * the priority test file for Phase 9a: everything the ownership registry's
 * safety property rests on (see `claims.ts`'s top comment) is exercised
 * here, especially the race in "two claims on the same path".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaimsStore, CLAIM_STALE_TTL_MS, normalizeClaimPath } from "./claims.js";

let dataDir: string;
let workspaceRoot: string;
let store: ClaimsStore;

const MISSION_A = "mission-a";
const MISSION_B = "mission-b";

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "vibedeck-claims-test-"));
  process.env.VIBEDECK_DATA_DIR = dataDir;
  // A separate, real directory to be the "workspace root" claims are
  // resolved against — safeResolve requires the root itself to exist.
  workspaceRoot = mkdtempSync(join(tmpdir(), "vibedeck-claims-workspace-"));
  store = new ClaimsStore();
});

afterEach(() => {
  store.close();
  delete process.env.VIBEDECK_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("ClaimsStore.claim — the race", () => {
  it("two claims on the same path in the same mission: exactly one wins, and the loser's response names the holder", () => {
    const first = store.claim(MISSION_A, "agent-1", workspaceRoot, "src/foo.ts");
    const second = store.claim(MISSION_A, "agent-2", workspaceRoot, "src/foo.ts");

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (second.ok || second.reason !== "held") throw new Error("expected the second claim to lose, naming the holder");
    // The loser is told exactly who holds it — "agent-1", not a generic
    // "conflict" — so it can decide what to do next.
    expect(second.holder.agentId).toBe("agent-1");
    expect(second.holder.path).toBe("src/foo.ts");

    // Only one row actually exists for this path.
    expect(store.list(MISSION_A)).toHaveLength(1);
    expect(store.list(MISSION_A)[0].agentId).toBe("agent-1");
  });

  it("a third, fourth, fifth simultaneous claim on the same path all lose to the same original holder", () => {
    store.claim(MISSION_A, "agent-1", workspaceRoot, "src/shared.ts");
    for (const loser of ["agent-2", "agent-3", "agent-4"]) {
      const result = store.claim(MISSION_A, loser, workspaceRoot, "src/shared.ts");
      expect(result.ok).toBe(false);
      if (result.ok || result.reason !== "held") throw new Error("expected loser naming the holder");
      expect(result.holder.agentId).toBe("agent-1");
    }
    expect(store.list(MISSION_A)).toHaveLength(1);
  });
});

describe("ClaimsStore.claim — mission isolation", () => {
  it("the same path claimed in two different missions does not conflict", () => {
    const a = store.claim(MISSION_A, "agent-1", workspaceRoot, "src/foo.ts");
    const b = store.claim(MISSION_B, "agent-2", workspaceRoot, "src/foo.ts");

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(store.list(MISSION_A)).toHaveLength(1);
    expect(store.list(MISSION_B)).toHaveLength(1);
  });
});

describe("ClaimsStore release", () => {
  it("releasing a path makes it claimable again by someone else", () => {
    store.claim(MISSION_A, "agent-1", workspaceRoot, "src/foo.ts");
    const released = store.release(MISSION_A, "agent-1", workspaceRoot, "src/foo.ts");
    expect(released).toEqual({ ok: true, released: 1 });

    const reclaimed = store.claim(MISSION_A, "agent-2", workspaceRoot, "src/foo.ts");
    expect(reclaimed.ok).toBe(true);
    if (!reclaimed.ok) throw new Error("expected success");
    expect(reclaimed.claim.agentId).toBe("agent-2");
  });

  it("releasing a path you don't hold is a no-op, not an error", () => {
    store.claim(MISSION_A, "agent-1", workspaceRoot, "src/foo.ts");
    const result = store.release(MISSION_A, "agent-2", workspaceRoot, "src/foo.ts");
    expect(result).toEqual({ ok: true, released: 0 });
    // agent-1's claim is untouched.
    expect(store.getByPath(MISSION_A, "src/foo.ts")?.agentId).toBe("agent-1");
  });

  it("release-all-for-agent (no path given) releases every claim that agent holds, and only that agent's", () => {
    store.claim(MISSION_A, "agent-1", workspaceRoot, "src/a.ts");
    store.claim(MISSION_A, "agent-1", workspaceRoot, "src/b.ts");
    store.claim(MISSION_A, "agent-2", workspaceRoot, "src/c.ts");

    const released = store.release(MISSION_A, "agent-1");
    expect(released).toEqual({ ok: true, released: 2 });

    const remaining = store.list(MISSION_A);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].agentId).toBe("agent-2");
  });

  it("releaseAllForMission clears every claim regardless of holder (mission stop)", () => {
    store.claim(MISSION_A, "agent-1", workspaceRoot, "src/a.ts");
    store.claim(MISSION_A, "agent-2", workspaceRoot, "src/b.ts");
    store.claim(MISSION_B, "agent-3", workspaceRoot, "src/c.ts");

    const released = store.releaseAllForMission(MISSION_A);
    expect(released).toBe(2);
    expect(store.list(MISSION_A)).toEqual([]);
    // The other mission's claims are untouched.
    expect(store.list(MISSION_B)).toHaveLength(1);
  });
});

describe("ClaimsStore path normalization", () => {
  it("'./src/a.ts', 'src/a.ts', and 'src//a.ts' all collide as the same claim", () => {
    const first = store.claim(MISSION_A, "agent-1", workspaceRoot, "src/a.ts");
    expect(first.ok).toBe(true);

    for (const variant of ["./src/a.ts", "src//a.ts"]) {
      const result = store.claim(MISSION_A, "agent-2", workspaceRoot, variant);
      expect(result.ok, `"${variant}" should collide with "src/a.ts"`).toBe(false);
    }
    expect(store.list(MISSION_A)).toHaveLength(1);
  });

  it("normalizeClaimPath collapses './src/a.ts' and 'src/a.ts' to the identical stored form", () => {
    const a = normalizeClaimPath(workspaceRoot, "./src/a.ts");
    const b = normalizeClaimPath(workspaceRoot, "src/a.ts");
    expect(a).toEqual({ ok: true, path: "src/a.ts" });
    expect(b).toEqual({ ok: true, path: "src/a.ts" });
  });

  it("rejects a path that escapes the workspace root", () => {
    const result = store.claim(MISSION_A, "agent-1", workspaceRoot, "../../etc/passwd");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.reason).toBe("invalid-path");
    expect(store.list(MISSION_A)).toEqual([]);
  });

  it("rejects an absolute path", () => {
    const result = store.claim(MISSION_A, "agent-1", workspaceRoot, "/etc/passwd");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.reason).toBe("invalid-path");
  });
});

describe("ClaimsStore staleness / heartbeat TTL", () => {
  it("a claim with no heartbeat for longer than CLAIM_STALE_TTL_MS is reclaimable by a different agent", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const first = store.claim(MISSION_A, "agent-1", workspaceRoot, "src/foo.ts");
    expect(first.ok).toBe(true);

    // Jump forward past the TTL with no heartbeat in between.
    vi.setSystemTime(new Date(Date.now() + CLAIM_STALE_TTL_MS + 1000));

    const reclaimed = store.claim(MISSION_A, "agent-2", workspaceRoot, "src/foo.ts");
    expect(reclaimed.ok).toBe(true);
    if (!reclaimed.ok) throw new Error("expected the stale claim to be reclaimable");
    expect(reclaimed.claim.agentId).toBe("agent-2");
    // Still exactly one row — reclaiming re-stamps the existing row rather
    // than inserting a second one.
    expect(store.list(MISSION_A)).toHaveLength(1);
  });

  it("a FRESH claim (heartbeat within the TTL) is NOT reclaimable", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const first = store.claim(MISSION_A, "agent-1", workspaceRoot, "src/foo.ts");
    expect(first.ok).toBe(true);

    // Jump forward, but heartbeat right before doing so — still fresh.
    store.heartbeat(MISSION_A, "agent-1");
    vi.setSystemTime(new Date(Date.now() + CLAIM_STALE_TTL_MS - 1000));

    const attempt = store.claim(MISSION_A, "agent-2", workspaceRoot, "src/foo.ts");
    expect(attempt.ok).toBe(false);
    if (attempt.ok || attempt.reason !== "held") throw new Error("expected the fresh claim to hold, naming the holder");
    expect(attempt.holder.agentId).toBe("agent-1");
  });

  it("heartbeat() refreshes last_heartbeat_at and returns the count refreshed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    store.claim(MISSION_A, "agent-1", workspaceRoot, "src/a.ts");
    store.claim(MISSION_A, "agent-1", workspaceRoot, "src/b.ts");

    vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));
    const count = store.heartbeat(MISSION_A, "agent-1");
    expect(count).toBe(2);

    const claims = store.list(MISSION_A);
    for (const claim of claims) {
      expect(claim.lastHeartbeatAt).toBe("2026-01-01T00:05:00.000Z");
      // claimed_at is untouched by a heartbeat.
      expect(claim.claimedAt).toBe("2026-01-01T00:00:00.000Z");
    }
  });

  it("isStale() reflects CLAIM_STALE_TTL_MS exactly", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const result = store.claim(MISSION_A, "agent-1", workspaceRoot, "src/foo.ts");
    if (!result.ok) throw new Error("expected success");

    const justUnder = new Date("2026-01-01T00:00:00.000Z").getTime() + CLAIM_STALE_TTL_MS - 1;
    const justOver = new Date("2026-01-01T00:00:00.000Z").getTime() + CLAIM_STALE_TTL_MS + 1;
    expect(store.isStale(result.claim, justUnder)).toBe(false);
    expect(store.isStale(result.claim, justOver)).toBe(true);
  });
});

describe("ClaimsStore conflict recording", () => {
  it("records and lists conflicts for a mission", () => {
    expect(store.listConflicts(MISSION_A)).toEqual([]);
    const conflict = store.recordConflict(MISSION_A, "src/foo.ts", "agent-1");
    expect(conflict.missionId).toBe(MISSION_A);
    expect(conflict.path).toBe("src/foo.ts");
    expect(conflict.holderAgentId).toBe("agent-1");

    const listed = store.listConflicts(MISSION_A);
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(conflict.id);
  });

  it("conflicts are scoped per mission", () => {
    store.recordConflict(MISSION_A, "src/foo.ts", "agent-1");
    expect(store.listConflicts(MISSION_B)).toEqual([]);
  });
});
