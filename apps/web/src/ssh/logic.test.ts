import { describe, expect, it } from "vitest";
import {
  describeSshWorkspace,
  formatSshDestination,
  isValidSshProfileHost,
  isValidSshProfileName,
  parseSshPortInput,
  sortSshProfilesByName,
} from "./logic.js";

describe("formatSshDestination", () => {
  it("renders just the host when no user or port is set", () => {
    expect(formatSshDestination({ host: "example.com", user: null, port: null })).toBe("example.com");
  });

  it("prefixes user@ when a user is set", () => {
    expect(formatSshDestination({ host: "example.com", user: "deploy", port: null })).toBe(
      "deploy@example.com"
    );
  });

  it("appends :port when a port is set", () => {
    expect(formatSshDestination({ host: "example.com", user: null, port: 2222 })).toBe(
      "example.com:2222"
    );
  });

  it("renders user@host:port when all three are set", () => {
    expect(formatSshDestination({ host: "example.com", user: "deploy", port: 2222 })).toBe(
      "deploy@example.com:2222"
    );
  });
});

describe("describeSshWorkspace", () => {
  it("returns null when neither directory nor startup command is set", () => {
    expect(describeSshWorkspace({ defaultDirectory: null, startupCommand: null })).toBeNull();
    expect(describeSshWorkspace({ defaultDirectory: "  ", startupCommand: "" })).toBeNull();
  });

  it("describes just the directory when only that is set", () => {
    expect(describeSshWorkspace({ defaultDirectory: "/srv/app", startupCommand: null })).toBe(
      "cd's to /srv/app"
    );
  });

  it("describes just the startup command when only that is set", () => {
    expect(describeSshWorkspace({ defaultDirectory: null, startupCommand: "npm run dev" })).toBe(
      "runs a startup command on connect"
    );
  });

  it("describes both when both are set", () => {
    expect(
      describeSshWorkspace({ defaultDirectory: "/srv/app", startupCommand: "npm run dev" })
    ).toBe("cd's to /srv/app, then runs a startup command");
  });
});

describe("sortSshProfilesByName", () => {
  it("sorts case-insensitively without mutating the input array", () => {
    const input = [{ name: "zeta" }, { name: "Alpha" }, { name: "mid" }];
    const sorted = sortSshProfilesByName(input);
    expect(sorted.map((p) => p.name)).toEqual(["Alpha", "mid", "zeta"]);
    // Original array order is untouched.
    expect(input.map((p) => p.name)).toEqual(["zeta", "Alpha", "mid"]);
  });
});

describe("isValidSshProfileName / isValidSshProfileHost", () => {
  it("rejects empty and whitespace-only strings", () => {
    expect(isValidSshProfileName("")).toBe(false);
    expect(isValidSshProfileName("   ")).toBe(false);
    expect(isValidSshProfileHost("")).toBe(false);
    expect(isValidSshProfileHost("   ")).toBe(false);
  });

  it("accepts a non-empty string", () => {
    expect(isValidSshProfileName("prod-server")).toBe(true);
    expect(isValidSshProfileHost("example.com")).toBe(true);
  });
});

describe("parseSshPortInput", () => {
  it("returns null for an empty field (use ssh's own default)", () => {
    expect(parseSshPortInput("")).toBeNull();
    expect(parseSshPortInput("   ")).toBeNull();
  });

  it("parses a valid port", () => {
    expect(parseSshPortInput("2222")).toBe(2222);
    expect(parseSshPortInput("1")).toBe(1);
    expect(parseSshPortInput("65535")).toBe(65535);
  });

  it("returns undefined for an out-of-range port", () => {
    expect(parseSshPortInput("0")).toBeUndefined();
    expect(parseSshPortInput("65536")).toBeUndefined();
    expect(parseSshPortInput("999999")).toBeUndefined();
  });

  it("returns undefined for non-numeric input", () => {
    expect(parseSshPortInput("abc")).toBeUndefined();
    expect(parseSshPortInput("22.5")).toBeUndefined();
    expect(parseSshPortInput("-1")).toBeUndefined();
    expect(parseSshPortInput("22; rm -rf /")).toBeUndefined();
  });
});
