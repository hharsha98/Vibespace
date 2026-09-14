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
  // INSTALL_HINTS comment for the source behind each binary name.
  //
  // These names are asserted literally, rather than just shape-checked, for
  // a specific reason: detection looks for `command` on PATH, so a name
  // that is merely plausible instead of correct makes that agent
  // permanently undetectable — `available: false` even for a user who has
  // the CLI installed and open in another window. That is exactly what had
  // happened to `grok` (asserted `grok-build`, really `grok`) and
  // `antigravity` (asserted `antigravity`, really `agy`) until each was
  // checked against its vendor's own documentation.
  it("resolves the newly-added agents to their static command/args", () => {
    expect(resolveAgent("droid")).toEqual({ command: "droid", args: [] });
    expect(resolveAgent("deepseek")).toEqual({ command: "deepcode", args: [] });
    expect(resolveAgent("antigravity")).toEqual({ command: "agy", args: [] });
    expect(resolveAgent("gemini")).toEqual({ command: "gemini", args: [] });
    expect(resolveAgent("opencode")).toEqual({ command: "opencode", args: [] });
    expect(resolveAgent("grok")).toEqual({ command: "grok", args: [] });
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

  // Regression guard for a real release-QA finding: `antigravity` shipped
  // with a null hint while every other installable agent had one, so a user
  // without it saw a bare "Not installed" and no way forward. `claude` and
  // `cursor-agent` had the same hole and it went unnoticed for longer,
  // because the development machine had both installed — they always
  // rendered as available, so their missing hints never surfaced.
  //
  // Pinning the exact set (rather than asserting "antigravity is non-null")
  // is deliberate: it makes adding an eleventh agent with no install hint a
  // test failure that has to be argued with, instead of a silent dead end
  // that only a new user on a clean machine would ever discover.
  it("shell is the only agent without an install hint", () => {
    const withoutHint = AGENT_IDS.filter((id) => INSTALL_HINTS[id] === null);
    expect(withoutHint).toEqual(["shell"]);
  });
});
