import { describe, expect, it } from "vitest";
import { AGENT_IDS } from "@vibedeck/shared";
import { detectAgent, detectAllAgents, resolveAgent } from "./agents.js";

describe("resolveAgent", () => {
  it("resolves shell from $SHELL, falling back to /bin/zsh", () => {
    const original = process.env.SHELL;
    try {
      process.env.SHELL = "/bin/bash";
      expect(resolveAgent("shell")).toEqual({ command: "/bin/bash", args: ["-l"] });

      delete process.env.SHELL;
      expect(resolveAgent("shell")).toEqual({ command: "/bin/zsh", args: ["-l"] });
    } finally {
      if (original === undefined) {
        delete process.env.SHELL;
      } else {
        process.env.SHELL = original;
      }
    }
  });

  it("resolves the AI agents to their static command/args", () => {
    expect(resolveAgent("claude")).toEqual({ command: "claude", args: [] });
    expect(resolveAgent("cursor-agent")).toEqual({ command: "cursor-agent", args: [] });
    expect(resolveAgent("codex")).toEqual({ command: "codex", args: [] });
  });
});

describe("detectAgent", () => {
  // CI (ubuntu-latest) does not have claude/cursor-agent/codex installed,
  // so this suite only makes assertions about "shell" (always present —
  // every machine that can run this test has *some* shell) and about
  // never throwing, which must hold regardless of what's installed.
  it("shell is always detected as available", async () => {
    await expect(detectAgent("shell")).resolves.toBe(true);
  });

  it("never throws for an agent whose binary is missing", async () => {
    const original = process.env.PATH;
    try {
      // Blank out PATH so even a normally-installed binary can't be found,
      // proving the "not found" path is exercised without throwing.
      process.env.PATH = "";
      await expect(detectAgent("codex")).resolves.toBe(false);
    } finally {
      process.env.PATH = original;
    }
  });
});

describe("detectAllAgents", () => {
  it("returns a boolean for every known agent id", async () => {
    const result = await detectAllAgents();
    expect(Object.keys(result).sort()).toEqual([...AGENT_IDS].sort());
    for (const id of AGENT_IDS) {
      expect(typeof result[id]).toBe("boolean");
    }
    // shell must always be true, as above.
    expect(result.shell).toBe(true);
  });
});
