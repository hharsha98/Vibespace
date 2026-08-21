import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SETTINGS_SECTIONS } from "./sections.js";

// This repo's web package has no jsdom/testing-library dependency (see
// Settings.tsx's own top comment), so a couple of requirements that would
// normally be DOM-rendering assertions ("every rail section renders its own
// content," "the API Keys section never writes to localStorage") are
// checked here directly against Settings.tsx's own source text instead.
// This is a narrower guarantee than an actual render+inspect would give —
// it can't catch a bug in HOW something renders, only whether the source
// still contains the exact patterns it should/shouldn't — but it is a real,
// specific regression test for the two things that matter most here: that
// nothing was silently dropped from the rail's switch, and that the API
// Keys section stays free of any input/localStorage-writing code.
const SETTINGS_TSX_PATH = fileURLToPath(new URL("./Settings.tsx", import.meta.url));
const source = readFileSync(SETTINGS_TSX_PATH, "utf8");

describe("Settings.tsx wires every rail section to real content", () => {
  for (const section of SETTINGS_SECTIONS) {
    it(`renders a branch for "${section.id}"`, () => {
      expect(source).toContain(`activeSection === "${section.id}"`);
    });
  }
});

describe("Settings.tsx's API Keys section never collects or stores a secret", () => {
  function apiKeysSectionBody(): string {
    const start = source.indexOf("function ApiKeysSection()");
    expect(start, "ApiKeysSection function should exist").toBeGreaterThan(-1);
    const nextFunction = source.indexOf("\nfunction ", start + 1);
    expect(nextFunction, "there should be a following top-level function to bound the scan").toBeGreaterThan(start);
    return source.slice(start, nextFunction);
  }

  it("renders no text input at all", () => {
    const body = apiKeysSectionBody();
    expect(body).not.toMatch(/<input\b/);
  });

  it("never calls localStorage.setItem", () => {
    const body = apiKeysSectionBody();
    expect(body).not.toMatch(/localStorage\.setItem/);
  });

  it("explains the env-var / pass-through approach instead of a key field", () => {
    const body = apiKeysSectionBody();
    expect(body.toLowerCase()).toContain("environment variable");
  });
});
