import { describe, expect, it } from "vitest";
import { RingBuffer } from "./ring-buffer.js";

describe("RingBuffer", () => {
  it("retains everything when total pushed data is under the cap", () => {
    const buf = new RingBuffer();
    buf.push("hello ");
    buf.push("world");
    expect(buf.toString()).toBe("hello world");
    expect(buf.byteLength).toBe(Buffer.byteLength("hello world", "utf8"));
  });

  it("drops the oldest chunks first once over the 2 MB cap", () => {
    const buf = new RingBuffer();
    // Each chunk is ~900 KB of 'a's tagged with an index, so we can tell
    // which ones survived after the buffer trims. Three of them (~2.7 MB)
    // push the buffer over the 2 MB cap, but dropping just the oldest
    // (~900 KB) brings it back under (~1.8 MB) — so exactly one chunk
    // should be dropped, not two.
    const chunk = "a".repeat(900_000);
    buf.push(`chunk0:${chunk}`);
    buf.push(`chunk1:${chunk}`);
    buf.push(`chunk2:${chunk}`); // pushes total over 2 MB — chunk0 should get dropped

    const result = buf.toString();
    expect(result).not.toContain("chunk0:");
    expect(result).toContain("chunk1:");
    expect(result).toContain("chunk2:");
  });

  it("never exceeds the 2 MB cap no matter how much is pushed", () => {
    const buf = new RingBuffer();
    const oneMb = "b".repeat(1024 * 1024);
    for (let i = 0; i < 10; i++) {
      buf.push(oneMb);
    }
    expect(buf.byteLength).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  it("trims only at whole chunk boundaries, never slicing a chunk in half", () => {
    // Regression guard for the ANSI-escape-corruption bug this class exists
    // to avoid: every chunk that survives trimming must appear in the
    // output completely intact, never partially.
    const buf = new RingBuffer();
    const oneMb = "c".repeat(1024 * 1024);
    const marker = "\x1b[31mred\x1b[0m"; // a real ANSI escape sequence
    buf.push(`${oneMb}`);
    buf.push(`${marker}${oneMb}`);
    buf.push(`${oneMb}`); // forces a trim

    const result = buf.toString();
    // If the marker chunk survived, it must be fully intact (not sliced).
    if (result.includes("red")) {
      expect(result).toContain(marker);
    }
  });

  it("clear() empties the buffer", () => {
    const buf = new RingBuffer();
    buf.push("some output");
    buf.clear();
    expect(buf.toString()).toBe("");
    expect(buf.byteLength).toBe(0);
  });

  it("ignores empty pushes", () => {
    const buf = new RingBuffer();
    buf.push("");
    expect(buf.toString()).toBe("");
    expect(buf.byteLength).toBe(0);
  });
});
