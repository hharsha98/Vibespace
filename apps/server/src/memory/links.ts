/**
 * Pure functions over note bodies: extracting `[[wikilinks]]` and building
 * the whole-workspace note graph (nodes + edges + backlinks) from them. No
 * filesystem, no Node APIs — everything here is plain data in, data out, so
 * `links.test.ts` can exercise it directly without a temp directory. This
 * is deliberately the module store.ts, routes.ts, and mcp.ts all share
 * rather than each re-deriving their own notion of "what counts as a link."
 */
import type { MemoryGraphEdge, MemoryGraphNode } from "@vibespace/shared";

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

// --- suggestConnections: the honest heuristic behind `suggest_connections` -
//
// This is deliberately NOT semantic search, an embedding, or anything
// AI-powered — it's two plain lexical checks over the SAME `notes` array
// `buildGraph` already works with, run for every pair of notes that isn't
// already linked in either direction:
//
//   1. "Shared significant terms" — both notes' title+body, lowercased,
//      split on non-alphanumeric characters, with short words (<4 chars)
//      and a small fixed stopword list removed, have at least
//      `MIN_SHARED_TERMS` tokens in common.
//   2. "Title mention" — note A's body contains note B's *exact* title as
//      plain text (case-insensitive, whole-word/phrase boundaries, code
//      blocks/spans excluded via `stripCode` — same rule real `[[links]]`
//      already follow) but doesn't already `[[link]]` to it.
//
// What this WILL catch: an unlinked note whose title is typed out in
// another note's prose ("see the parser design doc" where a note titled
// exactly "Parser design" exists), and pairs of notes that both use the
// same handful of distinctive, non-generic words.
//
// What this WILL MISS, on purpose (no NLP, no embeddings, no LLM call):
//   - Paraphrases or synonyms ("auth" vs "authentication", "DB" vs
//     "database") — token match is literal, not semantic.
//   - A title referenced by abbreviation, partial phrase, or reworded text.
//   - Conceptual relationships with no shared vocabulary at all.
//   - False positives from generic-but-not-stopword shared words (two
//     unrelated notes that both happen to say "server", "config", and
//     "handler" a lot will still surface) — this is a SUGGESTION list for a
//     human/agent to sanity-check, not a guarantee of relatedness.
// This is a heuristic in the same spirit as BridgeMemory's own
// `suggest_connections` (docs/RESEARCH.md) — a plausible reason to look, not
// a claim of understanding.

const STOPWORDS = new Set([
  "this",
  "that",
  "with",
  "from",
  "have",
  "has",
  "had",
  "were",
  "will",
  "would",
  "could",
  "should",
  "into",
  "your",
  "their",
  "about",
  "which",
  "when",
  "where",
  "what",
  "who",
  "how",
  "not",
  "but",
  "all",
  "can",
  "its",
  "it's",
  "we",
  "you",
  "they",
  "note",
  "notes",
  "and",
  "the",
  "for",
  "are",
  "was",
  "then",
  "than",
  "also",
  "just",
  "only",
  "does",
  "doesn't",
  "these",
  "those",
  "here",
  "there",
  "over",
  "such",
  "each",
  "more",
  "most",
  "some",
  "same",
  "very",
  "still",
  "even",
]);

/** Minimum token length to count as "significant" — filters out short,
 * low-information words (and most stopwords, incidentally) without
 * needing them individually listed. */
const MIN_TERM_LENGTH = 4;

/** How many shared significant terms two notes need before "shared terms"
 * counts as a reason to suggest a link. Fixed, not tunable per call — a
 * genuinely related pair with only 1-2 shared terms won't surface; that's
 * the trade-off for keeping this predictable and explainable. */
const MIN_SHARED_TERMS = 3;

/** How many example shared terms to include in a suggestion's reason text
 * — enough to let a human sanity-check the match without dumping the whole
 * set for a pair that shares a lot. */
const MAX_EXAMPLE_TERMS = 5;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((t) => t.length >= MIN_TERM_LENGTH && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

/** Builds a case-insensitive regex that matches `title` as a whole
 * word/phrase — `(?<![a-z0-9])` / `(?![a-z0-9])` stand in for `\b` on both
 * sides so a title like "AI" doesn't match inside "said" or "mail", and a
 * title containing spaces/punctuation still needs its own characters
 * escaped first. */
function titleMentionRegex(title: string): RegExp {
  const escaped = title.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "i");
}

/** Deterministic, order-independent key for an unordered pair of slugs —
 * used both to dedupe suggestions (A-vs-B and B-vs-A are the same pair) and
 * to check "is this pair already linked" against `buildGraph`'s edges. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a} ${b}` : `${b} ${a}`;
}

export interface ConnectionSuggestion {
  /** The two notes' slugs, in fixed (lexicographic) order — this is an
   * UNORDERED pair; which slug ends up in `a` vs `b` carries no meaning of
   * its own (see each reason string for any actual directionality, e.g.
   * "A mentions B's title"). */
  a: string;
  b: string;
  /** Human-readable justification(s) for the suggestion — a pair can have
   * both a "shared terms" and a "title mention" reason at once. */
  reasons: string[];
}

/**
 * Proposes notes that probably should link to each other but don't yet.
 * Runs over every pair of `notes`, so this is O(n²) in note count — fine at
 * the same ~200-note ceiling docs/MEMORY.md already documents for the Graph
 * view; not something to run against a much larger workspace without
 * revisiting. Pairs already connected by a real (non-dangling) `[[link]]`
 * in EITHER direction are skipped entirely — nothing to suggest there.
 */
export function suggestConnections(notes: LinkableNote[]): ConnectionSuggestion[] {
  const { edges } = buildGraph(notes);
  const alreadyLinked = new Set<string>();
  for (const edge of edges) {
    if (!edge.dangling) alreadyLinked.add(pairKey(edge.source, edge.target));
  }

  const termsBySlug = new Map(notes.map((n) => [n.slug, new Set(tokenize(`${n.title} ${stripCode(n.body)}`))]));
  const strippedBodyBySlug = new Map(notes.map((n) => [n.slug, stripCode(n.body)]));

  const suggestions = new Map<string, ConnectionSuggestion>();
  const addReason = (a: string, b: string, reason: string) => {
    const key = pairKey(a, b);
    const existing = suggestions.get(key);
    if (existing) {
      existing.reasons.push(reason);
    } else {
      const [x, y] = a < b ? [a, b] : [b, a];
      suggestions.set(key, { a: x, b: y, reasons: [reason] });
    }
  };

  for (let i = 0; i < notes.length; i++) {
    for (let j = i + 1; j < notes.length; j++) {
      const noteA = notes[i];
      const noteB = notes[j];
      if (noteA.slug === noteB.slug) continue; // defensive — buildGraph already dedupes by slug
      if (alreadyLinked.has(pairKey(noteA.slug, noteB.slug))) continue;

      const termsA = termsBySlug.get(noteA.slug)!;
      const termsB = termsBySlug.get(noteB.slug)!;
      const shared = [...termsA].filter((t) => termsB.has(t));
      if (shared.length >= MIN_SHARED_TERMS) {
        const examples = shared.slice(0, MAX_EXAMPLE_TERMS).join(", ");
        addReason(noteA.slug, noteB.slug, `shares ${shared.length} significant terms with "${noteB.title}" (e.g. ${examples})`);
      }

      if (noteB.title.trim().length >= MIN_TERM_LENGTH) {
        const re = titleMentionRegex(noteB.title);
        if (re.test(strippedBodyBySlug.get(noteA.slug)!)) {
          addReason(noteA.slug, noteB.slug, `"${noteA.slug}" mentions "${noteB.title}" in its body but doesn't link to it`);
        }
      }
      if (noteA.title.trim().length >= MIN_TERM_LENGTH) {
        const re = titleMentionRegex(noteA.title);
        if (re.test(strippedBodyBySlug.get(noteB.slug)!)) {
          addReason(noteA.slug, noteB.slug, `"${noteB.slug}" mentions "${noteA.title}" in its body but doesn't link to it`);
        }
      }
    }
  }

  // Most-corroborated suggestions (more independent reasons) first; ties
  // broken alphabetically by the pair for a stable, testable order.
  return [...suggestions.values()].sort(
    (x, y) => y.reasons.length - x.reasons.length || `${x.a}${x.b}`.localeCompare(`${y.a}${y.b}`)
  );
}
