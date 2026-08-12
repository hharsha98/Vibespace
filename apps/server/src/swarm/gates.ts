/**
 * Quality gates: run an arbitrary shell command (e.g. "pnpm test", "pnpm
 * lint") in a workspace and report pass/fail. This is deliberately a thin
 * wrapper around `node:child_process.spawn` — no sandboxing, no allowlist —
 * because a gate command is something the mission's own coordinator/human
 * chose to run, not untrusted client input reaching into arbitrary system
 * state beyond what the workspace's own shell already could.
 *
 * Two safety guards, because a gate command IS still something that can go
 * wrong even when trusted: it can hang (an interactive prompt, a dev server
 * that never exits) and it can produce unbounded output (a runaway build
 * log). Both are capped so a single bad gate command can't wedge the
 * server or blow up memory:
 *   - `GATE_TIMEOUT_MS`: the process is force-killed if it runs this long.
 *   - `GATE_OUTPUT_CAP_BYTES`: captured output stops growing past this —
 *     the process keeps running (so its exit code is still real), but
 *     further output is silently dropped rather than buffered forever.
 */
import { spawn } from "node:child_process";
import type { GateResult } from "@vibedeck/shared";

/** Force-kill a gate command that's still running after this long. Public
 * so callers/tests can reason about it; CI's own gate tests
 * (`true`/`false`) finish in milliseconds, so this default is generous
 * without making a genuinely hung command wedge the server for long. */
export const GATE_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

/** Stop growing the captured output buffer past this many bytes. A
 * misbehaving gate (e.g. a build stuck in a log-spam loop) must not be able
 * to grow server memory without bound just because someone ran a gate. */
export const GATE_OUTPUT_CAP_BYTES = 64 * 1024; // 64KB

/**
 * Runs `command` (via the system shell, so pipes/`&&`/etc all work exactly
 * like typing it into a terminal) inside `cwd`, capturing combined
 * stdout+stderr. Never rejects — a spawn failure (e.g. the shell itself
 * missing, astronomically unlikely) is reported as `passed: false` with the
 * error text in `output`, same as any other gate failure, so callers only
 * ever need to handle one shape.
 */
export function runGate(command: string, cwd: string, timeoutMs: number = GATE_TIMEOUT_MS): Promise<GateResult> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, cwd });

    let output = "";
    let capped = false;
    let timedOut = false;

    const append = (chunk: Buffer) => {
      if (capped) return;
      output += chunk.toString("utf8");
      // Not byte-exact for multi-byte UTF-8 sitting right at the boundary —
      // fine, this is a safety cap against runaway output, not a billing
      // meter. Once over the cap we just stop growing the buffer; the
      // process itself is left running so its real exit code still comes
      // through.
      if (Buffer.byteLength(output, "utf8") > GATE_OUTPUT_CAP_BYTES) {
        output = output.slice(0, GATE_OUTPUT_CAP_BYTES) + "\n[vibedeck: output truncated at 64KB]";
        capped = true;
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ passed: false, exitCode: null, output: `${output}\n[vibedeck: failed to run gate: ${err.message}]` });
    });

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({
          passed: false,
          exitCode,
          output: `${output}\n[vibedeck: gate killed after exceeding ${timeoutMs}ms timeout]`,
        });
        return;
      }
      resolve({ passed: exitCode === 0, exitCode, output });
    });
  });
}
