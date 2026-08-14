/**
 * Discovery tests. Every scope root used here is a throwaway temp
 * directory — `homeDir` is always overridden to a `mkdtempSync` path, NEVER
 * the real `os.homedir()`, per this module's own dependency-injection
 * comment and the "never touch the user's real home directory" rule.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverSkills } from "./discover.js";

let homeDir: string;
let workspaceRoot: string;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "vibedeck-skills-home-"));
  workspaceRoot = mkdtempSync(join(tmpdir(), "vibedeck-skills-workspace-"));
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
});

/** Writes a valid, minimal `<scopeRoot>/<name>/SKILL.md`, creating
 * `scopeRoot` if needed. `description` defaults to something identifying
 * so tests can tell which scope's copy of a colliding name won. Returns
 * the skill's own directory. */
function writeSkill(scopeRoot: string, name: string, description = `Skill ${name}`): string {
  const dir = join(scopeRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    ["---", `name: ${name}`, `description: ${description}`, "---", "Body."].join("\n"),
    "utf8"
  );
  return dir;
}

describe("discoverSkills", () => {
  it("returns no skills and no diagnostics when every scope directory is missing", () => {
    const result = discoverSkills(workspaceRoot, homeDir);
    expect(result.skills).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it("finds a skill in a single user scope", () => {
    writeSkill(join(homeDir, ".claude", "skills"), "my-skill");
    const result = discoverSkills(null, homeDir);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].skill.name).toBe("my-skill");
    expect(result.skills[0].scope).toEqual({
      kind: "user",
      dirLabel: ".claude/skills",
      rootDir: join(homeDir, ".claude", "skills"),
    });
  });

  it("finds a skill in a single project scope", () => {
    writeSkill(join(workspaceRoot, ".agents", "skills"), "project-skill");
    const result = discoverSkills(workspaceRoot, homeDir);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].scope.kind).toBe("project");
  });

  it("ignores a directory with no SKILL.md file, without an error", () => {
    const scopeRoot = join(homeDir, ".claude", "skills");
    mkdirSync(join(scopeRoot, "not-a-skill"), { recursive: true });
    writeFileSync(join(scopeRoot, "not-a-skill", "README.md"), "just a readme", "utf8");

    const result = discoverSkills(null, homeDir);
    expect(result.skills).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it("ignores .git and node_modules even if they somehow sit directly under a scope root", () => {
    const scopeRoot = join(homeDir, ".claude", "skills");
    mkdirSync(join(scopeRoot, ".git"), { recursive: true });
    writeFileSync(join(scopeRoot, ".git", "SKILL.md"), ["---", "name: x", "description: x", "---", "x"].join("\n"), "utf8");
    mkdirSync(join(scopeRoot, "node_modules"), { recursive: true });
    writeFileSync(
      join(scopeRoot, "node_modules", "SKILL.md"),
      ["---", "name: y", "description: y", "---", "y"].join("\n"),
      "utf8"
    );

    const result = discoverSkills(null, homeDir);
    expect(result.skills).toEqual([]);
  });

  it("a skill's own parse diagnostics are tagged with the SKILL.md path they came from", () => {
    const scopeRoot = join(homeDir, ".claude", "skills");
    const dir = join(scopeRoot, "mismatched-dir");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      ["---", "name: totally-different-name", "description: A skill", "---", "Body."].join("\n"),
      "utf8"
    );

    const result = discoverSkills(null, homeDir);
    expect(result.skills).toHaveLength(1);
    expect(
      result.diagnostics.some((d) => d.message.includes(join(dir, "SKILL.md")) && /does not match/.test(d.message))
    ).toBe(true);
  });

  describe("scope precedence", () => {
    it("a project skill overrides a user skill with the same name, and records a collision diagnostic", () => {
      const userDir = writeSkill(join(homeDir, ".agents", "skills"), "shared-name", "The user's version");
      const projectDir = writeSkill(join(workspaceRoot, ".claude", "skills"), "shared-name", "The project's version");

      const result = discoverSkills(workspaceRoot, homeDir);
      expect(result.skills).toHaveLength(1);
      expect(result.skills[0].skill.description).toBe("The project's version");
      expect(result.skills[0].scope.kind).toBe("project");

      const collision = result.diagnostics.find((d) => d.message.includes("shadows"));
      expect(collision).toBeDefined();
      expect(collision?.level).toBe("warning");
      expect(collision?.message).toContain(projectDir);
      expect(collision?.message).toContain(userDir);
    });

    it("later user scopes win over earlier user scopes (.claude/skills over .agents/skills)", () => {
      writeSkill(join(homeDir, ".agents", "skills"), "shared-name", "From .agents");
      writeSkill(join(homeDir, ".claude", "skills"), "shared-name", "From .claude");

      const result = discoverSkills(null, homeDir);
      expect(result.skills).toHaveLength(1);
      expect(result.skills[0].skill.description).toBe("From .claude");
    });

    it("later project scopes win over earlier project scopes (.claude/skills over .agents/skills)", () => {
      writeSkill(join(workspaceRoot, ".agents", "skills"), "shared-name", "From .agents");
      writeSkill(join(workspaceRoot, ".claude", "skills"), "shared-name", "From .claude");

      const result = discoverSkills(workspaceRoot, homeDir);
      expect(result.skills).toHaveLength(1);
      expect(result.skills[0].skill.description).toBe("From .claude");
    });

    it("no collision diagnostic when every skill name is unique", () => {
      writeSkill(join(homeDir, ".agents", "skills"), "skill-one");
      writeSkill(join(workspaceRoot, ".claude", "skills"), "skill-two");

      const result = discoverSkills(workspaceRoot, homeDir);
      expect(result.skills).toHaveLength(2);
      expect(result.diagnostics.some((d) => d.message.includes("shadows"))).toBe(false);
    });
  });

  describe("the entry-scan cap", () => {
    it("stops scanning and records a diagnostic once the cap is hit", () => {
      const scopeRoot = join(homeDir, ".claude", "skills");
      mkdirSync(scopeRoot, { recursive: true });
      // Plain empty files, not skill directories — the cap counts every
      // entry examined, not just valid skills, and a bare file is cheaper
      // to create in bulk than a real directory + SKILL.md pair.
      for (let i = 0; i < 10; i++) {
        writeFileSync(join(scopeRoot, `decoy-${i}`), "", "utf8");
      }
      writeSkill(scopeRoot, "real-skill");

      // Cap of 5 (well under the 11 entries above) forces the cap to be hit
      // deterministically without needing thousands of real files on disk.
      const result = discoverSkills(null, homeDir, 5);
      expect(result.diagnostics.some((d) => /5-entry skill-scan cap/.test(d.message))).toBe(true);
    });

    it("does not record a cap diagnostic when every entry fits under the cap", () => {
      writeSkill(join(homeDir, ".claude", "skills"), "real-skill");
      const result = discoverSkills(null, homeDir, 2000);
      expect(result.diagnostics.some((d) => /skill-scan cap/.test(d.message))).toBe(false);
    });
  });

  it("follows a symlinked skill directory that resolves to somewhere still inside the scope root", () => {
    const scopeRoot = join(homeDir, ".claude", "skills");
    // The real target lives INSIDE the same scope root, just under a
    // different name — e.g. an alias for another skill directory. This is
    // the one symlink shape safeResolve's containment check allows.
    const realDir = writeSkill(scopeRoot, "_actual-target", "The real skill");
    symlinkSync(realDir, join(scopeRoot, "symlinked-skill"), "dir");

    const result = discoverSkills(null, homeDir);
    // The symlink resolves to "_actual-target"'s SKILL.md, whose own `name`
    // field is "_actual-target" (writeSkill always writes `name: <name>`)
    // — so the discovered skill is that one, reachable via either the real
    // directory or the symlink pointing at it.
    expect(result.skills.map((s) => s.skill.name)).toContain("_actual-target");
  });

  it("refuses to follow a symlink that escapes its scope root, per the trust-boundary check", () => {
    const scopeRoot = join(homeDir, ".claude", "skills");
    mkdirSync(scopeRoot, { recursive: true });
    // The real target lives in a COMPLETELY SEPARATE temp directory — the
    // same shape a malicious project skill's `leak -> /etc` symlink would
    // take (see discover.ts's top-comment trust boundary). This must be
    // silently skipped, not followed and not an error.
    const outsideDir = mkdtempSync(join(tmpdir(), "vibedeck-skills-outside-"));
    writeFileSync(
      join(outsideDir, "SKILL.md"),
      ["---", "name: escaped-skill", "description: Should never be reachable", "---", "Body."].join("\n"),
      "utf8"
    );
    symlinkSync(outsideDir, join(scopeRoot, "escape-attempt"), "dir");

    const result = discoverSkills(null, homeDir);
    expect(result.skills).toEqual([]);

    rmSync(outsideDir, { recursive: true, force: true });
  });
});
