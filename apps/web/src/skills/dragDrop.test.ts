import { describe, expect, it } from "vitest";
import type { AgentId, SessionInfo } from "@vibespace/shared";
import {
  SKILL_DRAG_MIME_TYPE,
  canPaneAcceptSkill,
  parseSkillDragPayload,
  serializeSkillDragPayload,
} from "./dragDrop.js";

function session(agent: AgentId, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "s1",
    agent,
    cwd: "/repo",
    title: agent,
    status: "running",
    exitCode: null,
    createdAt: "2026-08-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("SKILL_DRAG_MIME_TYPE", () => {
  it("is a custom type, not text/plain", () => {
    // The whole point (see this module's top comment): a foreign text drag
    // must never be mistaken for a skill, which only works if nothing else
    // on the OS/browser ever populates this exact type by accident.
    expect(SKILL_DRAG_MIME_TYPE).toBe("application/x-vibespace-skill");
    expect(SKILL_DRAG_MIME_TYPE).not.toBe("text/plain");
  });
});

describe("serializeSkillDragPayload / parseSkillDragPayload round-trip", () => {
  it("parses back exactly what was serialised", () => {
    const raw = serializeSkillDragPayload({ name: "vibespace-parity-audit" });
    expect(parseSkillDragPayload(raw)).toEqual({ name: "vibespace-parity-audit" });
  });

  it("ignores extra fields on the input object but still round-trips the name", () => {
    // serializeSkillDragPayload only ever takes `{ name }`, but a caller
    // passing a full SkillCatalogEntry (which has a lot more fields) should
    // still produce a payload that parses back to just the name — nothing
    // else is meant to survive the trip.
    const raw = serializeSkillDragPayload({
      name: "pdf-tools",
      description: "Fill and merge PDF forms.",
    } as { name: string; description: string });
    expect(parseSkillDragPayload(raw)).toEqual({ name: "pdf-tools" });
  });
});

describe("parseSkillDragPayload rejects non-skill input", () => {
  it("rejects null/undefined (no data on this dataTransfer type at all)", () => {
    expect(parseSkillDragPayload(null)).toBeNull();
    expect(parseSkillDragPayload(undefined)).toBeNull();
  });

  it("rejects the empty string getData() returns when a type isn't present", () => {
    expect(parseSkillDragPayload("")).toBeNull();
  });

  it("rejects plain, unrelated text dragged from elsewhere in the OS", () => {
    expect(parseSkillDragPayload("just some text someone dragged in")).toBeNull();
  });

  it("rejects invalid JSON", () => {
    expect(parseSkillDragPayload("{not valid json")).toBeNull();
  });

  it("rejects valid JSON that isn't a plain object shaped like a payload", () => {
    expect(parseSkillDragPayload("42")).toBeNull();
    expect(parseSkillDragPayload('"a string"')).toBeNull();
    expect(parseSkillDragPayload("null")).toBeNull();
    // An array is `typeof "object"` in JS but has no `.name` property, so
    // it falls through the same "name isn't a string" check as any other
    // shapeless object — worth pinning down explicitly since that's an easy
    // case to get wrong with a naive `typeof parsed === "object"` guard.
    expect(parseSkillDragPayload("[1,2,3]")).toBeNull();
  });

  it("rejects an object missing `name`", () => {
    expect(parseSkillDragPayload(JSON.stringify({ description: "no name field" }))).toBeNull();
  });

  it("rejects an object whose `name` isn't a string", () => {
    expect(parseSkillDragPayload(JSON.stringify({ name: 42 }))).toBeNull();
    expect(parseSkillDragPayload(JSON.stringify({ name: null }))).toBeNull();
  });

  it("rejects an empty-string name", () => {
    expect(parseSkillDragPayload(JSON.stringify({ name: "" }))).toBeNull();
  });
});

describe("canPaneAcceptSkill", () => {
  it("accepts a pane with a live, running agent session", () => {
    expect(canPaneAcceptSkill(session("claude"))).toBe(true);
  });

  it("refuses an empty pane (no session at all)", () => {
    expect(canPaneAcceptSkill(null)).toBe(false);
  });

  it("refuses a deferred/not-yet-restored pane — PaneView passes null for `session` in that case too", () => {
    // A deferred pane's session hasn't been resumed yet; PaneView.tsx never
    // populates its `session` prop until a real SessionInfo exists, so from
    // this function's point of view a deferred pane is indistinguishable
    // from an ordinary empty one — both are `null`.
    expect(canPaneAcceptSkill(null)).toBe(false);
  });

  it("refuses a pane whose session has already exited", () => {
    expect(canPaneAcceptSkill(session("claude", { status: "exited", exitCode: 0 }))).toBe(false);
  });

  it("refuses a shell pane even though its session is live — a shell can't act on a skill", () => {
    expect(canPaneAcceptSkill(session("shell"))).toBe(false);
  });

  it("accepts every non-shell agent", () => {
    const agents: AgentId[] = ["claude", "codex", "cursor-agent"];
    for (const agent of agents) {
      expect(canPaneAcceptSkill(session(agent))).toBe(true);
    }
  });
});
