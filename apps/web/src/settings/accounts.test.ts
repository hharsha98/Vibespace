import { describe, expect, it } from "vitest";
import { AGENT_IDS } from "@vibespace/shared";
import { GENERIC_LOGIN_NOTE, loginNoteFor } from "./accounts.js";

describe("loginNoteFor", () => {
  it("gives every real agent a non-empty note", () => {
    for (const id of AGENT_IDS) {
      if (id === "shell") continue; // no login of its own — Settings.tsx filters this out of Accounts
      expect(loginNoteFor(id).length).toBeGreaterThan(0);
    }
  });

  it("gives claude — the one agent whose auth flow this file claims to know — its specific note, not the generic fallback", () => {
    expect(loginNoteFor("claude")).not.toBe(GENERIC_LOGIN_NOTE);
    expect(loginNoteFor("claude")).toContain("claude");
  });

  it("falls back to the honest generic note, not a guessed command, for agents this file doesn't claim to verify", () => {
    // Every one of these should say "manages its own sign-in" rather than
    // naming a specific, unverified `<cli> login` command — the exact rule
    // this feature's own instruction sets ("do NOT invent login commands
    // you have not verified").
    for (const id of AGENT_IDS) {
      if (id === "shell" || id === "claude") continue;
      expect(loginNoteFor(id)).toBe(GENERIC_LOGIN_NOTE);
    }
  });
});
