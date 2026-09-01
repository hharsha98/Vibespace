import { describe, expect, it } from "vitest";
import {
  AGENT_IDS,
  AGENT_SPECS,
  type AgentId,
  type AgentSpec,
  type ServerMessage,
  type SessionInfo,
  type Workspace,
} from "./protocol.js";

describe("AGENT_IDS", () => {
  it("contains exactly the ten expected agent ids, in a stable order", () => {
    expect(AGENT_IDS).toEqual([
      "claude",
      "codex",
      "cursor-agent",
      "gemini",
      "droid",
      "opencode",
      "deepseek",
      "grok",
      "antigravity",
      "shell",
    ]);
  });

  it("has no duplicates", () => {
    expect(new Set(AGENT_IDS).size).toBe(AGENT_IDS.length);
  });

  it("every entry is assignable to the AgentId type (compile-time + runtime check)", () => {
    const check = (id: AgentId): AgentId => id;
    for (const id of AGENT_IDS) {
      expect(check(id)).toBe(id);
    }
  });
});

/**
 * A type-narrowing helper an app would realistically use when handling
 * incoming server messages: pick out only the "output" messages from a
 * stream of ServerMessage. Exercising it here proves the discriminated
 * union is actually discriminating on `type`, not just structurally
 * shaped right.
 */
function isOutputMessage(
  message: ServerMessage
): message is Extract<ServerMessage, { type: "output" }> {
  return message.type === "output";
}

describe("isOutputMessage (discriminated union narrowing)", () => {
  it("returns true for output messages and narrows the type", () => {
    const message: ServerMessage = { type: "output", sessionId: "abc", data: "hello" };
    expect(isOutputMessage(message)).toBe(true);
    if (isOutputMessage(message)) {
      // If narrowing failed to work, this line would not type-check.
      expect(message.data).toBe("hello");
    }
  });

  it("returns false for exit and ready messages", () => {
    const exit: ServerMessage = { type: "exit", sessionId: "abc", code: 0 };
    const ready: ServerMessage = {
      type: "ready",
      sessionId: "abc",
      history: "",
      cols: 80,
      rows: 24,
    };
    expect(isOutputMessage(exit)).toBe(false);
    expect(isOutputMessage(ready)).toBe(false);
  });

  it("filters a mixed message stream down to only output messages", () => {
    const stream: ServerMessage[] = [
      { type: "ready", sessionId: "s1", history: "welcome\n", cols: 80, rows: 24 },
      { type: "output", sessionId: "s1", data: "line 1\n" },
      { type: "output", sessionId: "s1", data: "line 2\n" },
      { type: "exit", sessionId: "s1", code: 0 },
    ];
    const outputs = stream.filter(isOutputMessage);
    expect(outputs).toHaveLength(2);
    expect(outputs.map((m) => m.data)).toEqual(["line 1\n", "line 2\n"]);
  });

  it("a ready message carries replayed scrollback and the pty's current size", () => {
    // This is what makes reattaching after a tab refresh work: the client
    // gets the full history text plus the size to size its terminal to,
    // all in the one message that kicks off a session view.
    const ready: ServerMessage = {
      type: "ready",
      sessionId: "s1",
      history: "$ echo hi\nhi\n",
      cols: 120,
      rows: 40,
    };
    expect(ready.history).toContain("hi");
    expect(ready.cols).toBe(120);
    expect(ready.rows).toBe(40);
  });
});

describe("SessionInfo", () => {
  it("describes a running session with a null exit code", () => {
    const session: SessionInfo = {
      id: "11111111-1111-1111-1111-111111111111",
      agent: "shell",
      cwd: "/Users/harsha/projects/vibespace",
      title: "shell",
      status: "running",
      exitCode: null,
      createdAt: "2026-08-10T12:00:00.000Z",
    };
    expect(session.status).toBe("running");
    expect(session.exitCode).toBeNull();
  });

  it("describes an exited session with a numeric exit code", () => {
    const session: SessionInfo = {
      id: "22222222-2222-2222-2222-222222222222",
      agent: "claude",
      cwd: "/tmp",
      title: "claude",
      status: "exited",
      exitCode: 1,
      createdAt: "2026-08-10T12:00:00.000Z",
    };
    expect(session.status).toBe("exited");
    expect(session.exitCode).toBe(1);
  });
});

describe("AGENT_SPECS", () => {
  it("has exactly one entry per AgentId, with matching keys and ids", () => {
    // If a new AgentId is ever added without a matching AGENT_SPECS entry,
    // this test catches it — TypeScript's Record<AgentId, AgentSpec> would
    // already refuse to compile, but this also guards the runtime shape.
    expect(Object.keys(AGENT_SPECS).sort()).toEqual([...AGENT_IDS].sort());
    for (const id of AGENT_IDS) {
      const spec: AgentSpec = AGENT_SPECS[id];
      expect(spec.id).toBe(id);
    }
  });

  it("gives every agent a non-empty, human-readable display name", () => {
    for (const id of AGENT_IDS) {
      expect(AGENT_SPECS[id].displayName.length).toBeGreaterThan(0);
    }
  });

  it("gives every agent a non-empty command", () => {
    for (const id of AGENT_IDS) {
      expect(AGENT_SPECS[id].command.length).toBeGreaterThan(0);
    }
  });

  it("the AI CLI agents take no extra args, matching how they're normally invoked", () => {
    expect(AGENT_SPECS.claude.args).toEqual([]);
    expect(AGENT_SPECS["cursor-agent"].args).toEqual([]);
    expect(AGENT_SPECS.codex.args).toEqual([]);
    expect(AGENT_SPECS.droid.args).toEqual([]);
    expect(AGENT_SPECS.deepseek.args).toEqual([]);
    expect(AGENT_SPECS.antigravity.args).toEqual([]);
    expect(AGENT_SPECS.gemini.args).toEqual([]);
    expect(AGENT_SPECS.opencode.args).toEqual([]);
    expect(AGENT_SPECS.grok.args).toEqual([]);
  });

  it("shell is spawned as a login shell (-l), so it picks up the user's PATH and profile", () => {
    expect(AGENT_SPECS.shell.args).toEqual(["-l"]);
  });

  // BridgeSpace V3 parity: the plain shell agent is labelled "Terminal" in
  // the picker, not "Shell" — see protocol.ts's AGENT_SPECS comment.
  it("labels the shell agent 'Terminal', matching BridgeSpace's picker", () => {
    expect(AGENT_SPECS.shell.displayName).toBe("Terminal");
  });
});

describe("Workspace", () => {
  it("describes a freshly-created workspace with no layout saved yet", () => {
    const workspace: Workspace = {
      id: "33333333-3333-3333-3333-333333333333",
      name: "vibespace",
      rootPath: "/Users/harsha/projects/vibespace",
      layout: null,
      color: null,
      createdAt: "2026-08-10T12:00:00.000Z",
      updatedAt: "2026-08-10T12:00:00.000Z",
    };
    expect(workspace.layout).toBeNull();
    expect(workspace.createdAt).toBe(workspace.updatedAt);
  });

  it("round-trips a serialised GridNode tree through the layout field", () => {
    // `layout` is deliberately just `string | null` (not a nested GridNode
    // type) so this package never has to import web-only tree shapes —
    // callers JSON.stringify/parse it themselves. Exercise that contract.
    const tree = {
      kind: "split",
      id: "split-1",
      direction: "row",
      children: [
        { kind: "leaf", id: "leaf-1", sessionId: null },
        { kind: "leaf", id: "leaf-2", sessionId: "session-abc" },
      ],
    };
    const workspace: Workspace = {
      id: "44444444-4444-4444-4444-444444444444",
      name: "api-project",
      rootPath: "/tmp/api-project",
      layout: JSON.stringify(tree),
      color: null,
      createdAt: "2026-08-10T12:00:00.000Z",
      updatedAt: "2026-08-10T12:05:00.000Z",
    };

    const parsed: unknown = JSON.parse(workspace.layout as string);
    expect(parsed).toEqual(tree);
  });

  it("updatedAt can move forward independently of createdAt after an edit", () => {
    const workspace: Workspace = {
      id: "55555555-5555-5555-5555-555555555555",
      name: "renamed-project",
      rootPath: "/tmp/renamed-project",
      layout: null,
      color: null,
      createdAt: "2026-08-10T09:00:00.000Z",
      updatedAt: "2026-08-10T10:30:00.000Z",
    };
    expect(new Date(workspace.updatedAt).getTime()).toBeGreaterThan(
      new Date(workspace.createdAt).getTime()
    );
  });
});
