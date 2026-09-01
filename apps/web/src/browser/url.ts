/**
 * Turns whatever a person typed into a browser pane's URL bar into a safe
 * `<iframe src>` — or refuses it with a message clear enough to act on.
 *
 * Kept as its own pure, DOM-free module (no React, no `window`) rather than
 * inline in BrowserPane.tsx, for the same reason skills/dragDrop.ts's
 * serialise/parse/predicate triangle is: this is the one place a string
 * typed by a person turns into something handed straight to the DOM as an
 * iframe's `src` attribute, and getting it wrong is a real injection
 * vector — `javascript:`/`data:` URLs execute in the context of WHATEVER
 * they're loaded into, and an iframe's `src` is exactly that kind of sink.
 * Keeping the validation pure means every rejected scheme, every
 * normalisation case, and every garbage-input path can be exercised
 * directly under plain vitest (see url.test.ts), with no component render
 * needed to prove any of it.
 */

/** Only these two schemes may ever reach an iframe's `src` — see this
 * file's own top comment. Everything else (`javascript:`, `data:`,
 * `file:`, `blob:`, `about:`, `mailto:`, `ftp:`, ...) is refused outright,
 * never silently rewritten into something "safer": there is no safe way to
 * coerce a `javascript:` URL into an http(s) one, so the only honest move
 * is to say no and explain why. */
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/** Hosts that mean "this machine", matched case-insensitively (with or
 * without the `[...]` brackets an IPv6 literal needs next to a port). Dev
 * servers overwhelmingly listen on plain `http`, so a bare `localhost:3000`
 * (no scheme typed) should default there rather than to `https`, which most
 * local dev servers don't even speak — every OTHER bare host defaults to
 * `https` instead (see `defaultSchemeFor` below), the safer assumption for
 * a random hostname on the public internet. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Matches a bare `host:port`, no scheme at all — `localhost:3000`,
 * `127.0.0.1:8080`, `[::1]:9000`, optionally followed by a path
 * (`localhost:3000/app`). The identifying feature is "digits immediately
 * after the colon": a real URI scheme is never followed directly by a bare
 * port number (schemes are followed by `//`, or by non-numeric content for
 * the handful of colon-only schemes like `mailto:`/`data:`), which is what
 * lets `normalizeAndValidateUrl` tell "localhost:3000" (a host and a port)
 * apart from "javascript:alert(1)" (a scheme and its payload) even though
 * both are, syntactically, `word:rest`.
 */
const BARE_HOST_PORT_RE = /^(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+):(\d+)(\/.*)?$/;

/** Matches a string that starts with an explicit `scheme://` — an
 * absolute URL that already names its protocol. */
const EXPLICIT_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/** Matches a string that starts with SOME `scheme:` where the colon is NOT
 * followed by `//` — `javascript:`, `data:`, `mailto:`, `about:blank`,
 * `vbscript:`... Only checked once `BARE_HOST_PORT_RE` above has already
 * ruled out "this is actually a bare host:port", so this never
 * misclassifies `localhost:3000`. */
const BARE_SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

export type UrlValidation = { ok: true; url: string } | { ok: false; error: string };

function defaultSchemeFor(host: string): "http" | "https" {
  return LOCAL_HOSTS.has(host.toLowerCase()) ? "http" : "https";
}

/** The "host" portion of a scheme-less input — everything up to the first
 * `/`, `?`, or `#` (or the whole string if none of those appear). Only used
 * to pick the default scheme; the URL that actually gets built still uses
 * the ENTIRE trimmed input, path and all. */
function hostPortion(input: string): string {
  const match = /^[^/?#]+/.exec(input);
  return match ? match[0] : input;
}

/**
 * Confirms `candidate` genuinely parses as a URL — the last line of
 * defence against garbage that slipped past the regexes above (stray
 * spaces, unbalanced brackets, ...). Returns the ORIGINAL candidate string
 * on success, not `new URL(candidate).href` — the `URL` constructor
 * normalises as it re-serialises (e.g. adding a trailing `/` to a bare
 * origin), and this function's contract is "pass valid input through
 * unchanged", not "re-format it".
 */
function confirmParses(candidate: string): UrlValidation {
  try {
    void new URL(candidate);
    return { ok: true, url: candidate };
  } catch {
    return { ok: false, error: "That doesn't look like a valid URL." };
  }
}

/**
 * Validates and normalises whatever a person typed into a browser pane's
 * URL bar. See this file's top comment for why this exists as a separate,
 * pure function rather than living inline in BrowserPane.tsx.
 *
 * Three things this does, in order:
 *  1. Reject anything that isn't `http:`/`https:` (see `ALLOWED_SCHEMES`).
 *  2. Normalise a bare host into an absolute URL — `localhost:3000` ->
 *     `http://localhost:3000`, `example.com` -> `https://example.com`.
 *  3. Pass an already-valid `http(s)://...` URL through completely
 *     unchanged.
 */
export function normalizeAndValidateUrl(raw: string): UrlValidation {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: "Enter a URL to open." };

  // Bare host:port, no scheme — e.g. "localhost:3000". Checked FIRST,
  // before the scheme checks below, specifically so "localhost" (which
  // syntactically matches a URI scheme's grammar just as well as
  // "javascript" does) is never mistaken for one.
  const bareHostPort = BARE_HOST_PORT_RE.exec(trimmed);
  if (bareHostPort) {
    const scheme = defaultSchemeFor(bareHostPort[1]);
    return confirmParses(`${scheme}://${trimmed}`);
  }

  // An absolute URL that already names its scheme via "scheme://...".
  if (EXPLICIT_SCHEME_RE.test(trimmed)) {
    let scheme: string;
    try {
      scheme = new URL(trimmed).protocol;
    } catch {
      return { ok: false, error: "That doesn't look like a valid URL." };
    }
    if (!ALLOWED_SCHEMES.has(scheme)) {
      return { ok: false, error: `Only http:// and https:// links can be opened here — this is "${scheme}".` };
    }
    // Already valid and already http(s) — pass it through byte-for-byte,
    // not `new URL(trimmed).href` (see confirmParses' own comment on why).
    return { ok: true, url: trimmed };
  }

  // A scheme WITHOUT "//" — javascript:, data:, mailto:, about:blank, ...
  const bareScheme = BARE_SCHEME_RE.exec(trimmed);
  if (bareScheme) {
    return {
      ok: false,
      error: `Only http:// and https:// links can be opened here — this is "${bareScheme[1]}:".`,
    };
  }

  // No scheme, no port — a bare hostname/path, e.g. "example.com" or
  // "example.com/docs". Normalise it the same way a browser's own address
  // bar would: pick a default scheme and prepend it.
  const scheme = defaultSchemeFor(hostPortion(trimmed));
  return confirmParses(`${scheme}://${trimmed}`);
}
