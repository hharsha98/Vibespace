/**
 * The WebSocket message protocol shared between the vibedeck server and web
 * client. Both sides import these types so their messages can never drift
 * apart — if one side changes the shape of a message, TypeScript will fail
 * to compile the other side until it's updated too.
 */

/** The set of coding agents vibedeck knows how to run in a terminal session. */
export type AgentId = "claude" | "cursor-agent" | "codex" | "shell";

/**
 * Runtime array of every `AgentId`, kept in sync with the type above by
 * hand. Useful anywhere we need to iterate over or validate agent ids at
 * runtime (types alone don't exist after compilation).
 */
export const AGENT_IDS: readonly AgentId[] = ["claude", "cursor-agent", "codex", "shell"];

/** A message sent from the browser client to the server. */
export type ClientMessage =
  | { type: "input"; sessionId: string; data: string }
  | { type: "resize"; sessionId: string; cols: number; rows: number };

/** A message sent from the server to the browser client. */
export type ServerMessage =
  | { type: "output"; sessionId: string; data: string }
  | { type: "exit"; sessionId: string; code: number }
  | { type: "ready"; sessionId: string };
