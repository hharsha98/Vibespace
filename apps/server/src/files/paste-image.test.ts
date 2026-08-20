import { describe, expect, it } from "vitest";
import { PASTE_IMAGE_DIR_NAME, pickPasteImagePath } from "./paste-image.js";

describe("pickPasteImagePath", () => {
  it("maps image/png to a .png path under the pastes dir", () => {
    const result = pickPasteImagePath("image/png", 1_700_000_000_000, "ab12cd34");
    expect(result).toEqual({
      ok: true,
      relPath: `${PASTE_IMAGE_DIR_NAME}/paste-1700000000000-ab12cd34.png`,
    });
  });

  it("maps image/jpeg to .jpg (not .jpeg)", () => {
    const result = pickPasteImagePath("image/jpeg", 1, "x");
    expect(result).toEqual({ ok: true, relPath: `${PASTE_IMAGE_DIR_NAME}/paste-1-x.jpg` });
  });

  it("maps image/gif to .gif", () => {
    const result = pickPasteImagePath("image/gif", 1, "x");
    expect(result).toEqual({ ok: true, relPath: `${PASTE_IMAGE_DIR_NAME}/paste-1-x.gif` });
  });

  it("maps image/webp to .webp", () => {
    const result = pickPasteImagePath("image/webp", 1, "x");
    expect(result).toEqual({ ok: true, relPath: `${PASTE_IMAGE_DIR_NAME}/paste-1-x.webp` });
  });

  it("refuses an unrecognized MIME type rather than guessing an extension", () => {
    const result = pickPasteImagePath("image/svg+xml", 1, "x");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("image/svg+xml");
    }
  });

  it("refuses a non-image MIME type outright", () => {
    const result = pickPasteImagePath("application/pdf", 1, "x");
    expect(result.ok).toBe(false);
  });

  it("refuses an empty MIME type", () => {
    const result = pickPasteImagePath("", 1, "x");
    expect(result.ok).toBe(false);
  });

  it("every generated path lands inside PASTE_IMAGE_DIR_NAME", () => {
    const result = pickPasteImagePath("image/png", 42, "id");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.relPath.startsWith(`${PASTE_IMAGE_DIR_NAME}/`)).toBe(true);
    }
  });
});
