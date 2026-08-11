import { describe, expect, it } from "vitest";
import type { BoardCard } from "@vibedeck/shared";
import { buildDispatchPrompt } from "./dispatch.js";

/**
 * These tests exist because of a real bug found by hand-testing Phase 7:
 * the dispatch prompt was built the same way for every agent, so typing it
 * into a plain `shell` pane pasted English instructions ("...move it to In
 * Review...") straight into zsh, which tried to execute them. The prompt
 * also contained literal newlines — and since writing to a pty is the same
 * as the user typing, each newline is a "submit" in a TUI like Claude Code,
 * which would have split one prompt into several half-prompts.
 */

const card: BoardCard = {
  id: "card-123",
  workspaceId: "ws-1",
  title: "echo hello",
  description: null,
  priority: "medium",
  columnId: "in_progress",
  position: 1,
  sessionId: null,
  agent: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const PORT = 4317;

describe("buildDispatchPrompt", () => {
  it("gives a shell the card body verbatim, with no agent instructions", () => {
    const prompt = buildDispatchPrompt(card, PORT, "shell");

    expect(prompt).toBe("echo hello\n");
    // A shell would try to *run* any of these as a command.
    expect(prompt).not.toContain("[vibedeck]");
    expect(prompt).not.toContain("In Review");
    expect(prompt).not.toContain("curl");
  });

  it("gives an AI agent the card id and the move-to-In-Review call", () => {
    const prompt = buildDispatchPrompt(card, PORT, "claude");

    expect(prompt).toContain("card-123");
    expect(prompt).toContain("in_review");
    expect(prompt).toContain(`http://localhost:${PORT}/api/board/cards/card-123`);
    expect(prompt).toContain("echo hello");
  });

  it("emits exactly one newline, at the very end, for every agent", () => {
    // One trailing newline is the deliberate "submit". Any newline before
    // it would submit an incomplete prompt.
    for (const agent of ["shell", "claude", "cursor-agent", "codex"] as const) {
      const prompt = buildDispatchPrompt(card, PORT, agent);
      expect(prompt.endsWith("\n"), `${agent} should end with a newline`).toBe(true);
      expect(prompt.slice(0, -1).includes("\n"), `${agent} should have no internal newline`).toBe(
        false
      );
    }
  });

  it("folds a multi-line description onto one line rather than submitting early", () => {
    const multiline: BoardCard = {
      ...card,
      title: "Fix the parser",
      description: "line one\nline two\n\nline three",
    };

    const prompt = buildDispatchPrompt(multiline, PORT, "claude");

    expect(prompt.slice(0, -1)).not.toContain("\n");
    expect(prompt).toContain("line one line two line three");
  });

  it("includes the description alongside the title when there is one", () => {
    const withDescription: BoardCard = { ...card, description: "and then stop" };

    expect(buildDispatchPrompt(withDescription, PORT, "shell")).toContain("and then stop");
  });
});
