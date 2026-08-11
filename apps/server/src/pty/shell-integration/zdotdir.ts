/**
 * Injects vibedeck's shell integration (see `vibedeck-integration.zsh`)
 * into a spawned "shell" agent's pty — WITHOUT ever writing to, or even
 * reading-and-modifying, the user's real dotfiles (`~/.zshrc` etc). Getting
 * this wrong would corrupt a real person's shell setup, so here's exactly
 * how it stays safe:
 *
 * zsh decides where to look for `.zshenv`/`.zprofile`/`.zshrc`/`.zlogin`
 * from a single environment variable, `ZDOTDIR` (falling back to `$HOME` if
 * it's unset). So instead of touching the user's real files at all, we:
 *
 *   1. Create a throwaway temp directory (`os.tmpdir()/vibedeck-zdotdir-*`).
 *   2. Write our OWN `.zshenv`/`.zprofile`/`.zshrc`/`.zlogin` into it. Each
 *      one's entire job is "source the user's REAL file of the same name
 *      first, if it exists" — so their actual aliases, PATH exports, prompt
 *      customizations, etc. all still load exactly as before. `.zshrc`
 *      additionally sources `vibedeck-integration.zsh` (also copied into
 *      this same temp dir) AFTER the real one, so our hooks layer on top of
 *      (not instead of) whatever prompt the user already has.
 *   3. Spawn the pty with `ZDOTDIR` pointed at that temp dir, and
 *      `_VIBEDECK_REAL_ZDOTDIR` set to where their REAL dotfiles actually
 *      live (their real `$ZDOTDIR` if they'd already customized it,
 *      otherwise `$HOME` — the normal zsh default).
 *
 * The user's real files are only ever *read* (by zsh itself, via `source`,
 * at shell-startup time) — this module never opens them for writing, and
 * every `writeFileSync` call in it targets a path built from the temp dir
 * this module itself created a moment earlier.
 *
 * `VIBEDECK_DISABLE_SHELL_INTEGRATION=1` skips all of this — `getEnvForShell`
 * just returns `null`, and the caller (SessionManager) spawns the shell
 * exactly as it would have before this phase existed.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The four zsh startup files ZDOTDIR redirects, in the order zsh itself
 * reads them (zshenv always first, zlogin only for login shells — vibedeck
 * spawns shells with `-l`, so all four actually run). */
const RC_FILE_NAMES = [".zshenv", ".zprofile", ".zshrc", ".zlogin"] as const;
type RcFileName = (typeof RC_FILE_NAMES)[number];

const INTEGRATION_SCRIPT_FILENAME = "vibedeck-integration.zsh";

/** Absolute path to this module's own directory, resolved the ESM way
 * (no `__dirname` global available). `vibedeck-integration.zsh` always
 * lives right next to the compiled/transpiled version of THIS file — in
 * `src/` under `tsx`/`vitest`, or in `dist/` after `pnpm build` (the
 * server's `build` script copies the .zsh file alongside the compiled JS
 * for exactly this reason) — so this resolves correctly in both places. */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** The real, on-disk path to `vibedeck-integration.zsh` this process should
 * read from. A named export (not just used internally) so tests can point
 * `createShellIntegrationDir` at a fixture script instead of the real one. */
export const INTEGRATION_SCRIPT_PATH = join(MODULE_DIR, INTEGRATION_SCRIPT_FILENAME);

/** The escape-hatch env var: set to exactly `"1"` to skip shell integration
 * entirely (no ZDOTDIR override, no temp dir, shell spawns unchanged). */
export const DISABLE_ENV_VAR = "VIBEDECK_DISABLE_SHELL_INTEGRATION";

/**
 * Where the user's REAL dotfiles live — their own `$ZDOTDIR` if they've
 * already customized it, otherwise `$HOME` (zsh's own default when
 * `ZDOTDIR` is unset). Pure function of its inputs (no direct `process.env`
 * / `os.homedir()` reads) so it's trivially unit-testable with fake values.
 */
export function resolveRealZdotdir(env: NodeJS.ProcessEnv, fallbackHomedir: string): string {
  const existing = env.ZDOTDIR;
  return existing && existing.length > 0 ? existing : fallbackHomedir;
}

/**
 * The generated content for one of the four ZDOTDIR shim files. Pure
 * (string in, string out) — the actual sourcing of the user's real file
 * happens later, when zsh itself runs this content; nothing here touches
 * the filesystem.
 *
 * Every file sources its real counterpart first (via `$_VIBEDECK_REAL_ZDOTDIR`,
 * an env var the pty is spawned with — see the module doc comment above).
 * Only `.zshrc` also appends the vibedeck integration hooks, since that's
 * the one file that's guaranteed to run for both interactive login AND
 * non-login shells, and it's the conventional place for hook/prompt setup.
 */
export function generateRcFileContent(fileName: RcFileName, includeIntegration: boolean): string {
  const lines = [
    `# vibedeck: generated ZDOTDIR shim for ${fileName}.`,
    "# This file is NOT the user's real config — it lives in a throwaway temp",
    "# directory (see zdotdir.ts) and exists purely to source the user's real",
    `# ${fileName} (if they have one) so their normal shell setup still loads.`,
    `if [[ -f "$_VIBEDECK_REAL_ZDOTDIR/${fileName}" ]]; then`,
    `  source "$_VIBEDECK_REAL_ZDOTDIR/${fileName}"`,
    "fi",
  ];
  if (includeIntegration) {
    lines.push(
      "",
      "# vibedeck shell integration — OSC 133 command-block markers. Sourced",
      "# AFTER the real .zshrc above, so it layers on top of (never replaces)",
      "# whatever prompt/hooks the user already has.",
      `if [[ -f "$ZDOTDIR/${INTEGRATION_SCRIPT_FILENAME}" ]]; then`,
      `  source "$ZDOTDIR/${INTEGRATION_SCRIPT_FILENAME}"`,
      "fi"
    );
  }
  return lines.join("\n") + "\n";
}

/**
 * Creates a fresh throwaway ZDOTDIR: a temp directory containing the four
 * generated shim files plus a copy of the integration script itself.
 * Every path this function writes to is built from the `mkdtempSync` result
 * it just created — nothing here can ever write outside that directory.
 *
 * @param integrationScriptPath Where to read the real integration script
 *   from (defaults to the actual `vibedeck-integration.zsh` next to this
 *   module; overridable so tests can use a small fixture instead).
 * @returns The absolute path to the new temp ZDOTDIR.
 */
export function createShellIntegrationDir(
  integrationScriptPath: string = INTEGRATION_SCRIPT_PATH
): string {
  // `mkdtempSync` appends random characters to this prefix and creates the
  // directory atomically — it's the standard safe way to get a private
  // scratch directory, and it's always placed directly under `os.tmpdir()`.
  const dir = mkdtempSync(join(tmpdir(), "vibedeck-zdotdir-"));

  const scriptContent = readFileSync(integrationScriptPath, "utf8");
  writeFileSync(join(dir, INTEGRATION_SCRIPT_FILENAME), scriptContent, "utf8");

  for (const fileName of RC_FILE_NAMES) {
    writeFileSync(join(dir, fileName), generateRcFileContent(fileName, fileName === ".zshrc"), "utf8");
  }

  return dir;
}

/**
 * Owns the (single, shared, lazily-created) temp ZDOTDIR for one server's
 * lifetime. `SessionManager` holds exactly one instance of this; every
 * "shell" pane it spawns reuses the same temp dir, and `dispose()` (wired
 * to `SessionManager.disposeAll()`, which already runs on server shutdown
 * and in every test's `afterEach`) cleans it up.
 */
export class ShellIntegrationManager {
  private zdotdir: string | null = null;
  private readonly realZdotdir: string;

  constructor(env: NodeJS.ProcessEnv = process.env, fallbackHomedir: string = homedir()) {
    this.realZdotdir = resolveRealZdotdir(env, fallbackHomedir);
  }

  /**
   * The env overrides a "shell" agent's pty should be spawned with, or
   * `null` if shell integration is disabled — callers must treat `null` as
   * "spawn with no changes at all," not as "spawn with an empty object."
   * `env` is read fresh on every call (not just at construction) so the
   * escape hatch can be toggled between calls, which is what lets tests
   * exercise both branches against a single manager instance.
   */
  getEnvForShell(env: NodeJS.ProcessEnv = process.env): Record<string, string> | null {
    if (env[DISABLE_ENV_VAR] === "1") return null;
    if (!this.zdotdir) {
      this.zdotdir = createShellIntegrationDir();
    }
    return { ZDOTDIR: this.zdotdir, _VIBEDECK_REAL_ZDOTDIR: this.realZdotdir };
  }

  /**
   * Removes the temp dir, if one was ever created. Idempotent — safe to
   * call even when no "shell" pane was ever spawned (or integration was
   * disabled the whole time), which is exactly what happens on every
   * `disposeAll()` in tests that never touch the "shell" agent.
   */
  dispose(): void {
    if (this.zdotdir) {
      rmSync(this.zdotdir, { recursive: true, force: true });
      this.zdotdir = null;
    }
  }
}
