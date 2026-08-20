# SSH connection profiles

A pane doesn't have to run on this machine. An **SSH profile** is a saved
`{host, user, port, defaultDirectory, startupCommand}` record — open a pane
on it and vibedeck connects out over `ssh` instead of spawning a local
shell or agent CLI.

This closes a real capability gap: vibedeck had no remote support at all
before this. BridgeSpace shipped the equivalent in v3.2.1 ("SSH profiles
carry their workspace" — a per-profile default directory and startup
command, applied after connect, plus one-click Duplicate).

## The security decision, stated plainly

**vibedeck does not implement SSH itself, and it does not store
credentials.** Opening a remote pane spawns the system's real `ssh` binary
inside a pty — the exact same mechanism that already spawns `claude`,
`codex`, or a plain `shell` pane (`apps/server/src/pty/session-manager.ts`).
Authentication is entirely your own `ssh-agent`, keys, and `~/.ssh/config`
— the same setup your terminal already uses. vibedeck never sees, stores,
or transmits a password or a private key.

BridgeSpace stores passwords in a keychain. We deliberately don't: storing
a secret at rest is a liability this feature doesn't need to take on, and
key/agent auth is both safer and what most developers already have set up.

**The honest downside:** a host that only accepts password authentication
will prompt for one *inside the pane*, exactly like it would in any
terminal — vibedeck cannot pre-fill it, and has no plan to. If you need
that host, either switch it to key-based auth or type the password when
prompted, same as you always would.

## What a profile is

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Unique, human-readable label — what you pick it by |
| `host` | yes | Hostname or IP `ssh` connects to |
| `user` | no | SSH username; blank lets `ssh`/`~/.ssh/config` decide |
| `port` | no | TCP port; blank lets `ssh`/`~/.ssh/config` decide (usually 22) |
| `defaultDirectory` | no | `cd`'d into on the remote host right after connecting |
| `startupCommand` | no | A shell command run on the remote host after connecting (and after `cd`ing, if a directory is set) |

Profiles are **global**, not scoped to a workspace: a host is a machine,
not a project. You might open the same build box from three different
local projects, or one project might want panes on several different
remote hosts — a profile shouldn't have to be redefined per project the
way `~/.ssh/config` itself isn't. (Contrast this with `AgentProfile` and
`SavedPrompt`, which *are* workspace-scoped or nullable-for-global — see
`apps/server/src/agents/store.ts`'s and `apps/server/src/prompts/store.ts`'s
own comments.)

## Where to manage them

The **SSH** tab in the top-bar view switcher (`Cmd+R` / `Ctrl+R`) — a
list+detail page, the same shape as the **Agents** tab. Create, edit,
delete, and one-click **Duplicate** (which picks a free name automatically:
`"X copy"`, then `"X copy 2"`, `"X copy 3"`, …).

## Opening a pane on a profile

An empty pane's picker shows every saved profile in its own **Remote
(SSH)** section, below the local-agent grid, behind a hairline divider —
a deliberate, separate group so opening a remote pane is never mistaken
for starting a local CLI. Click a profile to connect; the command palette
also offers "Connect to `<profile>` in this pane" once a pane is focused
and empty.

## What actually gets run

`apps/server/src/ssh/spawn.ts` builds the `ssh` argv:

```
ssh -t [-p <port>] [<user>@]<host> [<remote-command>]
```

- **`-t`** always — allocates a real tty, without which TUIs and
  interactive shell prompts on the remote end misbehave.
- The **remote command** (only present if `defaultDirectory` or
  `startupCommand` is set) `cd`s into the directory, runs the startup
  command, and — no matter what happened before it — always ends by
  `exec`ing a real interactive login shell (`exec "${SHELL:-/bin/sh}" -l`),
  so you land in a usable pane instead of watching a one-shot command exit
  immediately.

Example, for a profile with a user, a non-default port, a directory, and a
startup command:

```
ssh -t -p 2200 ci@build.internal \
  "cd -- '/srv/ci/workspace' || echo 'vibedeck: ...' >&2; source .venv/bin/activate; exec \"\${SHELL:-/bin/sh}\" -l"
```

### How this stays injection-safe

Two different rules for two different kinds of input, both explained in
full in `spawn.ts`'s top comment:

- **`host` / `user` / `port` never need quoting at all.** They're passed as
  separate elements of an argv *array* straight to node-pty's
  `pty.spawn(command, args, ...)` — the same call every local agent/shell
  session already goes through — never concatenated into a shell string.
  A host of `"; rm -rf ~"` is just a literal, doomed-to-fail hostname.
- **`defaultDirectory` is DATA.** It's the one piece of user input that
  *does* have to become part of a shell string (`ssh`'s remote-command
  argument has no other shape), so it's wrapped in POSIX single quotes via
  `posixSingleQuote` — the standard "close quote, escaped quote, reopen
  quote" trick — so a directory containing spaces, quotes, semicolons,
  `$(...)`, or backticks is reconstructed as one literal argument, never
  as additional shell syntax. `startupCommand` is deliberately **not**
  quoted — it's meant to run as shell code (`source .venv/bin/activate`
  wouldn't mean anything if it were escaped into inertness) — trusted the
  same way a `~/.ssh/config` `RemoteCommand` directive or a Makefile you
  wrote yourself already is.

`apps/server/src/ssh/spawn.test.ts` proves this with 33 tests, including
round-tripping adversarial strings (quotes, `;`, `$(...)`, backticks,
newlines) through a **real POSIX shell**, and actually executing crafted
"breakout" directory names to confirm no injected command ever runs.

## Honest failure behaviour

- **`ssh` isn't installed** — checked before spawning; `POST /api/sessions`
  returns 409 with an install hint, the same shape a missing local agent
  binary already gets.
- **Host unreachable / auth rejected** — these can only be discovered by
  actually connecting. `ssh`'s own stderr streams straight into the pane
  (session-manager.ts never swallows pty output), so the real error shows
  up in the terminal, and the pane's header shows `(exited N)` once `ssh`
  gives up.
- **A host that only accepts password auth** prompts for one inside the
  pane, like any terminal would — see the security section above.

## Data model

Migration 7 (`apps/server/src/db/migrations.ts`) adds one table,
`ssh_profiles`, with `UNIQUE(name)` — the same "let SQLite arbitrate a
create/rename race, never check-then-insert" pattern every other unique
name in this codebase uses (see `apps/server/src/swarm/claims.ts`'s top
comment for the full reasoning). `user`, `port`, `default_directory`, and
`startup_command` are all nullable, each with an honest "not set" meaning
— never an empty string standing in for absence.

## REST API

| Method | Path | |
|---|---|---|
| GET | `/api/ssh-profiles` | List every profile |
| GET | `/api/ssh-profiles/:id` | One profile |
| POST | `/api/ssh-profiles` | Create |
| PATCH | `/api/ssh-profiles/:id` | Partial update |
| DELETE | `/api/ssh-profiles/:id` | Delete |
| POST | `/api/ssh-profiles/:id/duplicate` | One-click Duplicate |
| POST | `/api/sessions` | Send `{ sshProfileId, workspaceId? }` instead of `{ agent, workspaceId? }` to open a remote pane |
