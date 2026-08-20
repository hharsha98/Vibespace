/**
 * Tests for the SSH profile argv/remote-command builder — see spawn.ts's top
 * comment for the full design. These deliberately do NOT open a real SSH
 * connection (there is no host to reach in CI, and it would hang) — the
 * injection-proof tests instead run the built remote-command STRING through
 * a real local `/bin/sh`, the same interpreter a remote Unix host's login
 * shell would use, which is a faithful test of the quoting logic without
 * needing network access.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRemoteCommand, buildSshArgv, posixSingleQuote, type SshSpawnProfile } from "./spawn.js";

function baseProfile(overrides: Partial<SshSpawnProfile> = {}): SshSpawnProfile {
  return {
    host: "example.com",
    user: null,
    port: null,
    defaultDirectory: null,
    startupCommand: null,
    ...overrides,
  };
}

describe("buildSshArgv", () => {
  it("always allocates a tty with -t", () => {
    expect(buildSshArgv(baseProfile())).toEqual(["-t", "example.com"]);
  });

  it("uses just the host when no user is set", () => {
    expect(buildSshArgv(baseProfile({ host: "prod.example.com" }))).toEqual([
      "-t",
      "prod.example.com",
    ]);
  });

  it("prefixes user@host when a user is set", () => {
    expect(buildSshArgv(baseProfile({ host: "prod.example.com", user: "deploy" }))).toEqual([
      "-t",
      "deploy@prod.example.com",
    ]);
  });

  it("adds -p <port> only when a port is set", () => {
    expect(buildSshArgv(baseProfile({ port: 2222 }))).toEqual(["-t", "-p", "2222", "example.com"]);
  });

  it("omits -p entirely when port is null (lets ssh/~/.ssh/config decide)", () => {
    const argv = buildSshArgv(baseProfile({ port: null }));
    expect(argv).not.toContain("-p");
  });

  it("sends no remote command at all when neither defaultDirectory nor startupCommand is set", () => {
    expect(buildSshArgv(baseProfile())).toHaveLength(2); // just ["-t", "example.com"]
  });

  it("appends exactly one extra argv element carrying the remote command when a directory is set", () => {
    const argv = buildSshArgv(baseProfile({ defaultDirectory: "/srv/app" }));
    expect(argv).toHaveLength(3);
    expect(argv[2]).toContain("cd -- '/srv/app'");
    expect(argv[2]).toContain('exec "${SHELL:-/bin/sh}" -l');
  });

  it("every host/user/port value is its own argv element, never concatenated into one shell line", () => {
    // The whole point: argv is an ARRAY passed straight to exec, so a
    // malicious-looking host/user is inert data, not shell syntax, with no
    // quoting needed at all.
    const argv = buildSshArgv(
      baseProfile({ host: "; rm -rf ~ #", user: "$(whoami)", port: 22, defaultDirectory: null })
    );
    expect(argv).toEqual(["-t", "-p", "22", "$(whoami)@; rm -rf ~ #"]);
    // It's one literal array element — never re-parsed as shell syntax by
    // anything in this codebase (node-pty spawns argv directly, no shell).
    expect(argv).toHaveLength(4);
  });

  it("full representative profile: user, custom port, directory, and a startup command", () => {
    const argv = buildSshArgv(
      baseProfile({
        host: "build.internal",
        user: "ci",
        port: 2200,
        defaultDirectory: "/srv/ci/workspace",
        startupCommand: "source .venv/bin/activate",
      })
    );
    expect(argv[0]).toBe("-t");
    expect(argv.slice(1, 3)).toEqual(["-p", "2200"]);
    expect(argv[3]).toBe("ci@build.internal");
    expect(argv[4]).toBe(
      `cd -- '/srv/ci/workspace' || echo 'vibedeck: couldn'\\''t cd to "/srv/ci/workspace" on connect' >&2; source .venv/bin/activate; exec "\${SHELL:-/bin/sh}" -l`
    );
  });
});

describe("buildRemoteCommand", () => {
  it("returns null when neither field is set", () => {
    expect(buildRemoteCommand(null, null)).toBeNull();
    expect(buildRemoteCommand("  ", "")).toBeNull(); // whitespace-only counts as unset
  });

  it("cd's, then always execs a real login shell — never leaves the user staring at a dead pane", () => {
    const cmd = buildRemoteCommand("/srv/app", null);
    expect(cmd).not.toBeNull();
    expect(cmd!.endsWith('exec "${SHELL:-/bin/sh}" -l')).toBe(true);
  });

  it("runs the startup command even when there's no directory to cd into", () => {
    const cmd = buildRemoteCommand(null, "npm run dev");
    expect(cmd).toBe('npm run dev; exec "${SHELL:-/bin/sh}" -l');
  });

  it("chains cd then the startup command then the final exec, in that order", () => {
    const cmd = buildRemoteCommand("/srv/app", "npm run dev");
    const cdIndex = cmd!.indexOf("cd --");
    const npmIndex = cmd!.indexOf("npm run dev");
    const execIndex = cmd!.indexOf("exec ");
    expect(cdIndex).toBeGreaterThanOrEqual(0);
    expect(npmIndex).toBeGreaterThan(cdIndex);
    expect(execIndex).toBeGreaterThan(npmIndex);
  });

  it("the startup command is passed through verbatim, unquoted — it's meant to run as shell code", () => {
    const cmd = buildRemoteCommand(null, "echo $HOME && ls -la");
    expect(cmd).toContain("echo $HOME && ls -la");
  });
});

describe("posixSingleQuote", () => {
  it("wraps an already-quote-free value in a plain pair of single quotes", () => {
    expect(posixSingleQuote("simple")).toBe("'simple'");
  });

  it("escapes an embedded single quote with the close-escape-reopen trick", () => {
    expect(posixSingleQuote("it's")).toBe(`'it'\\''s'`);
  });

  /**
   * The core injection-proof claim: for ANY string (including adversarial
   * ones containing quotes, semicolons, `$(...)`, backticks, or newlines),
   * wrapping it with posixSingleQuote and embedding it directly into a
   * shell script as a single-quoted literal reconstructs the EXACT
   * original string as one argument — never as additional shell syntax.
   * Proven by round-tripping through a REAL `/bin/sh`, not by asserting on
   * the produced string.
   */
  const ADVERSARIAL_VALUES = [
    "plain",
    "has spaces",
    "quote'inside",
    "semi;colon",
    "double && ampersand",
    "pipe | here",
    "cmdsub $(touch /tmp/should-not-exist)",
    "backtick `touch /tmp/should-not-exist`",
    "dollar $HOME expansion",
    "trailing backslash\\",
    "mixed 'single' and \"double\" quotes; $(evil) `evil2`",
    "newline\ninside",
  ];

  it.each(ADVERSARIAL_VALUES)("round-trips %j byte-for-byte through a real POSIX shell", (value) => {
    const quoted = posixSingleQuote(value);
    // Embed the quoted literal directly into the script TEXT (exactly how
    // ssh would embed it into the remote command line it sends), then have
    // the shell print $1 back out unmodified. If posixSingleQuote were
    // broken, this either throws (invalid shell syntax) or the output
    // differs from the input.
    const script = `printf %s ${quoted}`;
    const out = execFileSync("/bin/sh", ["-c", script]).toString();
    expect(out).toBe(value);
  });
});

describe("injection resistance — actually executing the built remote command", () => {
  let tmpDir: string;
  let marker: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vibedeck-ssh-injection-test-"));
    marker = join(tmpDir, "INJECTED");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * The real proof: take a defaultDirectory crafted to look like it's
   * trying to break out of the `cd --` argument and run an extra command,
   * build the remote command exactly as spawn.ts would send it to a real
   * SSH host, and run THAT STRING through a real `/bin/sh` (standing in
   * for what the remote host's shell would do with it). If quoting were
   * broken, the injected `touch` would create the marker file. It must
   * never appear. Runs with a short timeout and stdin/stdout discarded so
   * a broken quoting bug that somehow left an interactive shell attached
   * can't hang the test suite.
   */
  it("a directory crafted with a semicolon cannot inject a second command", () => {
    const dir = `/tmp/foo'; touch ${marker}; echo '`;
    const remoteCommand = buildRemoteCommand(dir, null)!;
    runNonInteractively(remoteCommand);
    expect(existsSync(marker)).toBe(false);
  });

  it("a directory crafted with $(...) command substitution cannot inject a second command", () => {
    const dir = `$(touch ${marker})`;
    const remoteCommand = buildRemoteCommand(dir, null)!;
    runNonInteractively(remoteCommand);
    expect(existsSync(marker)).toBe(false);
  });

  it("a directory crafted with backticks cannot inject a second command", () => {
    const dir = `\`touch ${marker}\``;
    const remoteCommand = buildRemoteCommand(dir, null)!;
    runNonInteractively(remoteCommand);
    expect(existsSync(marker)).toBe(false);
  });

  it("a directory crafted with a leading quote-and-semicolon AND a startup command still can't inject", () => {
    const dir = `foo'; touch ${marker}; echo '`;
    const remoteCommand = buildRemoteCommand(dir, "echo hello")!;
    runNonInteractively(remoteCommand);
    expect(existsSync(marker)).toBe(false);
  });

  it("a directory containing a space alone is treated as one literal path (cd fails harmlessly, no throw)", () => {
    const dir = "/tmp/does not exist/with spaces";
    const remoteCommand = buildRemoteCommand(dir, null)!;
    // Should not throw / should not hang — cd fails, falls through to echo,
    // then exec's a login shell (which exits immediately on EOF stdin).
    expect(() => runNonInteractively(remoteCommand)).not.toThrow();
  });

  /**
   * Runs a built remote-command string through a real `/bin/sh`, standing
   * in for the remote host's shell. stdin is `/dev/null`-equivalent
   * ("ignore") so the trailing `exec "${SHELL:-/bin/sh}" -l` (an
   * interactive login shell) hits EOF on its very first read and exits
   * immediately instead of hanging — a non-interactive stand-in that still
   * exercises every command BEFORE that final exec exactly as a real SSH
   * session would run them.
   */
  function runNonInteractively(remoteCommand: string): void {
    execFileSync("/bin/sh", ["-c", remoteCommand], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 5000,
    });
  }
});
