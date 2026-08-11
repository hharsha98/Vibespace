import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DISABLE_ENV_VAR,
  ShellIntegrationManager,
  createShellIntegrationDir,
  generateRcFileContent,
  resolveRealZdotdir,
} from "./zdotdir.js";

// A tiny fixture script stands in for the real vibedeck-integration.zsh in
// most of these tests — its actual content isn't this file's concern (that's
// covered by reading it directly in production, and by hand-testing in a
// real terminal per the phase's verification steps); what matters here is
// that `createShellIntegrationDir` copies WHATEVER is at the given path,
// unmodified, into the temp dir.
function makeFixtureScript(): string {
  const dir = mkdtempSync(join(tmpdir(), "vibedeck-fixture-"));
  const path = join(dir, "fixture-integration.zsh");
  writeFileSync(path, "# fixture integration script\n", "utf8");
  return path;
}

describe("resolveRealZdotdir", () => {
  it("uses the user's own ZDOTDIR if they've already customized it", () => {
    expect(resolveRealZdotdir({ ZDOTDIR: "/custom/zdotdir" }, "/Users/fallback")).toBe(
      "/custom/zdotdir"
    );
  });

  it("falls back to $HOME (passed in as fallbackHomedir) when ZDOTDIR is unset", () => {
    expect(resolveRealZdotdir({}, "/Users/fallback")).toBe("/Users/fallback");
  });

  it("falls back to $HOME when ZDOTDIR is set but empty", () => {
    expect(resolveRealZdotdir({ ZDOTDIR: "" }, "/Users/fallback")).toBe("/Users/fallback");
  });
});

describe("generateRcFileContent", () => {
  it("every generated file sources the user's real config first, via $_VIBEDECK_REAL_ZDOTDIR", () => {
    for (const fileName of [".zshenv", ".zprofile", ".zshrc", ".zlogin"] as const) {
      const content = generateRcFileContent(fileName, fileName === ".zshrc");
      expect(content).toContain(`$_VIBEDECK_REAL_ZDOTDIR/${fileName}`);
      expect(content).toContain(`source "$_VIBEDECK_REAL_ZDOTDIR/${fileName}"`);
    }
  });

  it("only .zshrc appends the vibedeck integration sourcing", () => {
    const zshrc = generateRcFileContent(".zshrc", true);
    expect(zshrc).toContain("vibedeck-integration.zsh");
    expect(zshrc).toContain('source "$ZDOTDIR/vibedeck-integration.zsh"');

    for (const fileName of [".zshenv", ".zprofile", ".zlogin"] as const) {
      const content = generateRcFileContent(fileName, false);
      expect(content).not.toContain("vibedeck-integration.zsh");
    }
  });

  it("real-config sourcing is guarded with a file-existence check, not an unconditional source", () => {
    // A bare `source "$X"` would throw a "no such file" error in the spawned
    // shell if the user has no real .zshrc/.zprofile/etc — the `[[ -f ... ]]`
    // guard is what keeps that from breaking every "shell" pane for anyone
    // who doesn't happen to have all four dotfiles.
    const content = generateRcFileContent(".zshrc", true);
    expect(content).toMatch(/\[\[ -f "\$_VIBEDECK_REAL_ZDOTDIR\/\.zshrc" \]\]/);
  });
});

describe("createShellIntegrationDir", () => {
  let createdDirs: string[] = [];

  afterEach(() => {
    for (const dir of createdDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    createdDirs = [];
  });

  it("creates a fresh temp dir directly under the OS temp directory, and writes only inside it", () => {
    const scriptPath = makeFixtureScript();
    const dir = createShellIntegrationDir(scriptPath);
    createdDirs.push(dir);

    // The core safety property this whole module exists for: every file
    // this function produces lives under os.tmpdir(), nowhere else.
    expect(dir.startsWith(tmpdir())).toBe(true);

    const entries = readdirSync(dir).sort();
    expect(entries).toEqual(
      [".zlogin", ".zprofile", ".zshenv", ".zshrc", "vibedeck-integration.zsh"].sort()
    );

    for (const entry of entries) {
      expect(join(dir, entry).startsWith(tmpdir())).toBe(true);
    }
  });

  it("copies the integration script's exact content into the temp dir", () => {
    const scriptPath = makeFixtureScript();
    const dir = createShellIntegrationDir(scriptPath);
    createdDirs.push(dir);

    const copied = readFileSync(join(dir, "vibedeck-integration.zsh"), "utf8");
    const original = readFileSync(scriptPath, "utf8");
    expect(copied).toBe(original);
  });

  it("each call creates a distinct directory (no collisions across sessions)", () => {
    const scriptPath = makeFixtureScript();
    const a = createShellIntegrationDir(scriptPath);
    const b = createShellIntegrationDir(scriptPath);
    createdDirs.push(a, b);
    expect(a).not.toBe(b);
  });
});

describe("ShellIntegrationManager", () => {
  it("returns ZDOTDIR + _VIBEDECK_REAL_ZDOTDIR env overrides by default", () => {
    const manager = new ShellIntegrationManager({}, "/Users/fake-home");
    try {
      const env = manager.getEnvForShell({});
      expect(env).not.toBeNull();
      expect(env!.ZDOTDIR.startsWith(tmpdir())).toBe(true);
      expect(env!._VIBEDECK_REAL_ZDOTDIR).toBe("/Users/fake-home");
    } finally {
      manager.dispose();
    }
  });

  it("never writes anything under the real (fake) home directory it was given", () => {
    const fakeHome = join(tmpdir(), `vibedeck-fake-home-${Date.now()}`);
    // Deliberately do NOT create fakeHome — if this manager ever tried to
    // write into it, we'd see it appear.
    const manager = new ShellIntegrationManager({}, fakeHome);
    try {
      manager.getEnvForShell({});
      expect(existsSync(fakeHome)).toBe(false);
    } finally {
      manager.dispose();
    }
  });

  it("is disabled by VIBEDECK_DISABLE_SHELL_INTEGRATION=1 — no env overrides, no temp dir", () => {
    const manager = new ShellIntegrationManager({}, "/Users/fake-home");
    try {
      const env = manager.getEnvForShell({ [DISABLE_ENV_VAR]: "1" });
      expect(env).toBeNull();
    } finally {
      manager.dispose(); // no-op: nothing was ever created
    }
  });

  it("reuses the SAME temp dir across multiple calls (one shared ZDOTDIR per server)", () => {
    const manager = new ShellIntegrationManager({}, "/Users/fake-home");
    try {
      const first = manager.getEnvForShell({});
      const second = manager.getEnvForShell({});
      expect(second!.ZDOTDIR).toBe(first!.ZDOTDIR);
    } finally {
      manager.dispose();
    }
  });

  it("dispose() removes the temp dir, and is safe to call again or when nothing was created", () => {
    const manager = new ShellIntegrationManager({}, "/Users/fake-home");
    const env = manager.getEnvForShell({});
    const dir = env!.ZDOTDIR;
    expect(existsSync(dir)).toBe(true);

    manager.dispose();
    expect(existsSync(dir)).toBe(false);

    // Calling dispose again, or on a manager that never created anything,
    // must not throw.
    expect(() => manager.dispose()).not.toThrow();
    const freshManager = new ShellIntegrationManager({}, "/Users/fake-home");
    expect(() => freshManager.dispose()).not.toThrow();
  });
});
