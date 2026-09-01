import { describe, expect, it } from "vitest";
import { AGENT_IDS } from "@vibespace/shared";
import { detectAgent, detectAllAgents, INSTALL_HINTS, resolveAgent } from "./agents.js";

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

  // BridgeSpace-parity agents (Phase: 10-agent picker). Each resolves to a
  // static command the same way the original three do — see agents.ts's
  // INSTALL_HINTS comment for how confident we are in each binary name.
  it("resolves the newly-added agents to their static command/args", () => {
    expect(resolveAgent("droid")).toEqual({ command: "droid", args: [] });
    expect(resolveAgent("deepseek")).toEqual({ command: "deepcode", args: [] });
    expect(resolveAgent("antigravity")).toEqual({ command: "antigravity", args: [] });
    expect(resolveAgent("gemini")).toEqual({ command: "gemini", args: [] });
    expect(resolveAgent("opencode")).toEqual({ command: "opencode", args: [] });
    expect(resolveAgent("grok")).toEqual({ command: "grok-build", args: [] });
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

describe("INSTALL_HINTS", () => {
  it("has exactly one entry per known agent id", () => {
    expect(Object.keys(INSTALL_HINTS).sort()).toEqual([...AGENT_IDS].sort());
  });

  it("shell never carries an install hint (it's always available)", () => {
    expect(INSTALL_HINTS.shell).toBeNull();
  });

  it("every non-null install hint is a non-empty string", () => {
    for (const id of AGENT_IDS) {
      const hint = INSTALL_HINTS[id];
      if (hint !== null) {
        expect(hint.length).toBeGreaterThan(0);
      }
    }
  });
});
