/**
 * A bounded buffer of terminal output, used to replay "scrollback" to a
 * client that (re)attaches to a session that's already been running for a
 * while.
 *
 * Why not just keep one giant string? A long-running agent session (think:
 * `claude` chugging away for hours) can produce a lot of output. Without a
 * cap, memory use would grow forever. So instead we keep the *most recent*
 * MAX_BYTES worth of output and drop the oldest bytes once we're over that.
 */

/** Cap retained scrollback at 2 MB (measured in UTF-8 bytes). */
const MAX_BYTES = 2 * 1024 * 1024;

export class RingBuffer {
  /**
   * Output is stored as a list of chunks (each chunk is exactly one
   * `push()` call's worth of data) rather than one concatenated string.
   * This matters for trimming: a pty can flush output mid-ANSI-escape-
   * sequence, but node-pty always hands us *complete* chunks as it
   * received them from the OS. If we ever sliced a chunk in half to save
   * space, we could cut an escape sequence (e.g. a color code) right down
   * the middle, and the truncated fragment would corrupt whatever the
   * terminal renders next. So we only ever drop or keep *whole* chunks —
   * never slice inside one.
   */
  private chunks: string[] = [];
  private totalBytes = 0;

  /** Append a chunk of output, trimming from the front if we're over cap. */
  push(chunk: string): void {
    if (chunk.length === 0) return;

    this.chunks.push(chunk);
    this.totalBytes += Buffer.byteLength(chunk, "utf8");

    // Drop whole chunks off the front until we're back under the cap.
    // See the class comment above for why we never slice mid-chunk.
    while (this.totalBytes > MAX_BYTES && this.chunks.length > 0) {
      const dropped = this.chunks.shift();
      if (dropped !== undefined) {
        this.totalBytes -= Buffer.byteLength(dropped, "utf8");
      }
    }
  }

  /** The full retained scrollback, oldest first. */
  toString(): string {
    return this.chunks.join("");
  }

  /** Current retained size in bytes (never exceeds MAX_BYTES once >0 chunks pushed). */
  get byteLength(): number {
    return this.totalBytes;
  }

  /** Drop everything. */
  clear(): void {
    this.chunks = [];
    this.totalBytes = 0;
  }
}
