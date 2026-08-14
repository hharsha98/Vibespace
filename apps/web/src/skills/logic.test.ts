import { describe, expect, it } from "vitest";
import type { AgentId, SessionInfo } from "@vibedeck/shared";
import {
  filterSkills,
  groupSkillsByScope,
  paneInjectionTargets,
  type PaneRef,
  type SkillCatalogEntry,
} from "./logic.js";

function skill(overrides: Partial<SkillCatalogEntry> & Pick<SkillCatalogEntry, "name">): SkillCatalogEntry {
  return {
    description: "A skill.",
    license: null,
    compatibility: null,
    scope: { kind: "user", dirLabel: ".claude/skills", rootDir: "/home/x/.claude/skills" },
    dir: `/home/x/.claude/skills/${overrides.name}`,
    ...overrides,
  };
}

function session(id: string, agent: AgentId, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    agent,
    cwd: "/repo",
    title: agent,
    status: "running",
    exitCode: null,
    createdAt: "2026-08-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("filterSkills", () => {
  const skills = [
    skill({ name: "pdf-tools", description: "Fill and merge PDF forms." }),
    skill({ name: "commit-style", description: "Write commits matching this repo's style." }),
    skill({ name: "release-notes", description: "Draft a changelog from recent commits." }),
  ];

  it("returns every skill for an empty or whitespace-only query", () => {
    expect(filterSkills(skills, "")).toHaveLength(3);
    expect(filterSkills(skills, "   ")).toHaveLength(3);
  });

  it("matches a substring of the name, case-insensitively", () => {
    expect(filterSkills(skills, "PDF").map((s) => s.name)).toEqual(["pdf-tools"]);
  });

  it("matches a substring of the description even when the name doesn't match", () => {
    expect(filterSkills(skills, "changelog").map((s) => s.name)).toEqual(["release-notes"]);
  });

  it("matches across both name and description without duplicating a skill that matches both", () => {
    expect(filterSkills(skills, "commit").map((s) => s.name)).toEqual(["commit-style", "release-notes"]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(filterSkills(skills, "nonexistent-xyz")).toEqual([]);
  });
});

describe("groupSkillsByScope", () => {
  it("splits into project and user buckets, alphabetised by name within each", () => {
    const skills = [
      skill({ name: "zebra-skill", scope: { kind: "user", dirLabel: ".claude/skills", rootDir: "/h" } }),
      skill({ name: "audit-parity", scope: { kind: "project", dirLabel: ".agents/skills", rootDir: "/repo/.agents/skills" } }),
      skill({ name: "apple-skill", scope: { kind: "user", dirLabel: ".claude/skills", rootDir: "/h" } }),
      skill({ name: "build-migration", scope: { kind: "project", dirLabel: ".agents/skills", rootDir: "/repo/.agents/skills" } }),
    ];
    const { project, user } = groupSkillsByScope(skills);
    expect(project.map((s) => s.name)).toEqual(["audit-parity", "build-migration"]);
    expect(user.map((s) => s.name)).toEqual(["apple-skill", "zebra-skill"]);
  });

  it("returns two empty arrays for an empty catalog", () => {
    expect(groupSkillsByScope([])).toEqual({ project: [], user: [] });
  });
});

describe("paneInjectionTargets", () => {
  it("marks a shell pane ineligible and an agent pane eligible", () => {
    const panes: PaneRef[] = [
      { paneId: "pane-1", index: 0, session: session("s1", "shell") },
      { paneId: "pane-2", index: 1, session: session("s2", "claude") },
    ];
    const targets = paneInjectionTargets(panes);
    expect(targets).toEqual([
      { paneId: "pane-1", sessionId: "s1", agent: "shell", label: "Pane 1 — shell", eligible: false },
      { paneId: "pane-2", sessionId: "s2", agent: "claude", label: "Pane 2 — claude", eligible: true },
    ]);
  });

  it("labels every non-shell agent as eligible", () => {
    const panes: PaneRef[] = [
      { paneId: "pane-1", index: 0, session: session("s1", "cursor-agent") },
      { paneId: "pane-2", index: 1, session: session("s2", "codex") },
    ];
    expect(paneInjectionTargets(panes).every((t) => t.eligible)).toBe(true);
  });

  it("returns an empty list for no panes", () => {
    expect(paneInjectionTargets([])).toEqual([]);
  });
});
