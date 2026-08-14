import { describe, expect, it } from "vitest";
import {
  INITIAL_DOWNLOAD_PROGRESS,
  formatDownloadProgress,
  reduceDownloadProgress,
  shouldShowUpdateBanner,
  type DownloadEventLike,
} from "./updater.js";

describe("shouldShowUpdateBanner", () => {
  it("is false when no update is available", () => {
    expect(shouldShowUpdateBanner(null, null)).toBe(false);
    expect(shouldShowUpdateBanner(null, "1.0.0")).toBe(false);
  });

  it("is true for a newly-available version nothing has been dismissed yet", () => {
    expect(shouldShowUpdateBanner("1.2.0", null)).toBe(true);
  });

  it("is false once that exact version has been dismissed", () => {
    expect(shouldShowUpdateBanner("1.2.0", "1.2.0")).toBe(false);
  });

  it("is true again for a NEWER version even if an older one was dismissed", () => {
    // Dismissing v1.2.0 shouldn't silence v1.3.0 showing up later — each
    // version gets to ask once, per updater.ts's own doc comment.
    expect(shouldShowUpdateBanner("1.3.0", "1.2.0")).toBe(true);
  });
});

describe("reduceDownloadProgress", () => {
  it("resets downloadedBytes and records the total on Started", () => {
    const state = reduceDownloadProgress(
      { downloadedBytes: 999, totalBytes: 111 },
      { event: "Started", data: { contentLength: 5000 } }
    );
    expect(state).toEqual({ downloadedBytes: 0, totalBytes: 5000 });
  });

  it("handles a Started event with no contentLength (total stays null)", () => {
    const state = reduceDownloadProgress(INITIAL_DOWNLOAD_PROGRESS, {
      event: "Started",
      data: {},
    });
    expect(state).toEqual({ downloadedBytes: 0, totalBytes: null });
  });

  it("accumulates chunk sizes across Progress events", () => {
    let state = reduceDownloadProgress(INITIAL_DOWNLOAD_PROGRESS, {
      event: "Started",
      data: { contentLength: 1000 },
    });
    state = reduceDownloadProgress(state, { event: "Progress", data: { chunkLength: 300 } });
    state = reduceDownloadProgress(state, { event: "Progress", data: { chunkLength: 300 } });
    expect(state).toEqual({ downloadedBytes: 600, totalBytes: 1000 });
  });

  it("snaps downloadedBytes to totalBytes on Finished", () => {
    // Chunks landed at 950/1000 — Finished should still read as complete.
    const state = reduceDownloadProgress(
      { downloadedBytes: 950, totalBytes: 1000 },
      { event: "Finished" }
    );
    expect(state).toEqual({ downloadedBytes: 1000, totalBytes: 1000 });
  });

  it("leaves state alone on Finished when totalBytes was never known", () => {
    const state = reduceDownloadProgress(
      { downloadedBytes: 950, totalBytes: null },
      { event: "Finished" }
    );
    expect(state).toEqual({ downloadedBytes: 950, totalBytes: null });
  });

  it("is a no-op for an unrecognised event shape", () => {
    const weird = { event: "SomethingElse" } as unknown as DownloadEventLike;
    const state = reduceDownloadProgress(INITIAL_DOWNLOAD_PROGRESS, weird);
    expect(state).toBe(INITIAL_DOWNLOAD_PROGRESS);
  });
});

describe("formatDownloadProgress", () => {
  it("shows a percentage when totalBytes is known", () => {
    expect(formatDownloadProgress({ downloadedBytes: 500, totalBytes: 1000 })).toBe("50%");
  });

  it("rounds and clamps at 100%", () => {
    expect(formatDownloadProgress({ downloadedBytes: 999, totalBytes: 1000 })).toBe("100%");
    // Chunks that summed past the reported total (compression, chunked
    // transfer skew) must never show over 100%.
    expect(formatDownloadProgress({ downloadedBytes: 1200, totalBytes: 1000 })).toBe("100%");
  });

  it("falls back to a byte count when totalBytes is unknown", () => {
    expect(formatDownloadProgress({ downloadedBytes: 512, totalBytes: null })).toBe("512 B downloaded");
  });

  it("falls back to a byte count when totalBytes is zero", () => {
    expect(formatDownloadProgress({ downloadedBytes: 2048, totalBytes: 0 })).toBe("2.0 KB downloaded");
  });

  it("formats kilobytes and megabytes", () => {
    expect(formatDownloadProgress({ downloadedBytes: 1536, totalBytes: null })).toBe("1.5 KB downloaded");
    expect(formatDownloadProgress({ downloadedBytes: 3 * 1024 * 1024, totalBytes: null })).toBe(
      "3.0 MB downloaded"
    );
  });
});
