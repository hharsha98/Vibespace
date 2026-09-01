/**
 * Deciding WHAT "resume" means per agent CLI — the pure decision logic
 * behind session recovery, deliberately kept separate from `restore.ts`
 * (which actually spawns things) so it's testable with zero I/O.
 *
 * --- What each installed agent CLI actually supports, checked firsthand ---
 * All three of `claude`, `codex`, and `cursor-agent` are installed on the
 * machine this feature was built on; every flag below was read straight out
 * of that CLI's own `--help` (and, for codex, `codex resume --help`) output
 * — nothing here is guessed.
 *
 * claude (Claude Code) — HIGH confidence:
 *   -r, --resume [value]   Resume a conversation by session ID, or open an
 *                          interactive picker with an optional search term.
 *   -c, --continue         Continue the most recent conversation in cwd.
 *   --session-id <uuid>    Use a specific session ID for the conversation
 *                          (must be a valid UUID) — settable at SPAWN time.
 * Because `--session-id` lets vibespace CHOOSE the id up front, every claude
 * session is spawned with a freshly-generated uuid via that flag (see
 * `spawnExtrasFor` below), stored as `SessionRecord.agentSessionRef`.
 * Resuming then uses `claude --resume <that exact uuid>` — a precise match,
 * not a "most recent" guess, correct even with several claude panes open in
 * the same directory. A record with no `agentSessionRef` (one that predates
 * this feature, or whose ref was somehow never captured) falls back to
 * `--continue`.
 *
 * codex — HIGH confidence:
 * Resume is a SUBCOMMAND, not a flag: `codex resume [SESSION_ID] [--last]`.
 * codex manages its own session ids internally in its own on-disk session
 * store; there is no `--session-id`-equivalent flag to pin one ourselves at
 * spawn time, so exact targeting the way claude gets isn't possible here.
 * `codex resume --last` is the best available match: it resumes the most
 * recent session, and BY DEFAULT `codex resume` filters to the current
 * working directory (cwd filtering is the default; `--all` turns it off) —
 * exactly the pane's own `cwd`, since codex is always spawned there. Good
 * in the common case (one codex pane per directory); imprecise if several
 * codex panes ever ran in the exact same directory.
 *
 * cursor-agent — HIGH confidence:
 *   --resume [chatId]   Select a session to resume — opens an interactive
 *                       picker when no id is given, which isn't usable
 *                       non-interactively from a spawned pty.
 *   --continue          Continue the previous session, no picker.
 * Same situation as codex: no flag exists to capture a chat id at spawn
 * time, so `--continue` (non-interactive, most-recent) is what's used.
 *
 * Every other agent (droid, deepseek, antigravity, gemini, opencode, grok)
 * and the plain shell/SSH panes — NO resume flag found or confirmed for any
 * of them (most were never installed on this machine to check `--help`
 * against in the first place — see `pty/agents.ts`'s `INSTALL_HINTS`
 * comment for the overall confidence level already on record for each).
 * Rather than guess a flag that might not exist and crash the resume, these
 * fall back to the honest, always-correct behaviour: a FRESH session in the
 * same pane, with the same cwd — exactly what "resume" already, simply,
 * means for a plain shell or an SSH pane.
 */
import { randomUUID } from "node:crypto";
import type { AgentId, SessionRecord } from "@vibespace/shared";

const CLAUDE_SESSION_ID_FLAG = "--session-id";

export interface SpawnExtras {
  /** Extra argv appended to the normal spawn args for a BRAND NEW (never
   * resumed before) session. */
  args: string[];
  /** The stable per-agent-CLI session handle to remember for a later
   * resume, or null if this agent has none (see this file's research
   * above). */
  agentSessionRef: string | null;
}

/**
 * Decides what extra argv (if any) a brand-new spawn for `agent` should
 * carry, so a later resume has something exact to target. Only `claude`
 * gets anything today. Never called for SSH panes — an SSH pane's identity
 * is the profile it connects through, not an agent-CLI flag.
 */
export function spawnExtrasFor(agent: AgentId): SpawnExtras {
  if (agent === "claude") {
    const sessionId = randomUUID();
    return { args: [CLAUDE_SESSION_ID_FLAG, sessionId], agentSessionRef: sessionId };
  }
  return { args: [], agentSessionRef: null };
}

export interface ResumePlan {
  /** Extra argv for the resume spawn. Empty array (not null) even for the
   * "no resume concept" fallback — a fresh spawn still uses the agent's
   * normal args, it just adds nothing extra. */
  args: string[];
  /** Short, human-readable explanation of what actually happened —
   * surfaced in the UI (`ResumeSessionResponse.note`) so a "fresh session"
   * fallback never silently pretends to be a real resume. */
  note: string;
}

/**
 * Decides how to resume a LOCAL-agent record (never called for an SSH
 * session — `restore.ts`'s `attemptResume` branches on `sshProfileId`
 * before ever reaching this, since an SSH "resume" is always just a fresh
 * connection through the same profile, nothing to decide). Pure function —
 * no spawning, no I/O — see this file's top comment for the research
 * behind each case.
 */
export function planResume(record: Pick<SessionRecord, "agent" | "agentSessionRef">): ResumePlan {
  switch (record.agent) {
    case "claude":
      return record.agentSessionRef
        ? {
            args: ["--resume", record.agentSessionRef],
            note: "Resumed with claude --resume (same conversation).",
          }
        : {
            args: ["--continue"],
            note: "Resumed with claude --continue (no saved session id; picked the most recent).",
          };
    case "codex":
      return {
        args: ["resume", "--last"],
        note: "Resumed with codex resume --last (most recent session in this directory).",
      };
    case "cursor-agent":
      return {
        args: ["--continue"],
        note: "Resumed with cursor-agent --continue (most recent session).",
      };
    case "shell":
      return { args: [], note: "Started a fresh shell in the same directory." };
    default:
      return {
        args: [],
        note: `${record.agent} has no known resume flag — started a fresh session in the same directory.`,
      };
  }
}
