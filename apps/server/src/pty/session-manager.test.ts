import { afterEach, describe, expect, it } from "vitest";
import { SessionManager, buildSpawnEnv } from "./session-manager.js";

/**
 * All tests here use the "shell" agent only (never claude/cursor-agent/
 * codex) because CI runs on ubuntu-latest, where none of the AI CLIs are
 * installed. "shell" resolves to a real, always-present shell binary on
 * every machine these tests run on.
 */

/** Poll a condition until it's true or a timeout elapses, instead of a fixed sleep. */
async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: condition never became true within timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("SessionManager", () => {
  let manager: SessionManager;

  afterEach(() => {
    // Always dispose so no stray shell processes leak between tests / after
    // the whole suite finishes (otherwise vitest can hang on exit).
    manager?.disposeAll();
  });

  it(
    "creates a running session with sensible defaults",
    () => {
      manager = new SessionManager();
      const info = manager.create({ agent: "shell" });

      expect(info.agent).toBe("shell");
      expect(info.status).toBe("running");
      expect(info.exitCode).toBeNull();
      expect(info.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(new Date(info.createdAt).toISOString()).toBe(info.createdAt);
      expect(manager.get(info.id)).toEqual(info);
    },
    10_000
  );

  // SSH connection profiles: `sshProfileId` is the new field on SessionInfo
  // that tells a remote pane apart from a local one (see
  // packages/shared/src/protocol.ts's SessionInfo doc comment). This test
  // deliberately does NOT spawn a real `ssh` process (see spawn.test.ts's
  // own top comment for why: no host to reach, would hang CI) — it only
  // confirms the field defaults to `null` for an ordinary local session,
  // which is the regression this new field could otherwise introduce. The
  // ssh-path argv/quoting logic itself is exhaustively covered by
  // `../ssh/spawn.test.ts`'s 33 tests, and `create()`'s few-line routing
  // between the two paths is straightforward enough to verify by reading
  // `session-manager.ts` directly.
  it(
    "sets sshProfileId to null for an ordinary (non-SSH) session",
    () => {
      manager = new SessionManager();
      const info = manager.create({ agent: "shell" });
      expect(info.sshProfileId).toBeNull();
    },
    10_000
  );

  it(
    "streams live output to attached listeners and records it in history",
    async () => {
      manager = new SessionManager();
      const info = manager.create({ agent: "shell", cols: 80, rows: 24 });

      let collected = "";
      const unsubscribe = manager.attach(info.id, (event) => {
        if (event.type === "output") collected += event.data;
      });

      manager.write(info.id, "echo SESSION_MANAGER_TEST_OK\n");

      await waitFor(() => collected.includes("SESSION_MANAGER_TEST_OK"));
      expect(collected).toContain("SESSION_MANAGER_TEST_OK");

      // History should contain the same output, since it's captured
      // independently of any listener being attached.
      await waitFor(() => manager.getHistory(info.id).includes("SESSION_MANAGER_TEST_OK"));
      expect(manager.getHistory(info.id)).toContain("SESSION_MANAGER_TEST_OK");

      unsubscribe();
    },
    10_000
  );

  it(
    "broadcasts to multiple simultaneously-attached listeners",
    async () => {
      manager = new SessionManager();
      const info = manager.create({ agent: "shell" });

      let a = "";
      let b = "";
      manager.attach(info.id, (event) => {
        if (event.type === "output") a += event.data;
      });
      manager.attach(info.id, (event) => {
        if (event.type === "output") b += event.data;
      });

      manager.write(info.id, "echo BROADCAST_TEST\n");

      await waitFor(() => a.includes("BROADCAST_TEST") && b.includes("BROADCAST_TEST"));
      expect(a).toContain("BROADCAST_TEST");
      expect(b).toContain("BROADCAST_TEST");
    },
    10_000
  );

  it(
    "keeps the session (with its final scrollback) after the process exits",
    async () => {
      manager = new SessionManager();
      const info = manager.create({ agent: "shell" });

      let exited = false;
      let exitCode: number | undefined;
      manager.attach(info.id, (event) => {
        if (event.type === "exit") {
          exited = true;
          exitCode = event.code;
        }
      });

      manager.write(info.id, "exit 0\n");

      await waitFor(() => exited);
      expect(exitCode).toBe(0);

      // Session should still be retrievable (not removed from the map) so
      // a reattaching client can read the final history and see the exit.
      const finalInfo = manager.get(info.id);
      expect(finalInfo?.status).toBe("exited");
      expect(finalInfo?.exitCode).toBe(0);
    },
    10_000
  );

  it("throws a clear error for unknown session ids, without crashing", () => {
    manager = new SessionManager();
    expect(() => manager.write("does-not-exist", "x")).toThrow(/does-not-exist/);
    expect(() => manager.resize("does-not-exist", 80, 24)).toThrow();
    expect(() => manager.kill("does-not-exist")).toThrow();
    expect(() => manager.getHistory("does-not-exist")).toThrow();
    expect(() => manager.attach("does-not-exist", () => {})).toThrow();
  });

  it(
    "list() reflects every created session",
    () => {
      manager = new SessionManager();
      const a = manager.create({ agent: "shell" });
      const b = manager.create({ agent: "shell" });

      const ids = manager.list().map((s) => s.id);
      expect(ids).toEqual(expect.arrayContaining([a.id, b.id]));
    },
    10_000
  );

  it(
    "a 'shell' session's pty actually receives the ZDOTDIR shell-integration env vars",
    async () => {
      manager = new SessionManager();
      const info = manager.create({ agent: "shell" });

      let collected = "";
      manager.attach(info.id, (event) => {
        if (event.type === "output") collected += event.data;
      });

      manager.write(info.id, "echo ZDOTDIR_IS:$ZDOTDIR:REAL_IS:$_VIBEDECK_REAL_ZDOTDIR:END\n");

      // The pty echoes the TYPED line back first (with $ZDOTDIR still
      // literal, unresolved) — waiting on the RESOLVED pattern (real
      // slashes where the variables were) is what actually proves the env
      // vars reached the shell, not just that our keystrokes were echoed.
      const resolved = /ZDOTDIR_IS:\/.*vibedeck-zdotdir-.*:REAL_IS:\/.*:END/;
      await waitFor(() => resolved.test(collected));
      expect(collected).toMatch(resolved);
    },
    10_000
  );
});

describe("buildSpawnEnv", () => {
  it("applies shell-integration env only for the 'shell' agent", () => {
    const integrationEnv = { ZDOTDIR: "/tmp/some-zdotdir", _VIBEDECK_REAL_ZDOTDIR: "/Users/example" };

    const shellEnv = buildSpawnEnv("shell", {}, integrationEnv);
    expect(shellEnv.ZDOTDIR).toBe("/tmp/some-zdotdir");
    expect(shellEnv._VIBEDECK_REAL_ZDOTDIR).toBe("/Users/example");

    // claude/cursor-agent/codex are full-screen TUIs, not shells — they
    // must spawn exactly as before, even if shell-integration env happens
    // to be available (e.g. it was already created for a "shell" pane
    // earlier in the same server's lifetime).
    for (const agent of ["claude", "cursor-agent", "codex"] as const) {
      const env = buildSpawnEnv(agent, {}, integrationEnv);
      expect(env.ZDOTDIR).toBeUndefined();
      expect(env._VIBEDECK_REAL_ZDOTDIR).toBeUndefined();
    }
  });

  it("passes through unchanged when shellIntegrationEnv is null (disabled, or non-shell agent)", () => {
    const env = buildSpawnEnv("shell", { PATH: "/usr/bin" }, null);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.ZDOTDIR).toBeUndefined();
  });

  it("always sets TERM/COLORTERM regardless of agent", () => {
    const env = buildSpawnEnv("codex", {}, null);
    expect(env.TERM).toBe("xterm-256color");
    expect(env.COLORTERM).toBe("truecolor");
  });

  it("preserves the base env's other variables (e.g. PATH) unchanged", () => {
    const env = buildSpawnEnv("shell", { PATH: "/usr/bin:/bin", HOME: "/Users/example" }, null);
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/Users/example");
  });
});
