import { describe, expect, it } from "vitest";
import { normalizeAndValidateUrl } from "./url.js";

function expectOk(raw: string, expectedUrl: string) {
  const result = normalizeAndValidateUrl(raw);
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.url).toBe(expectedUrl);
}

function expectRejected(raw: string, messageContains?: string) {
  const result = normalizeAndValidateUrl(raw);
  expect(result.ok).toBe(false);
  if (!result.ok && messageContains) {
    expect(result.error).toContain(messageContains);
  }
}

describe("normalizeAndValidateUrl — normalisation", () => {
  it("turns a bare localhost:port into http://localhost:port", () => {
    expectOk("localhost:3000", "http://localhost:3000");
  });

  it("turns a bare hostname into https://hostname", () => {
    expectOk("example.com", "https://example.com");
  });

  it("defaults 127.0.0.1:port to http", () => {
    expectOk("127.0.0.1:8080", "http://127.0.0.1:8080");
  });

  it("defaults a bracketed IPv6 loopback:port to http", () => {
    expectOk("[::1]:9000", "http://[::1]:9000");
  });

  it("defaults bare localhost (no port) to http", () => {
    expectOk("localhost", "http://localhost");
  });

  it("keeps a path after a bare host:port", () => {
    expectOk("localhost:3000/app", "http://localhost:3000/app");
  });

  it("keeps a path after a bare hostname", () => {
    expectOk("example.com/docs/getting-started", "https://example.com/docs/getting-started");
  });

  it("trims surrounding whitespace before normalising", () => {
    expectOk("  example.com  ", "https://example.com");
  });

  it("defaults a non-local bare host to https, not http", () => {
    const result = normalizeAndValidateUrl("my-dev-box.internal:4000");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url.startsWith("https://")).toBe(true);
  });
});

describe("normalizeAndValidateUrl — already-valid URLs pass through unchanged", () => {
  it("leaves a plain http:// URL untouched", () => {
    expectOk("http://localhost:3000", "http://localhost:3000");
  });

  it("leaves a plain https:// URL untouched", () => {
    expectOk("https://example.com", "https://example.com");
  });

  it("leaves a full URL with path/query/fragment untouched", () => {
    const url = "https://example.com/path?query=1&other=2#section";
    expectOk(url, url);
  });

  it("does not append a trailing slash to a bare origin", () => {
    // Guards against `new URL(x).href` sneaking back in — that adds a "/"
    // (e.g. "https://example.com" -> "https://example.com/"), which this
    // function's contract explicitly does not do (see confirmParses' own
    // comment on why the ORIGINAL string is returned, not `.href`).
    expectOk("https://example.com", "https://example.com");
  });

  it("preserves whatever scheme casing the person typed", () => {
    expectOk("HTTP://example.com", "HTTP://example.com");
  });
});

describe("normalizeAndValidateUrl — rejected schemes", () => {
  it("rejects javascript: URLs", () => {
    expectRejected("javascript:alert(1)", "javascript:");
  });

  it("rejects data: URLs", () => {
    expectRejected("data:text/html,<script>alert(1)</script>", "data:");
  });

  it("rejects file: URLs", () => {
    expectRejected("file:///etc/passwd", "file:");
  });

  it("rejects blob: URLs", () => {
    expectRejected("blob:https://example.com/9a1c2b3d", "blob:");
  });

  it("rejects about: URLs", () => {
    expectRejected("about:blank", "about:");
  });

  it("rejects mailto: URLs", () => {
    expectRejected("mailto:someone@example.com", "mailto:");
  });

  it("rejects ftp: URLs", () => {
    expectRejected("ftp://files.example.com", "ftp:");
  });

  it("rejects vbscript: URLs", () => {
    expectRejected("vbscript:msgbox(1)", "vbscript:");
  });

  it("rejects ws:// URLs", () => {
    expectRejected("ws://example.com/socket", "ws:");
  });

  it("names the rejected scheme in the error message", () => {
    const result = normalizeAndValidateUrl("file:///etc/passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/only http:\/\/ and https:\/\//i);
  });
});

describe("normalizeAndValidateUrl — garbage input", () => {
  it("rejects an empty string", () => {
    expectRejected("", "Enter a URL");
  });

  it("rejects a whitespace-only string", () => {
    expectRejected("   ");
  });

  it("rejects a string containing spaces that isn't a valid host", () => {
    expectRejected("not a url at all !!!");
  });

  it("rejects an explicit-scheme URL that fails to parse", () => {
    expectRejected("http://");
  });
});
