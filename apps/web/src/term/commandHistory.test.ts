import { describe, expect, it } from "vitest";
import { matchCommandHistory } from "./commandHistory.js";

describe("matchCommandHistory", () => {
  it("returns entries that start with the input, preserving history order", () => {
    const history = ["git status", "git log", "ls -la", "git commit"];
    expect(matchCommandHistory(history, "git")).toEqual(["git status", "git log", "git commit"]);
  });

  it("is case-insensitive", () => {
    const history = ["Git Status", "npm install"];
    expect(matchCommandHistory(history, "git")).toEqual(["Git Status"]);
  });

  it("returns an empty array for blank input", () => {
    expect(matchCommandHistory(["git status"], "")).toEqual([]);
    expect(matchCommandHistory(["git status"], "   ")).toEqual([]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(matchCommandHistory(["git status", "ls"], "docker")).toEqual([]);
  });

  it("excludes an entry that exactly equals the (trimmed) input", () => {
    const history = ["git status", "git status --short"];
    expect(matchCommandHistory(history, "git status")).toEqual(["git status --short"]);
  });

  it("trims surrounding whitespace off the input before matching", () => {
    const history = ["git status"];
    expect(matchCommandHistory(history, "  git  ")).toEqual(["git status"]);
    expect(matchCommandHistory(history, "  git")).toEqual(["git status"]);
  });

  it("respects the limit parameter, keeping the first (newest-first) matches", () => {
    const history = ["git 1", "git 2", "git 3", "git 4"];
    expect(matchCommandHistory(history, "git", 2)).toEqual(["git 1", "git 2"]);
  });

  it("does not match a substring that isn't a prefix", () => {
    const history = ["npm run git-hooks"];
    expect(matchCommandHistory(history, "git")).toEqual([]);
  });

  it("respects the default MAX_SUGGESTIONS cap when no explicit limit is given", () => {
    const history = Array.from({ length: 20 }, (_, i) => `cmd-${i}`);
    expect(matchCommandHistory(history, "cmd")).toHaveLength(8);
  });
});
