/**
 * Skill discovery: scans the six conventional `agentskills.io` directories
 * (three user-scoped, three project-scoped) and returns every valid skill
 * found, later scope winning on a name collision. See `docs/SKILLS.md` for
 * the full scope table and the reasoning behind it; this file's job is just
 * to implement that table correctly and safely.
 *
 * --- TRUST BOUNDARY: project-scoped skills are untrusted input ---
 * The three PROJECT scopes live inside the repository being worked on —
 * `<workspaceRoot>/.agents/skills`, `.vibedeck/skills`, `.claude/skills`.
 * A freshly `git clone`d repo is, by definition, content the user has not
 * reviewed yet, and a `SKILL.md` is prose an agent is meant to read and
 * act on — so a malicious repo could ship a skill whose description/body
 * tries to steer a connected agent into doing something the user never
 * asked for (classic prompt injection, just delivered as a "skill" instead
 * of a code comment). This module does NOT solve that — nothing short of
 * not reading the file at all would — but it does two narrower things:
 *   1. Every discovered skill carries its `scope` (`user` vs `project`) all
 *      the way through to the REST/MCP response, so a human or an agent can
 *      tell "this came from the repo I just cloned" from "this is one of
 *      MY skills" before deciding whether to trust it.
 *   2. `safeResolve` (below) blocks a symlinked skill directory from
 *      resolving OUTSIDE its scope root — e.g. a repo shipping
 *      `.agents/skills/leak -> /etc` to read arbitrary files off the host
 *      as if they were "skill content". That's a path-escape bug, not a
 *      content-trust one, and it's the one part of this risk a parser
 *      actually can close.
 * Neither of these makes a project skill's INSTRUCTIONS trustworthy. That
 * is a human judgement call the UI must support (via `scope`), not
 * something this server can adjudicate.
 */
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { safeResolve } from "../files/safe-path.js";
import { parseSkill, type ParsedSkill, type SkillDiagnostic } from "./parse.js";

const SKILL_FILE_NAME = "SKILL.md";

// Never descend into these even if somehow present directly under a scope
// root (e.g. a scope root that happens to equal a git checkout) — neither
// is ever a skill directory, and node_modules in particular can be huge.
const SKIP_ENTRY_NAMES = new Set([".git", "node_modules"]);

/**
 * Upper bound on how many directory entries (across every scope, in one
 * `discoverSkills` call) this module will ever look at before giving up
 * and recording a diagnostic instead of silently returning a partial list.
 * 2000 is generous for any real skill collection (realistically dozens,
 * maybe low hundreds across six directories) while still bounding a
 * pathological or adversarial case — see this file's top comment: a
 * project scope is untrusted input, and nothing stops a hostile repo from
 * dropping thousands of decoy directories under `.agents/skills/` purely
 * to make discovery itself expensive.
 */
const MAX_ENTRIES_EXAMINED = 2000;

export type SkillScopeKind = "user" | "project";
export type SkillScopeDirLabel = ".agents/skills" | ".vibedeck/skills" | ".claude/skills";

export interface SkillScope {
  kind: SkillScopeKind;
  /** Which of the three conventional subdirectories this came from. */
  dirLabel: SkillScopeDirLabel;
  /** Absolute path to the scope root itself (not the individual skill's
   * own directory) — e.g. "/Users/x/.claude/skills". */
  rootDir: string;
}

export interface DiscoveredSkill {
  skill: ParsedSkill;
  scope: SkillScope;
  /** Absolute path to this skill's own directory. */
  dir: string;
  /** Diagnostics produced while parsing THIS skill's SKILL.md (name
   * mismatch, oversized description, etc) — a subset of the full result's
   * `diagnostics`, scoped to just this one skill for convenience. */
  diagnostics: SkillDiagnostic[];
}

export interface DiscoverSkillsResult {
  /** One entry per unique skill NAME — a collision between scopes resolves
   * to the later (higher-precedence) scope's skill; see `buildScopeList`. */
  skills: DiscoveredSkill[];
  /** Every diagnostic from every scope: parse warnings/errors (each
   * prefixed with the file they came from), collision notices, and a
   * scan-cap notice if `MAX_ENTRIES_EXAMINED` was hit. */
  diagnostics: SkillDiagnostic[];
}

/**
 * The six scopes `discoverSkills` scans, in ascending precedence order — a
 * LATER scope's skill wins a name collision against an earlier one. The
 * three project scopes are listed last specifically so "project overrides
 * user" (the universal convention every dotfile-style tool follows) falls
 * out of plain list order rather than needing separate tie-break logic.
 * `workspaceRoot` is `null` for a discovery call with no project context
 * (there is none today — both the REST routes and the MCP tools always
 * have a workspace root — but the type stays honest about it being
 * optional rather than asserting non-null everywhere).
 */
function buildScopeList(workspaceRoot: string | null, homeDir: string): SkillScope[] {
  const scopes: SkillScope[] = [
    { kind: "user", dirLabel: ".agents/skills", rootDir: join(homeDir, ".agents", "skills") },
    { kind: "user", dirLabel: ".vibedeck/skills", rootDir: join(homeDir, ".vibedeck", "skills") },
    { kind: "user", dirLabel: ".claude/skills", rootDir: join(homeDir, ".claude", "skills") },
  ];
  if (workspaceRoot) {
    scopes.push(
      { kind: "project", dirLabel: ".agents/skills", rootDir: join(workspaceRoot, ".agents", "skills") },
      { kind: "project", dirLabel: ".vibedeck/skills", rootDir: join(workspaceRoot, ".vibedeck", "skills") },
      { kind: "project", dirLabel: ".claude/skills", rootDir: join(workspaceRoot, ".claude", "skills") }
    );
  }
  return scopes;
}

/**
 * Scans one scope root for skill directories: every immediate child that is
 * (or, via a symlink, resolves to) a real directory containing a
 * `SKILL.md` file. This is the ONLY depth ever scanned — a skill directory
 * is depth 1 below its scope root, and nothing inside a skill's own
 * `scripts/`, `references/`, or `assets/` subdirectories is ever walked
 * looking for more skills. That keeps this a flat `readdir`, not a
 * recursive filesystem walk, and is why there's no separate "depth" cap
 * variable — the shape of the loop already IS the cap.
 *
 * Mutates `budget` (see `MAX_ENTRIES_EXAMINED`) and `diagnostics` in place
 * rather than returning them, purely so the caller can share one running
 * budget across all six scopes instead of resetting it per scope.
 */
function scanScope(
  scope: SkillScope,
  budget: { remaining: number },
  diagnostics: SkillDiagnostic[]
): DiscoveredSkill[] {
  if (!existsSync(scope.rootDir)) return []; // missing scope directory is normal, not an error

  let entries: Dirent[];
  try {
    entries = readdirSync(scope.rootDir, { withFileTypes: true });
  } catch {
    return []; // unreadable (permissions, race with a delete, ...) — treat like "missing"
  }

  const found: DiscoveredSkill[] = [];

  for (const entry of entries) {
    if (budget.remaining <= 0) break;
    budget.remaining--;

    if (SKIP_ENTRY_NAMES.has(entry.name)) continue;
    // Accept plain directories AND symlinks, but only symlinks that, once
    // resolved, still land INSIDE `scope.rootDir` — `safeResolve` (below)
    // is what actually enforces that. Concretely: a symlink pointing
    // somewhere else under the same scope root (e.g. an alias for another
    // skill directory) is followed; a symlink escaping the scope root
    // entirely — including the common "point this at a skills folder I
    // keep somewhere else" pattern, and the malicious `leak -> /etc` case
    // from this file's top-comment trust boundary — is refused, not
    // followed. That's a real, deliberate limitation, not an oversight:
    // this module has no way to tell "my own trusted symlink to my dotfiles
    // repo" apart from "a project skill's malicious symlink to /etc", so it
    // treats both the same and blocks both.
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

    const resolved = safeResolve(scope.rootDir, entry.name);
    if (!resolved.ok) continue; // symlink escapes the scope root — refuse to follow it

    let entryStat: ReturnType<typeof statSync>;
    try {
      entryStat = statSync(resolved.path);
    } catch {
      continue; // broken symlink or similar
    }
    if (!entryStat.isDirectory()) continue;

    const skillMdPath = join(resolved.path, SKILL_FILE_NAME);
    if (!existsSync(skillMdPath)) continue; // a directory with no SKILL.md isn't a skill

    let raw: string;
    try {
      raw = readFileSync(skillMdPath, "utf8");
    } catch {
      diagnostics.push({ level: "error", message: `Could not read ${skillMdPath}; skipping.` });
      continue;
    }

    const { skill, diagnostics: parseDiagnostics } = parseSkill(raw, entry.name);
    for (const d of parseDiagnostics) {
      diagnostics.push({ ...d, message: `${skillMdPath}: ${d.message}` });
    }
    if (!skill) continue; // parseSkill already recorded why (SKIP case)

    found.push({ skill, scope, dir: resolved.path, diagnostics: parseDiagnostics });
  }

  return found;
}

/**
 * Discovers every skill visible to `workspaceRoot` (pass `null` for a
 * user-scopes-only discovery). `homeDir` defaults to the real
 * `os.homedir()` but is overridable — the same dependency-injection
 * pattern `pty/shell-integration/zdotdir.ts`'s `fallbackHomedir` parameter
 * uses — so tests can point every USER scope at a throwaway temp directory
 * instead of the real `~`. `maxEntries` defaults to the real
 * `MAX_ENTRIES_EXAMINED` cap; it's overridable purely so discover.test.ts
 * can exercise "the cap was hit" without actually creating 2000+ files on
 * disk for every test run — no production caller passes it.
 */
export function discoverSkills(
  workspaceRoot: string | null,
  homeDir: string = homedir(),
  maxEntries: number = MAX_ENTRIES_EXAMINED
): DiscoverSkillsResult {
  const scopes = buildScopeList(workspaceRoot, homeDir);
  const byName = new Map<string, DiscoveredSkill>();
  const diagnostics: SkillDiagnostic[] = [];
  const budget = { remaining: maxEntries };

  for (const scope of scopes) {
    if (budget.remaining <= 0) break;
    const found = scanScope(scope, budget, diagnostics);

    for (const discovered of found) {
      const existing = byName.get(discovered.skill.name);
      if (existing) {
        diagnostics.push({
          level: "warning",
          message:
            `Skill "${discovered.skill.name}" at ${discovered.dir} shadows the one at ${existing.dir} ` +
            `(scope precedence: project overrides user; later-listed scopes win).`,
        });
      }
      byName.set(discovered.skill.name, discovered);
    }
  }

  if (budget.remaining <= 0) {
    diagnostics.push({
      level: "warning",
      message: `Hit the ${maxEntries}-entry skill-scan cap; some skills may be missing from this list.`,
    });
  }

  return { skills: [...byName.values()], diagnostics };
}

/** Shapes a `DiscoveredSkill` for the CATALOG view (`GET /api/skills`,
 * `list_skills`) — name/description/scope/location, deliberately NOT the
 * full body, per progressive disclosure. */
export function catalogEntry(discovered: DiscoveredSkill) {
  const { skill, scope, dir } = discovered;
  return {
    name: skill.name,
    description: skill.description,
    license: skill.license,
    compatibility: skill.compatibility,
    scope,
    dir,
  };
}

/** Shapes a `DiscoveredSkill` for a single-skill READ (`GET
 * /api/skills/:name`, `get_skill`) — everything, including the full body. */
export function fullSkill(discovered: DiscoveredSkill) {
  const { skill, scope, dir } = discovered;
  return { ...skill, scope, dir };
}
