/**
 * Building the `ssh` argv for a remote pane — the security-critical part of
 * SSH connection profiles (see `packages/shared/src/protocol.ts`'s
 * `SshProfile` doc comment for the feature's overall design and the
 * deliberate "we don't implement SSH or store credentials" trade-off).
 *
 * --- Why this is safe: argv, not a shell line ---
 * `apps/server/src/pty/session-manager.ts` spawns whatever `{command, args}`
 * this file returns via node-pty's `pty.spawn(command, args, options)` —
 * the SAME call every local agent/shell session already goes through (see
 * `resolveAgent` in `../pty/agents.ts`). `args` is a plain string ARRAY,
 * handed to the OS's exec family directly; it is never concatenated into a
 * single string and handed to `/bin/sh -c`. That means `profile.host`,
 * `profile.user`, and `profile.port` can contain absolutely any bytes — a
 * host string of `"; rm -rf ~"` is just a literal (nonsense) hostname `ssh`
 * will fail to resolve, never shell syntax — with ZERO quoting needed for
 * any of them, the same way a local agent's `cwd` never needs quoting
 * either.
 *
 * --- The one place a shell string is unavoidable, and how it's made safe --
 * `ssh` itself has no flag for "cd here, then run this command, then hand me
 * an interactive shell" — the only way to do any of that is to give `ssh`
 * ONE extra argv element containing a command line for the REMOTE shell to
 * interpret (this is standard `ssh host command...` behaviour). That one
 * string is built by `buildRemoteCommand` below, and it treats its two
 * inputs completely differently on purpose:
 *
 *   - `defaultDirectory` is DATA — a path, never intended as code. It is
 *     wrapped by `posixSingleQuote` before being placed after `cd --`, so a
 *     directory name containing spaces, single quotes, `;`, `&&`, `$(...)`,
 *     backticks, or newlines is reconstructed by the remote shell as ONE
 *     literal argument to `cd`, never as additional shell syntax. See
 *     `posixSingleQuote`'s own doc comment for the quoting proof, and
 *     `spawn.test.ts` for round-trip tests through a real POSIX shell (not
 *     just string assertions) plus a live "no injected command actually
 *     runs" test.
 *   - `startupCommand` is CODE — the user explicitly asked for a shell
 *     command to run on connect (e.g. `source .venv/bin/activate`), so it is
 *     deliberately NOT quoted; quoting it would break the one thing it's
 *     for. It is trusted the same way `AgentProfile.systemPrompt` or a
 *     `~/.ssh/config` `RemoteCommand` directive already are elsewhere in
 *     this codebase: configuration the user authored themselves, not
 *     untrusted input arriving over the network.
 *
 * --- Why the remote command always ends by exec'ing a real shell ---
 * If `ssh host 'cd foo && something'` were sent as-is, the remote session
 * would run that one command and exit the instant it finished — the user
 * would never actually land in a usable pane. Every remote command this
 * file builds therefore ends with `exec "${SHELL:-/bin/sh}" -l`: `exec`
 * replaces the (throwaway) command-interpreting shell process with a real
 * interactive login shell instead of spawning it as a child, so the pane
 * behaves exactly like connecting by hand and typing `cd`/the startup
 * command yourself, not like a one-shot command that leaves you staring at
 * a dead pane. `${SHELL:-/bin/sh}` reads the REMOTE machine's own `$SHELL`
 * (falling back to `/bin/sh` if it's unset) — this is the remote's shell,
 * a different question entirely from `resolveAgent`'s local `$SHELL` read
 * for the plain `shell` agent.
 */

/** The minimal shape `buildSshArgv` needs — a structural subset of
 * `SshProfile` (see `packages/shared/src/protocol.ts`) so this module never
 * has to import the `id`/`name`/`createdAt`/`updatedAt` fields it has no use
 * for. Every real `SshProfile` satisfies this automatically. */
export interface SshSpawnProfile {
  host: string;
  user: string | null;
  port: number | null;
  defaultDirectory: string | null;
  startupCommand: string | null;
}

/**
 * Wraps `value` in single quotes so a POSIX shell treats the WHOLE thing as
 * one completely literal argument — immune to spaces, semicolons, `&&`,
 * `$(...)` command substitution, backticks, or any other shell metacharacter
 * inside `value`, even a single quote itself (via the standard "close quote,
 * emit an escaped quote, reopen quote" trick: `'` becomes `'\''`).
 *
 * This is the ONLY thing standing between "a default directory with a space
 * or a quote in its name" and a remote command injection — see this file's
 * top comment. Every character of `value` ends up as DATA to the remote
 * shell, never as syntax. `spawn.test.ts` proves this by round-tripping
 * adversarial strings through a REAL `/bin/sh`, not just asserting on the
 * produced string.
 */
export function posixSingleQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

/**
 * Builds the one extra argv element `ssh` needs to apply a profile's
 * `defaultDirectory`/`startupCommand` after connecting, or `null` if neither
 * is set (in which case `buildSshArgv` sends no command at all, and `ssh`
 * just runs the remote's own default login shell — the plainest possible
 * connection, no injected behaviour whatsoever).
 *
 * Sequencing choice, stated explicitly: `cd` failing (e.g. a directory that
 * no longer exists on the remote) does NOT stop the startup command from
 * running, and NEITHER failing ever stops the final `exec` — every
 * connection using this profile still lands in a real interactive shell,
 * per this file's top comment. A `cd` failure is reported to the pane via
 * `echo ... >&2` (visible in the terminal, not swallowed) rather than
 * silently continuing as if it had succeeded.
 */
export function buildRemoteCommand(
  defaultDirectory: string | null,
  startupCommand: string | null
): string | null {
  const dir = defaultDirectory?.trim() || null;
  const cmd = startupCommand?.trim() || null;
  if (!dir && !cmd) return null;

  const parts: string[] = [];
  if (dir) {
    const quotedDir = posixSingleQuote(dir);
    // The failure message is ALSO run through posixSingleQuote — not just
    // the `cd` argument — even though it only ever appears after `echo`.
    // An earlier version of this function embedded the directory a SECOND
    // time inside a double-quoted echo string for a friendlier message;
    // that was a real command-injection bug (`spawn.test.ts` caught it):
    // POSIX double quotes still expand `$(...)`/backticks, so a directory
    // like `$(touch x)` re-triggered injection through the error message
    // even though the `cd --` argument itself was safely single-quoted.
    // Routing EVERYTHING through posixSingleQuote, with no double-quoted
    // context anywhere in this function, closes that off for good.
    const quotedMessage = posixSingleQuote(`vibedeck: couldn't cd to "${dir}" on connect`);
    parts.push(`cd -- ${quotedDir} || echo ${quotedMessage} >&2`);
  }
  if (cmd) {
    parts.push(cmd);
  }
  // `--` before the quoted path stops a directory name that happens to
  // start with "-" (e.g. "-rf") from ever being parsed as a `cd` flag.
  // The final `exec` always runs, whatever happened above — see this
  // function's own doc comment.
  parts.push(`exec "\${SHELL:-/bin/sh}" -l`);
  return parts.join("; ");
}

/**
 * Builds the full `ssh` argv for a profile: `-t` (allocate a real tty —
 * without it, TUIs and interactive shell prompts on the remote end render
 * incorrectly or refuse to run at all), an optional `-p <port>`, the
 * `[user@]host` destination, and — only if the profile sets a default
 * directory or startup command — one more argv element carrying the remote
 * command `buildRemoteCommand` builds above.
 *
 * Every element here is a separate argv entry (see this file's top comment
 * for why that's what makes `host`/`user`/`port` immune to injection with
 * zero quoting needed) — `session-manager.ts` passes this straight to
 * node-pty's `pty.spawn("ssh", args, ...)`, never through a shell.
 */
export function buildSshArgv(profile: SshSpawnProfile): string[] {
  const args: string[] = ["-t"];
  if (profile.port !== null) {
    args.push("-p", String(profile.port));
  }
  args.push(profile.user ? `${profile.user}@${profile.host}` : profile.host);

  const remoteCommand = buildRemoteCommand(profile.defaultDirectory, profile.startupCommand);
  if (remoteCommand !== null) {
    args.push(remoteCommand);
  }
  return args;
}
