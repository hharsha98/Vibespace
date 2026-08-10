import { describe, expect, it } from "vitest";
import { AGENT_IDS, type AgentId, type ServerMessage } from "./protocol.js";

describe("AGENT_IDS", () => {
  it("contains exactly the four expected agent ids, in a stable order", () => {
    expect(AGENT_IDS).toEqual(["claude", "cursor-agent", "codex", "shell"]);
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
    const ready: ServerMessage = { type: "ready", sessionId: "abc" };
    expect(isOutputMessage(exit)).toBe(false);
    expect(isOutputMessage(ready)).toBe(false);
  });

  it("filters a mixed message stream down to only output messages", () => {
    const stream: ServerMessage[] = [
      { type: "ready", sessionId: "s1" },
      { type: "output", sessionId: "s1", data: "line 1\n" },
      { type: "output", sessionId: "s1", data: "line 2\n" },
      { type: "exit", sessionId: "s1", code: 0 },
    ];
    const outputs = stream.filter(isOutputMessage);
    expect(outputs).toHaveLength(2);
    expect(outputs.map((m) => m.data)).toEqual(["line 1\n", "line 2\n"]);
  });
});
