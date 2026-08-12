/**
 * Pure functions over note bodies: extracting `[[wikilinks]]` and building
 * the whole-workspace note graph (nodes + edges + backlinks) from them. No
 * filesystem, no Node APIs — everything here is plain data in, data out, so
 * `links.test.ts` can exercise it directly without a temp directory. This
 * is deliberately the module store.ts, routes.ts, and mcp.ts all share
 * rather than each re-deriving their own notion of "what counts as a link."
 */
import type { MemoryGraphEdge, MemoryGraphNode } from "@vibedeck/shared";

/** Matches `[[target]]` — target is anything but `]` or a newline, so
 * `[[a]] [[b]]` on one line extracts two separate links rather than one
 * greedy `a]] [[b`. */
const WIKILINK_RE = /\[\[([^\]\n]+?)\]\]/g;

/**
 * Blanks out fenced code blocks (``` ``` or ~~~ ~~~) and inline code spans
 * (`...`) in `body`, replacing each with same-length whitespace so line/
 * column positions of anything else in the string stay stable. This is
 * what keeps documentation ABOUT the `[[wikilink]]` syntax — e.g. a note
 * that explains the convention by showing `` `[[example]]` `` in a code
 * span — from creating a phantom link to a note called "example".
 */
function stripCode(body: string): string {
  let out = body.replace(/```[\s\S]*?```/g, (m) => " ".repeat(m.length));
  out = out.replace(/~~~[\s\S]*?~~~/g, (m) => " ".repeat(m.length));
  out = out.replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length));
  return out;
}

/**
 * Every `[[target]]` link in `body`, deduped, in first-seen order. Links
 * inside fenced code blocks or inline code spans are ignored (see
 * `stripCode` above). `target` is returned trimmed but otherwise verbatim —
 * callers compare it against known note slugs to decide whether it's real
 * or dangling.
 */
export function extractLinks(body: string): string[] {
  const cleaned = stripCode(body);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const match of cleaned.matchAll(WIKILINK_RE)) {
    const target = match[1].trim();
    if (target.length === 0 || seen.has(target)) continue;
    seen.add(target);
    result.push(target);
  }
  return result;
}

/** The minimal shape `buildGraph` needs from a note — matches
 * `MemoryNote`'s `slug`/`title`/`body` fields but is kept as its own local
 * type so this module doesn't need to import the full `MemoryNote` (with
 * its `tags`/timestamps) just to read three fields. */
export interface LinkableNote {
  slug: string;
  title: string;
  body: string;
}

export interface BuildGraphResult {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  /** `backlinks[slug]` — every note's slug that links TO `slug`, including
   * entries for dangling targets (a target with no note yet can still have
   * "backlinks" pointing at the note that would fill it in). */
  backlinks: Record<string, string[]>;
}

/**
 * Builds the whole graph from every note in a workspace: one node per real
 * note PLUS one node per dangling link target, one edge per `[[link]]`
 * (source note -> target slug, flagged `dangling` if no note exists for
 * that target), and the backlinks index every target accumulates. Runs in
 * a single pass over `notes` with no recursion, so a link cycle (A -> B,
 * B -> A) can never cause it to hang — see links.test.ts.
 */
export function buildGraph(notes: LinkableNote[]): BuildGraphResult {
  const bySlug = new Map(notes.map((note) => [note.slug, note]));
  // Set, not array — preserves first-seen order while still deduping a
  // dangling target that turns out to be linked from more than one note.
  const nodeSlugs = new Set(notes.map((note) => note.slug));
  const backlinks: Record<string, string[]> = {};
  for (const slug of nodeSlugs) backlinks[slug] = [];

  const edges: MemoryGraphEdge[] = [];
  for (const note of notes) {
    for (const target of extractLinks(note.body)) {
      const dangling = !bySlug.has(target);
      edges.push({ source: note.slug, target, dangling });
      nodeSlugs.add(target); // no-op if target is already a real note's slug
      if (!backlinks[target]) backlinks[target] = [];
      backlinks[target].push(note.slug);
    }
  }

  const nodes: MemoryGraphNode[] = [...nodeSlugs].map((slug) => {
    const note = bySlug.get(slug);
    return { slug, title: note?.title ?? slug, dangling: !note };
  });

  return { nodes, edges, backlinks };
}
