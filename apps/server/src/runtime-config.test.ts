import { describe, expect, it } from "vitest";
import {
  DEFAULT_PORT,
  READY_LINE_PREFIX,
  formatReadyLine,
  parseReadyLine,
  resolveServerPort,
  resolveStaticDir,
} from "./runtime-config.js";

describe("resolveServerPort", () => {
  it("defaults to 4317 when VIBEDECK_PORT is unset", () => {
    expect(resolveServerPort({})).toBe(DEFAULT_PORT);
  });

  it("uses VIBEDECK_PORT when it's a valid port number", () => {
    expect(resolveServerPort({ VIBEDECK_PORT: "45317" })).toBe(45317);
  });

  it.each(["0", "-1", "not-a-number", "70000", "3.5", ""])(
    "falls back to the default for an invalid VIBEDECK_PORT %j",
    (value) => {
      expect(resolveServerPort({ VIBEDECK_PORT: value })).toBe(DEFAULT_PORT);
    }
  );
});

describe("resolveStaticDir", () => {
  it("returns null when no override is set and the auto-detected dir doesn't exist", () => {
    const result = resolveStaticDir({
      env: {},
      moduleDir: "/repo/apps/server/dist",
      exists: () => false,
    });
    expect(result).toBeNull();
  });

  it("auto-detects apps/web/dist relative to moduleDir when it exists", () => {
    const seen: string[] = [];
    const result = resolveStaticDir({
      env: {},
      moduleDir: "/repo/apps/server/dist",
      exists: (path) => {
        seen.push(path);
        return path === "/repo/apps/web/dist";
      },
    });
    expect(result).toBe("/repo/apps/web/dist");
    expect(seen).toEqual(["/repo/apps/web/dist"]);
  });

  it("prefers VIBEDECK_STATIC_DIR when set and it exists", () => {
    const result = resolveStaticDir({
      env: { VIBEDECK_STATIC_DIR: "/custom/dist" },
      moduleDir: "/repo/apps/server/dist",
      exists: (path) => path === "/custom/dist",
    });
    expect(result).toBe("/custom/dist");
  });

  it("throws when VIBEDECK_STATIC_DIR is set but doesn't exist, instead of silently serving nothing", () => {
    expect(() =>
      resolveStaticDir({
        env: { VIBEDECK_STATIC_DIR: "/missing/dist" },
        moduleDir: "/repo/apps/server/dist",
        exists: () => false,
      })
    ).toThrow(/VIBEDECK_STATIC_DIR/);
  });

  it("resolves the same apps/web/dist whether moduleDir is src/ (dev) or dist/ (built)", () => {
    const exists = (path: string) => path === "/repo/apps/web/dist";
    const fromSrc = resolveStaticDir({ env: {}, moduleDir: "/repo/apps/server/src", exists });
    const fromDist = resolveStaticDir({ env: {}, moduleDir: "/repo/apps/server/dist", exists });
    expect(fromSrc).toBe("/repo/apps/web/dist");
    expect(fromDist).toBe("/repo/apps/web/dist");
  });
});

describe("formatReadyLine / parseReadyLine", () => {
  it("round-trips a port through the formatted line", () => {
    const line = formatReadyLine(45317);
    expect(line).toBe(`${READY_LINE_PREFIX}45317`);
    expect(parseReadyLine(line)).toBe(45317);
  });

  it("returns null for a line without the expected prefix", () => {
    expect(parseReadyLine("vibedeck server listening on http://localhost:4317")).toBeNull();
  });

  it("returns null for a malformed port after a valid prefix", () => {
    expect(parseReadyLine(`${READY_LINE_PREFIX}not-a-port`)).toBeNull();
    expect(parseReadyLine(`${READY_LINE_PREFIX}`)).toBeNull();
    expect(parseReadyLine(`${READY_LINE_PREFIX}-5`)).toBeNull();
  });
});
