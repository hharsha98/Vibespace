/**
 * Tests the skills MCP tool handlers directly (see mcp.ts's top comment for
 * why they're extracted as plain exported functions) against a real
 * temp-dir workspace root — same pattern as `memory/mcp.test.ts`. No stdio
 * transport, no MCP client, no protocol framing.
 *
 * `HOME` is redirected to a throwaway temp dir for the same reason
 * `skills/routes.test.ts` does it: `handleListSkills`/`handleGetSkill` call
 * `discoverSkills(root)` with no `homeDir` override (correctly — that's
 * real production behavior), which would otherwise pick up whatever is
 * ACTUALLY installed under this machine's real `~/.claude/skills` etc.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleGetSkill, handleListSkills } from "./mcp.js";

let root: string;
let fakeHomeDir: string;
let realHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vibespace-skills-mcp-test-"));
  fakeHomeDir = mkdtempSync(join(tmpdir(), "vibespace-skills-mcp-fake-home-"));
  realHome = process.env.HOME;
  process.env.HOME = fakeHomeDir;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(fakeHomeDir, { recursive: true, force: true });
  if (realHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = realHome;
  }
});

/** Every tool result is `{ content: [{ type: "text", text }] }`. */
function parseResult(result: Awaited<ReturnType<typeof handleListSkills>>): unknown {
  const first = result.content[0];
  if (first.type !== "text") throw new Error("expected a text content block");
  return JSON.parse(first.text);
}

function writeSkill(name: string, description = `Skill ${name}`) {
  const dir = join(root, ".agents", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), ["---", `name: ${name}`, `description: ${description}`, "---", "Body."].join("\n"), "utf8");
}

describe("handleListSkills", () => {
  it("returns an empty catalog for a workspace with no skills", async () => {
    const result = await handleListSkills(root);
    expect(result.isError).toBeFalsy();
    expect(parseResult(result)).toEqual({ skills: [], diagnostics: [] });
  });

  it("returns catalog entries without the full body", async () => {
    writeSkill("mcp-skill", "An MCP-visible skill");
    const result = await handleListSkills(root);
    const body = parseResult(result) as { skills: Array<Record<string, unknown>> };
    expect(body.skills).toHaveLength(1);
    expect(body.skills[0].name).toBe("mcp-skill");
    expect(body.skills[0]).not.toHaveProperty("body");
  });
});

describe("handleGetSkill", () => {
  it("returns isError: true for an unknown skill name", async () => {
    const result = await handleGetSkill(root, "does-not-exist");
    expect(result.isError).toBe(true);
  });

  it("returns the full skill including its body", async () => {
    const dir = join(root, ".agents", "skills", "full-mcp-skill");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      ["---", "name: full-mcp-skill", "description: A skill", "---", "The complete body."].join("\n"),
      "utf8"
    );

    const result = await handleGetSkill(root, "full-mcp-skill");
    expect(result.isError).toBeFalsy();
    const body = parseResult(result) as { body: string };
    expect(body.body).toBe("The complete body.");
  });
});
