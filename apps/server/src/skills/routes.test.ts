/**
 * Route tests for the Phase 10 skills endpoints, exercised via
 * `app.inject()` — same pattern as `memory/routes.test.ts` and
 * `board/routes.test.ts`. Two temp-dir concerns, same split
 * `memory/routes.test.ts` uses: `VIBEDECK_DATA_DIR` redirects the
 * workspace/session SQLite db, and a SEPARATE temp dir stands in for the
 * workspace's own project directory, where `.agents/skills/` etc. actually
 * live on disk.
 *
 * The inject tests avoid spawning a real `claude`/`cursor-agent`/`codex`
 * process (none of those binaries exist in CI) two different ways:
 *   - the SHELL-pane path uses a REAL session (`shell` is always available,
 *     same convention `board/routes.test.ts` uses for dispatch), since
 *     shell rejection happens before any pty write — no timing/settle
 *     concerns to work around.
 *   - the AGENT-pane path injects a minimal fake `SessionManager` (only
 *     `get`/`write` are ever called by skills/routes.ts) via `buildApp`'s
 *     `sessionManager` option, so it can assert on an agent id without
 *     needing that agent's binary installed at all.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionInfo } from "@vibedeck/shared";
import type { SessionManager } from "../pty/session-manager.js";
import { SKILL_INJECT_MAX_LENGTH } from "./inject.js";
import { buildApp } from "../index.js";

let dataDir: string;
let fakeHomeDir: string;
let realHome: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "vibedeck-skills-routes-test-"));
  process.env.VIBEDECK_DATA_DIR = dataDir;

  // skills/routes.ts calls discoverSkills(workspace.rootPath) with NO
  // homeDir override — it always scans the real os.homedir(), same as
  // production. That's correct behavior, but it means these tests would
  // otherwise pick up whatever is ACTUALLY installed under the real
  // ~/.claude/skills etc on the machine running them (this repo's own dev
  // environment has real GSD skills there). Node's os.homedir() reads
  // $HOME on POSIX before falling back to a system call, so redirecting it
  // here isolates every USER scope without touching production code at
  // all — the same "env var the test controls" trick VIBEDECK_DATA_DIR
  // uses above.
  fakeHomeDir = mkdtempSync(join(tmpdir(), "vibedeck-skills-fake-home-"));
  realHome = process.env.HOME;
  process.env.HOME = fakeHomeDir;
});

afterEach(() => {
  delete process.env.VIBEDECK_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
  if (realHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = realHome;
  }
  rmSync(fakeHomeDir, { recursive: true, force: true });
});

/** Creates a throwaway workspace (via the real REST route) for tests that
 * need a valid workspaceId — same helper shape every other routes.test.ts
 * in this repo uses. */
async function createWorkspace(app: ReturnType<typeof buildApp>) {
  const projectDir = mkdtempSync(join(tmpdir(), "vibedeck-skills-workspace-"));
  const response = await app.inject({
    method: "POST",
    url: "/api/workspaces",
    payload: { name: "skills-test", rootPath: projectDir },
  });
  return response.json() as { id: string; rootPath: string };
}

/** Writes a valid `<workspaceRoot>/.agents/skills/<name>/SKILL.md`. */
function writeProjectSkill(workspaceRoot: string, name: string, extra: { description?: string; body?: string } = {}) {
  const dir = join(workspaceRoot, ".agents", "skills", name);
  mkdirSync(dir, { recursive: true });
  const lines = ["---", `name: ${name}`, `description: ${extra.description ?? `Skill ${name}`}`, "---", extra.body ?? "Body."];
  writeFileSync(join(dir, "SKILL.md"), lines.join("\n"), "utf8");
}

/** A minimal `SessionManager` double that only implements `get`/`write` —
 * the only two methods `skills/routes.ts`'s inject handler calls. Lets
 * tests assert on an arbitrary `AgentId` (including ones with no installed
 * binary in CI) without spawning a real pty. */
function fakeSessionManager(session: SessionInfo, writes: { sessionId: string; data: string }[]): SessionManager {
  return {
    get: (id: string) => (id === session.id ? session : undefined),
    write: (id: string, data: string) => {
      writes.push({ sessionId: id, data });
    },
    // index.ts's onClose hook always calls this on app.close() — a no-op
    // here since this fake never spawned a real pty to dispose of.
    disposeAll: () => {},
  } as unknown as SessionManager;
}

describe("GET /api/skills", () => {
  it("400s when workspaceId is missing", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/skills" });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("404s for an unknown workspace", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/skills?workspaceId=nope" });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("returns an empty catalog and no diagnostics for a fresh workspace", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const response = await app.inject({ method: "GET", url: `/api/skills?workspaceId=${workspace.id}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ skills: [], diagnostics: [] });
    await app.close();
  });

  it("returns catalog entries WITHOUT the full body, per progressive disclosure", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    writeProjectSkill(workspace.rootPath, "catalog-skill", { description: "Catalog description", body: "Secret body content." });

    const response = await app.inject({ method: "GET", url: `/api/skills?workspaceId=${workspace.id}` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { skills: Array<Record<string, unknown>> };
    expect(body.skills).toHaveLength(1);
    expect(body.skills[0].name).toBe("catalog-skill");
    expect(body.skills[0].description).toBe("Catalog description");
    expect(body.skills[0]).not.toHaveProperty("body");
    expect(JSON.stringify(body.skills[0])).not.toContain("Secret body content");
    // scope is surfaced so a client can tell project skills from user ones.
    expect(body.skills[0]).toHaveProperty("scope");
    expect((body.skills[0].scope as { kind: string }).kind).toBe("project");
    await app.close();
  });

  it("surfaces parse diagnostics (e.g. a name/directory mismatch) alongside the catalog", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const dir = join(workspace.rootPath, ".agents", "skills", "mismatched-dir");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      ["---", "name: actual-name", "description: A skill", "---", "Body."].join("\n"),
      "utf8"
    );

    const response = await app.inject({ method: "GET", url: `/api/skills?workspaceId=${workspace.id}` });
    const body = response.json() as { diagnostics: Array<{ level: string; message: string }> };
    expect(body.diagnostics.some((d) => d.level === "warning" && /does not match/.test(d.message))).toBe(true);
    await app.close();
  });
});

describe("GET /api/skills/:name", () => {
  it("400s when workspaceId is missing", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/skills/anything" });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("404s for an unknown workspace", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/skills/anything?workspaceId=nope" });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("404s for an unknown skill name", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const response = await app.inject({ method: "GET", url: `/api/skills/does-not-exist?workspaceId=${workspace.id}` });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("returns the full skill including its body", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    writeProjectSkill(workspace.rootPath, "full-skill", { body: "The complete body text." });

    const response = await app.inject({ method: "GET", url: `/api/skills/full-skill?workspaceId=${workspace.id}` });
    expect(response.statusCode).toBe(200);
    const skill = response.json();
    expect(skill.name).toBe("full-skill");
    expect(skill.body).toBe("The complete body text.");
    expect(skill.scope.kind).toBe("project");
    await app.close();
  });
});

describe("POST /api/skills/:name/inject", () => {
  it("400s when workspaceId is missing", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "POST", url: "/api/skills/anything/inject", payload: {} });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("404s for an unknown workspace", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/skills/anything/inject",
      payload: { workspaceId: "nope", sessionId: "x" },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("400s when sessionId is missing", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    writeProjectSkill(workspace.rootPath, "needs-session");
    const response = await app.inject({
      method: "POST",
      url: "/api/skills/needs-session/inject",
      payload: { workspaceId: workspace.id },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("404s for an unknown skill name", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/skills/does-not-exist/inject",
      payload: { workspaceId: workspace.id, sessionId: "whatever" },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("404s for an unknown session id", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    writeProjectSkill(workspace.rootPath, "skill-a");
    const response = await app.inject({
      method: "POST",
      url: "/api/skills/skill-a/inject",
      payload: { workspaceId: workspace.id, sessionId: "no-such-session" },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("refuses injection into a real shell pane with a 400 and does not write anything into it", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    writeProjectSkill(workspace.rootPath, "skill-for-shell", { body: "SKILL_INJECT_MARKER should never appear" });

    const session = app.sessionManager.create({ agent: "shell", cwd: workspace.rootPath });
    const response = await app.inject({
      method: "POST",
      url: "/api/skills/skill-for-shell/inject",
      payload: { workspaceId: workspace.id, sessionId: session.id },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/shell/i);
    // The whole point: nothing was ever written into the shell's pty.
    expect(app.sessionManager.getHistory(session.id)).not.toContain("SKILL_INJECT_MARKER");

    app.sessionManager.kill(session.id);
    await app.close();
  });

  it("injects into an agent pane (fake session, no real binary needed) and returns 200", async () => {
    const writes: { sessionId: string; data: string }[] = [];
    const fakeSession: SessionInfo = {
      id: "fake-session-1",
      agent: "claude",
      cwd: "/tmp",
      title: "claude",
      status: "running",
      exitCode: null,
      createdAt: new Date().toISOString(),
    };
    const app = buildApp({ sessionManager: fakeSessionManager(fakeSession, writes) });
    const workspace = await createWorkspace(app);
    writeProjectSkill(workspace.rootPath, "skill-for-agent", { body: "Do the injected thing." });

    const response = await app.inject({
      method: "POST",
      url: "/api/skills/skill-for-agent/inject",
      payload: { workspaceId: workspace.id, sessionId: fakeSession.id },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ injected: true, truncated: false });
    expect(writes).toHaveLength(1);
    expect(writes[0].sessionId).toBe(fakeSession.id);
    expect(writes[0].data).toContain("Do the injected thing.");
    // Exactly one trailing newline, no internal ones.
    expect(writes[0].data.match(/\n/g)?.length).toBe(1);
    expect(writes[0].data.endsWith("\n")).toBe(true);
    await app.close();
  });

  it("surfaces truncated: true for an oversized body injected into an agent pane", async () => {
    const writes: { sessionId: string; data: string }[] = [];
    const fakeSession: SessionInfo = {
      id: "fake-session-2",
      agent: "codex",
      cwd: "/tmp",
      title: "codex",
      status: "running",
      exitCode: null,
      createdAt: new Date().toISOString(),
    };
    const app = buildApp({ sessionManager: fakeSessionManager(fakeSession, writes) });
    const workspace = await createWorkspace(app);
    writeProjectSkill(workspace.rootPath, "skill-huge", { body: "z".repeat(SKILL_INJECT_MAX_LENGTH * 2) });

    const response = await app.inject({
      method: "POST",
      url: "/api/skills/skill-huge/inject",
      payload: { workspaceId: workspace.id, sessionId: fakeSession.id },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ injected: true, truncated: true });
    await app.close();
  });
});
