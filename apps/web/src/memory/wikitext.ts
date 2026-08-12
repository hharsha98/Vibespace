/**
 * A small, pure tokenizer that turns a memory note's markdown `body` into
 * renderable segments: plain text, code (fenced or inline — never
 * link-parsed, so documentation ABOUT the `[[wikilink]]` syntax doesn't
 * render a phantom clickable link), and `[[wikilink]]` targets.
 * MemoryPanel.tsx maps these into React nodes (a plain span for text, a
 * `<code>` for code, a clickable button — styled real vs. dangling — for a
 * link).
 *
 * This deliberately mirrors `apps/server/src/memory/links.ts`'s
 * `stripCode`/`extractLinks` regexes rather than importing them: the web
 * app only depends on `@vibedeck/shared` (browser-safe), not
 * `@vibedeck/server`, so a server-side module isn't reachable here at all —
 * see that file's top comment for the shared reasoning behind the regexes
 * themselves.
 */

export type WikitextToken =
  | { kind: "text"; value: string }
  | { kind: "code"; value: string }
  | { kind: "link"; value: string };

// Matches a fenced code block (``` ... ``` or ~~~ ... ~~~) OR an inline code
// span (`...`) OR a [[wikilink]] — whichever comes first in the string.
// Scanning left-to-right with one alternation (instead of stripping code
// first, the way links.ts does) is what lets this function preserve the
// actual code content for rendering, not just blank it out.
const TOKEN_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`|\[\[([^\]\n]+?)\]\]/g;

/** Splits `body` into an ordered list of text/code/link tokens. Concatenating
 * every token's rendered form (with `[[`/`]]` re-added around a link's
 * value) reproduces `body` exactly — nothing is dropped, only classified. */
export function tokenizeBody(body: string): WikitextToken[] {
  const tokens: WikitextToken[] = [];
  let lastIndex = 0;

  for (const match of body.matchAll(TOKEN_RE)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      tokens.push({ kind: "text", value: body.slice(lastIndex, index) });
    }

    const whole = match[0];
    const linkTarget = match[1];
    if (linkTarget !== undefined) {
      tokens.push({ kind: "link", value: linkTarget.trim() });
    } else {
      tokens.push({ kind: "code", value: whole });
    }
    lastIndex = index + whole.length;
  }

  if (lastIndex < body.length) {
    tokens.push({ kind: "text", value: body.slice(lastIndex) });
  }

  return tokens;
}
