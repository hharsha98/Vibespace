/**
 * SessionManager owns every pty (pseudo-terminal) process the server has
 * spawned. A "session" bundles together:
 *   - the actual pty process (from node-pty)
 *   - a RingBuffer of its output, so a client that attaches later can see
 *     what it missed ("scrollback replay")
 *   - a set of currently-attached listener callbacks, so multiple browser
 *     tabs/windows can watch the same session's output live
 *   - a SessionInfo record (the REST-facing metadata)
 *
 * The key design point: killing the browser tab (closing the WebSocket)
 * does NOT kill the pty. Sessions are server-owned and outlive any single
 * client connection — that's what lets you close your laptop lid, come
 * back, and reattach to a still-running `claude` session.
 */
import { randomUUID } from "node:crypto";
import * as pty from "node-pty";
import type { AgentId, SessionInfo } from "@vibedeck/shared";
import { RingBuffer } from "./ring-buffer.js";
import { resolveAgent } from "./agents.js";

export interface CreateSessionOptions {
  agent: AgentId;
  cwd?: string;
  cols?: number;
  rows?: number;
}

/** A message broadcast to attached listeners: raw output, or the exit event. */
export type SessionEvent =
  | { type: "output"; data: string }
  | { type: "exit"; code: number };

type Listener = (event: SessionEvent) => void;

interface Session {
  pty: pty.IPty;
  buffer: RingBuffer;
  listeners: Set<Listener>;
  info: SessionInfo;
  /** Current pty size, tracked so a reattaching client's "ready" message can report it. */
  size: { cols: number; rows: number };
}

export class SessionManager {
  private sessions = new Map<string, Session>();

  /** Spawn a new pty for the given agent and start tracking it. */
  create(options: CreateSessionOptions): SessionInfo {
    const { agent } = options;
    const cwd = options.cwd ?? process.cwd();
    const cols = options.cols ?? 80;
    const rows = options.rows ?? 24;

    const { command, args } = resolveAgent(agent);

    const id = randomUUID();
    const ptyProcess = pty.spawn(command, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      // Spread the server's own environment so the spawned process has a
      // normal PATH etc, then layer on terminal-capability hints so
      // full-color / interactive CLIs (like the AI agents) render well.
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
    });

    const info: SessionInfo = {
      id,
      agent,
      cwd,
      title: agent,
      status: "running",
      exitCode: null,
      createdAt: new Date().toISOString(),
    };

    const session: Session = {
      pty: ptyProcess,
      buffer: new RingBuffer(),
      listeners: new Set(),
      info,
      size: { cols, rows },
    };
    this.sessions.set(id, session);

    // Every chunk of pty output gets appended to the replay buffer AND
    // broadcast live to whoever's currently attached (could be zero, one,
    // or several listeners).
    ptyProcess.onData((data) => {
      session.buffer.push(data);
      for (const listener of session.listeners) {
        listener({ type: "output", data });
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      session.info.status = "exited";
      session.info.exitCode = exitCode;
      for (const listener of session.listeners) {
        listener({ type: "exit", code: exitCode });
      }
      // Deliberately NOT removing the session from `this.sessions` here —
      // a client that hasn't attached yet (or reattaches later) still
      // needs to be able to read the final scrollback and see that it
      // exited.
    });

    return info;
  }

  private mustGet(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`No session with id "${id}"`);
    }
    return session;
  }

  /** Register a listener for a session's live output/exit events. Returns an unsubscribe function. */
  attach(id: string, listener: Listener): () => void {
    const session = this.mustGet(id);
    session.listeners.add(listener);
    return () => {
      session.listeners.delete(listener);
    };
  }

  /** The full replayed scrollback for a session. */
  getHistory(id: string): string {
    return this.mustGet(id).buffer.toString();
  }

  /** Write input (keystrokes, pasted text, etc) into a session's pty. */
  write(id: string, data: string): void {
    this.mustGet(id).pty.write(data);
  }

  /** Resize a session's pty (e.g. when the browser window changes size). */
  resize(id: string, cols: number, rows: number): void {
    const session = this.mustGet(id);
    session.pty.resize(cols, rows);
    session.size = { cols, rows };
  }

  /** The pty's current size — what a reattaching client should size its terminal to. */
  getSize(id: string): { cols: number; rows: number } {
    return this.mustGet(id).size;
  }

  /** All sessions' REST-facing info, e.g. for a session list. */
  list(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => s.info);
  }

  /** A single session's REST-facing info, or undefined if unknown. */
  get(id: string): SessionInfo | undefined {
    return this.sessions.get(id)?.info;
  }

  /**
   * Kill a session's pty AND forget it (used by DELETE /api/sessions/:id).
   *
   * Note the deliberate asymmetry with the `onExit` handler above, which
   * keeps exited sessions around. The two cases mean different things:
   *
   *   - the process exited on its own    -> keep it, so you can still read
   *     the final scrollback and see why it stopped
   *   - you explicitly asked to delete it -> remove it, because a "delete"
   *     that leaves the thing in the list is just a lie
   *
   * Forgetting it also releases the session's ring buffer (up to 2MB each),
   * which would otherwise accumulate for the whole life of the server.
   */
  kill(id: string): void {
    const session = this.mustGet(id);
    session.pty.kill();
    session.listeners.clear();
    this.sessions.delete(id);
  }

  /** Kill every session's pty. Call this on server shutdown so tests/processes don't leak. */
  disposeAll(): void {
    for (const session of this.sessions.values()) {
      try {
        session.pty.kill();
      } catch {
        // Already dead — fine, we're tearing everything down anyway.
      }
    }
    this.sessions.clear();
  }
}
