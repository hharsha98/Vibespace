import { describe, expect, it } from "vitest";
import { planResume, spawnExtrasFor } from "./resume.js";

describe("spawnExtrasFor", () => {
  it("claude gets a fresh --session-id uuid, captured as agentSessionRef", () => {
    const extras = spawnExtrasFor("claude");
    expect(extras.args).toEqual(["--session-id", extras.agentSessionRef]);
    expect(extras.agentSessionRef).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("two calls for claude produce two DIFFERENT uuids", () => {
    const a = spawnExtrasFor("claude");
    const b = spawnExtrasFor("claude");
    expect(a.agentSessionRef).not.toBe(b.agentSessionRef);
  });

  it("every other agent gets no extra args and no ref", () => {
    for (const agent of ["shell", "codex", "cursor-agent", "droid", "gemini"] as const) {
      const extras = spawnExtrasFor(agent);
      expect(extras.args).toEqual([]);
      expect(extras.agentSessionRef).toBeNull();
    }
  });
});

describe("planResume", () => {
  it("claude with a saved agentSessionRef resumes with --resume <ref>", () => {
    const plan = planResume({ agent: "claude", agentSessionRef: "abc-123" });
    expect(plan.args).toEqual(["--resume", "abc-123"]);
    expect(plan.note).toContain("--resume");
  });

  it("claude with NO saved ref falls back to --continue", () => {
    const plan = planResume({ agent: "claude", agentSessionRef: null });
    expect(plan.args).toEqual(["--continue"]);
    expect(plan.note).toContain("--continue");
  });

  it("codex resumes via the `resume --last` subcommand", () => {
    const plan = planResume({ agent: "codex", agentSessionRef: null });
    expect(plan.args).toEqual(["resume", "--last"]);
  });

  it("cursor-agent resumes via --continue", () => {
    const plan = planResume({ agent: "cursor-agent", agentSessionRef: null });
    expect(plan.args).toEqual(["--continue"]);
  });

  it("shell has no flags — a plain fresh shell", () => {
    const plan = planResume({ agent: "shell", agentSessionRef: null });
    expect(plan.args).toEqual([]);
    expect(plan.note).toContain("fresh shell");
  });

  it("an agent with no known resume flag falls back to a fresh session and says so honestly", () => {
    for (const agent of ["droid", "deepseek", "antigravity", "gemini", "opencode", "grok"] as const) {
      const plan = planResume({ agent, agentSessionRef: null });
      expect(plan.args).toEqual([]);
      expect(plan.note).toContain("no known resume flag");
      expect(plan.note).toContain(agent);
    }
  });
});
