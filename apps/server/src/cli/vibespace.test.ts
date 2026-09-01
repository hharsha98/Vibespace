/**
 * Two kinds of coverage here, mirroring the split in vibespace.ts itself:
 *
 *   - `runVibespaceCli` — every branch of the pure orchestration logic
 *     (path validation, port discovery, server-start timeout, workspace
 *     errors, the final URL) driven with fake `VibespaceCliDeps`. No real
 *     network call, no real child process, no real browser launch.
 *   - `ensureWorkspace` — the one piece of this module that DOES talk to a
 *     real server, tested against an actual `buildApp()` instance listening
 *     on an OS-assigned ephemeral port (same pattern `index.test.ts`'s
 *     WebSocket tests use), backed by a fresh `mkdtempSync` temp directory
 *     via `VIBESPACE_DATA_DIR` — never the developer's real `~/.vibespace`.
 *     This is what actually proves the "reuse by exact rootPath match, else
 *     create" contract round-trips through the real REST API shape, not
 *     just a hand-written mock of it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { buildApp } from "../index.js";
import type { ResolveRootPathResult } from "../workspace-path.js";
import { ensureWorkspace, runVibespaceCli, type VibespaceCliDeps } from "./vibespace.js";

// --- runVibespaceCli ---------------------------------------------------------

/** Builds a fully-stubbed `VibespaceCliDeps`, with every field overridable —
 * each test only specifies the handful of fields its scenario actually
 * cares about, same "sensible all-succeed defaults, override what you're
 * testing" shape other fixture builders in this repo use. */
function fakeDeps(overrides: Partial<VibespaceCliDeps> = {}): VibespaceCliDeps {
  return {
    resolvePath: (input) => ({ ok: true, path: `/resolved/${input}` }),
    candidatePorts: [4317, 45317],
    defaultPort: 4317,
    isServerUp: async () => true,
    startServer: () => {},
    waitForServerUp: async () => true,
    ensureWorkspace: async () => ({ id: "ws-1", name: "resolved", reused: true }),
    openUrl: async () => {},
    log: () => {},
    logError: () => {},
    ...overrides,
  };
}

describe("runVibespaceCli", () => {
  it("defaults the path argument to '.' when argv is empty", async () => {
    let seenInput: string | undefined;
    const deps = fakeDeps({
      resolvePath: (input) => {
        seenInput = input;
        return { ok: true, path: "/cwd" };
      },
    });
    await runVibespaceCli([], deps);
    expect(seenInput).toBe(".");
  });

  it("passes argv[0] through to resolvePath verbatim", async () => {
    let seenInput: string | undefined;
    const deps = fakeDeps({
      resolvePath: (input) => {
        seenInput = input;
        return { ok: true, path: "/somewhere" };
      },
    });
    await runVibespaceCli(["../other-project"], deps);
    expect(seenInput).toBe("../other-project");
  });

  it("fails fast with the resolver's message when the path doesn't exist", async () => {
    const errors: string[] = [];
    const badResolve = (): ResolveRootPathResult => ({
      ok: false,
      error: 'Directory "/nope" does not exist',
    });
    const deps = fakeDeps({ resolvePath: badResolve, logError: (m) => errors.push(m) });

    const code = await runVibespaceCli(["/nope"], deps);

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("does not exist");
  });

  it("fails fast with the resolver's message when the path is a file, not a directory", async () => {
    const errors: string[] = [];
    const deps = fakeDeps({
      resolvePath: () => ({ ok: false, error: '"/some/file.txt" exists but is not a directory' }),
      logError: (m) => errors.push(m),
    });

    const code = await runVibespaceCli(["file.txt"], deps);

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("not a directory");
  });

  it("reuses an already-running server on the FIRST candidate port that answers, without starting a new one", async () => {
    const checked: number[] = [];
    let startCalled = false;
    const deps = fakeDeps({
      candidatePorts: [4317, 45317],
      isServerUp: async (port) => {
        checked.push(port);
        return port === 4317;
      },
      startServer: () => {
        startCalled = true;
      },
    });

    const code = await runVibespaceCli(["."], deps);

    expect(code).toBe(0);
    expect(checked).toEqual([4317]); // stops checking once the first candidate answers
    expect(startCalled).toBe(false);
  });

  it("falls through to the SECOND candidate port (the desktop sidecar) when the first isn't up", async () => {
    let ensuredPort: number | undefined;
    const deps = fakeDeps({
      candidatePorts: [4317, 45317],
      isServerUp: async (port) => port === 45317,
      startServer: () => {
        throw new Error("should not start a new server when 45317 is already up");
      },
      ensureWorkspace: async (port) => {
        ensuredPort = port;
        return { id: "ws-1", name: "x", reused: true };
      },
    });

    const code = await runVibespaceCli(["."], deps);

    expect(code).toBe(0);
    expect(ensuredPort).toBe(45317);
  });

  it("starts a server on defaultPort when none of the candidate ports answer, then waits for it", async () => {
    let startedPort: number | undefined;
    let waitedPort: number | undefined;
    const deps = fakeDeps({
      candidatePorts: [4317, 45317],
      defaultPort: 4317,
      isServerUp: async () => false,
      startServer: (port) => {
        startedPort = port;
      },
      waitForServerUp: async (port) => {
        waitedPort = port;
        return true;
      },
    });

    const code = await runVibespaceCli(["."], deps);

    expect(code).toBe(0);
    expect(startedPort).toBe(4317);
    expect(waitedPort).toBe(4317);
  });

  it("reports a clear error and exits 1 when startServer itself throws", async () => {
    const errors: string[] = [];
    const deps = fakeDeps({
      isServerUp: async () => false,
      startServer: () => {
        throw new Error("Cannot find the built server at .../dist/index.js");
      },
      logError: (m) => errors.push(m),
    });

    const code = await runVibespaceCli(["."], deps);

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("could not start the server");
    expect(errors.join("\n")).toContain("dist/index.js");
  });

  it("reports a clear timeout error and exits 1 when the started server never comes up", async () => {
    const errors: string[] = [];
    const deps = fakeDeps({
      isServerUp: async () => false,
      startServer: () => {},
      waitForServerUp: async () => false,
      logError: (m) => errors.push(m),
    });

    const code = await runVibespaceCli(["."], deps);

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("did not come up");
  });

  it("propagates an ensureWorkspace error and exits 1", async () => {
    const errors: string[] = [];
    const deps = fakeDeps({
      ensureWorkspace: async () => ({ error: "Could not reach the server at http://localhost:4317" }),
      logError: (m) => errors.push(m),
    });

    const code = await runVibespaceCli(["."], deps);

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("Could not reach the server");
  });

  it("opens the browser at the workspace-scoped URL and logs 'Reusing' for an existing workspace", async () => {
    let openedUrl: string | undefined;
    const logs: string[] = [];
    const deps = fakeDeps({
      candidatePorts: [4317, 45317],
      ensureWorkspace: async () => ({ id: "abc-123", name: "my-project", reused: true }),
      openUrl: async (url) => {
        openedUrl = url;
      },
      log: (m) => logs.push(m),
    });

    const code = await runVibespaceCli(["."], deps);

    expect(code).toBe(0);
    expect(openedUrl).toBe("http://localhost:4317/?workspace=abc-123");
    expect(logs.some((l) => l.includes("Reusing") && l.includes("my-project"))).toBe(true);
  });

  it("logs 'Created' (not 'Reusing') for a brand-new workspace", async () => {
    const logs: string[] = [];
    const deps = fakeDeps({
      ensureWorkspace: async () => ({ id: "new-1", name: "new-project", reused: false }),
      log: (m) => logs.push(m),
    });

    await runVibespaceCli(["."], deps);

    expect(logs.some((l) => l.includes("Created") && l.includes("new-project"))).toBe(true);
    expect(logs.some((l) => l.includes("Reusing"))).toBe(false);
  });
});

// --- ensureWorkspace (real server, real REST API, temp DB) ------------------

describe("ensureWorkspace", () => {
  let dataDir: string;
  let workspaceDir: string;
  let app: ReturnType<typeof buildApp>;
  let port: number;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "vibespace-cli-test-db-"));
    workspaceDir = mkdtempSync(join(tmpdir(), "vibespace-cli-test-ws-"));
    process.env.VIBESPACE_DATA_DIR = dataDir;

    app = buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await app.close();
    delete process.env.VIBESPACE_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("creates a new workspace when no existing one matches rootPath", async () => {
    const result = await ensureWorkspace(port, workspaceDir);

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.reused).toBe(false);
    expect(result.name).toBe(workspaceDir.split("/").pop());

    const listRes = await fetch(`http://localhost:${port}/api/workspaces`);
    const body = (await listRes.json()) as { workspaces: Array<{ rootPath: string }> };
    expect(body.workspaces.map((w) => w.rootPath)).toContain(workspaceDir);
  });

  it("reuses the SAME workspace on a second call for the same rootPath, rather than duplicating it", async () => {
    const first = await ensureWorkspace(port, workspaceDir);
    const second = await ensureWorkspace(port, workspaceDir);

    expect("error" in first).toBe(false);
    expect("error" in second).toBe(false);
    if ("error" in first || "error" in second) return;

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.id).toBe(first.id);

    const listRes = await fetch(`http://localhost:${port}/api/workspaces`);
    const body = (await listRes.json()) as { workspaces: Array<{ rootPath: string }> };
    expect(body.workspaces.filter((w) => w.rootPath === workspaceDir)).toHaveLength(1);
  });

  it("returns a clear error (not a throw) when nothing is listening on the given port", async () => {
    const deadPort = port + 1; // nothing listens here — app above only bound `port`
    const result = await ensureWorkspace(deadPort, workspaceDir);

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toContain("Could not reach the server");
  });
});
