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
  it("defaults to 4317 when neither VIBESPACE_PORT nor VIBEDECK_PORT is set", () => {
    expect(resolveServerPort({})).toBe(DEFAULT_PORT);
  });

  it("uses VIBESPACE_PORT when it's a valid port number", () => {
    expect(resolveServerPort({ VIBESPACE_PORT: "45317" })).toBe(45317);
  });

  it.each(["0", "-1", "not-a-number", "70000", "3.5", ""])(
    "falls back to the default for an invalid VIBESPACE_PORT %j",
    (value) => {
      expect(resolveServerPort({ VIBESPACE_PORT: value })).toBe(DEFAULT_PORT);
    }
  );

  it("uses the legacy VIBEDECK_PORT when VIBESPACE_PORT is unset", () => {
    expect(resolveServerPort({ VIBEDECK_PORT: "45318" })).toBe(45318);
  });

  it("falls back to the default for an invalid legacy VIBEDECK_PORT", () => {
    expect(resolveServerPort({ VIBEDECK_PORT: "not-a-number" })).toBe(DEFAULT_PORT);
  });

  it("prefers VIBESPACE_PORT over VIBEDECK_PORT when both are set", () => {
    expect(resolveServerPort({ VIBESPACE_PORT: "45317", VIBEDECK_PORT: "45318" })).toBe(45317);
  });
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

  it("prefers VIBESPACE_STATIC_DIR when set and it exists", () => {
    const result = resolveStaticDir({
      env: { VIBESPACE_STATIC_DIR: "/custom/dist" },
      moduleDir: "/repo/apps/server/dist",
      exists: (path) => path === "/custom/dist",
    });
    expect(result).toBe("/custom/dist");
  });

  it("throws when VIBESPACE_STATIC_DIR is set but doesn't exist, instead of silently serving nothing", () => {
    expect(() =>
      resolveStaticDir({
        env: { VIBESPACE_STATIC_DIR: "/missing/dist" },
        moduleDir: "/repo/apps/server/dist",
        exists: () => false,
      })
    ).toThrow(/VIBESPACE_STATIC_DIR/);
  });

  it("uses the legacy VIBEDECK_STATIC_DIR when VIBESPACE_STATIC_DIR is unset", () => {
    const result = resolveStaticDir({
      env: { VIBEDECK_STATIC_DIR: "/custom/legacy-dist" },
      moduleDir: "/repo/apps/server/dist",
      exists: (path) => path === "/custom/legacy-dist",
    });
    expect(result).toBe("/custom/legacy-dist");
  });

  it("throws naming VIBEDECK_STATIC_DIR (not VIBESPACE_STATIC_DIR) when that's the one that was actually set", () => {
    expect(() =>
      resolveStaticDir({
        env: { VIBEDECK_STATIC_DIR: "/missing/legacy-dist" },
        moduleDir: "/repo/apps/server/dist",
        exists: () => false,
      })
    ).toThrow(/VIBEDECK_STATIC_DIR/);
  });

  it("prefers VIBESPACE_STATIC_DIR over VIBEDECK_STATIC_DIR when both are set", () => {
    const result = resolveStaticDir({
      env: { VIBESPACE_STATIC_DIR: "/custom/dist", VIBEDECK_STATIC_DIR: "/custom/legacy-dist" },
      moduleDir: "/repo/apps/server/dist",
      exists: (path) => path === "/custom/dist" || path === "/custom/legacy-dist",
    });
    expect(result).toBe("/custom/dist");
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
    expect(parseReadyLine("vibespace server listening on http://localhost:4317")).toBeNull();
  });

  it("returns null for a malformed port after a valid prefix", () => {
    expect(parseReadyLine(`${READY_LINE_PREFIX}not-a-port`)).toBeNull();
    expect(parseReadyLine(`${READY_LINE_PREFIX}`)).toBeNull();
    expect(parseReadyLine(`${READY_LINE_PREFIX}-5`)).toBeNull();
  });
});
