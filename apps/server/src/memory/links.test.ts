/**
 * links.ts is the heart of Phase 8 — every test here is plain data in/out,
 * no filesystem, no temp dirs (unlike store.test.ts/routes.test.ts).
 */
import { describe, expect, it } from "vitest";
import { buildGraph, extractLinks, suggestConnections } from "./links.js";

describe("extractLinks", () => {
  it("extracts multiple links from one body", () => {
    expect(extractLinks("See [[note-a]] and also [[note-b]].")).toEqual(["note-a", "note-b"]);
  });

  it("dedupes repeated links, keeping first-seen order", () => {
    expect(extractLinks("[[note-a]] again: [[note-a]], and [[note-b]].")).toEqual(["note-a", "note-b"]);
  });

  it("ignores links inside fenced code blocks", () => {
    const body = "Real link: [[real-note]].\n\n```\nThis mentions [[fake-note]] in a code fence.\n```\n";
    expect(extractLinks(body)).toEqual(["real-note"]);
  });

  it("ignores links inside inline code spans", () => {
    const body = "Use the `[[example]]` syntax to link. Also see [[real-note]].";
    expect(extractLinks(body)).toEqual(["real-note"]);
  });

  it("ignores links inside ~~~ fenced blocks too", () => {
    const body = "~~~\n[[fake]]\n~~~\n[[real]]";
    expect(extractLinks(body)).toEqual(["real"]);
  });

  it("returns an empty array for a body with no links", () => {
    expect(extractLinks("Just plain text, no brackets.")).toEqual([]);
  });

  it("trims whitespace inside the brackets", () => {
    expect(extractLinks("[[  spaced-note  ]]")).toEqual(["spaced-note"]);
  });

  it("extracts a self-link (a note linking to its own slug)", () => {
    expect(extractLinks("This note references [[self-slug]].")).toEqual(["self-slug"]);
  });
});

describe("buildGraph", () => {
  it("builds nodes and edges for a simple two-note link", () => {
    const notes = [
      { slug: "a", title: "A", body: "links to [[b]]" },
      { slug: "b", title: "B", body: "no links here" },
    ];
    const { nodes, edges, backlinks } = buildGraph(notes);

    expect(nodes).toHaveLength(2);
    expect(nodes.find((n) => n.slug === "a")).toEqual({ slug: "a", title: "A", dangling: false });
    expect(nodes.find((n) => n.slug === "b")).toEqual({ slug: "b", title: "B", dangling: false });
    expect(edges).toEqual([{ source: "a", target: "b", dangling: false }]);
    expect(backlinks).toEqual({ a: [], b: ["a"] });
  });

  it("flags a link to a note that doesn't exist as dangling, and adds a dangling node for it", () => {
    const notes = [{ slug: "a", title: "A", body: "links to [[missing]]" }];
    const { nodes, edges, backlinks } = buildGraph(notes);

    expect(edges).toEqual([{ source: "a", target: "missing", dangling: true }]);
    const danglingNode = nodes.find((n) => n.slug === "missing");
    expect(danglingNode).toEqual({ slug: "missing", title: "missing", dangling: true });
    // A dangling target still gets a backlinks entry pointing at whoever
    // linked to it — that's what lets the UI say "1 note wants this".
    expect(backlinks.missing).toEqual(["a"]);
  });

  it("handles a self-link without duplicating the node", () => {
    const notes = [{ slug: "a", title: "A", body: "see also [[a]]" }];
    const { nodes, edges, backlinks } = buildGraph(notes);

    expect(nodes).toHaveLength(1);
    expect(edges).toEqual([{ source: "a", target: "a", dangling: false }]);
    expect(backlinks.a).toEqual(["a"]);
  });

  it("computes backlinks correctly when multiple notes link to the same target", () => {
    const notes = [
      { slug: "a", title: "A", body: "[[c]]" },
      { slug: "b", title: "B", body: "[[c]]" },
      { slug: "c", title: "C", body: "no links" },
    ];
    const { backlinks } = buildGraph(notes);
    expect(backlinks.c).toEqual(["a", "b"]);
  });

  it("a two-node cycle (A -> B, B -> A) does not hang and produces both edges", () => {
    const notes = [
      { slug: "a", title: "A", body: "[[b]]" },
      { slug: "b", title: "B", body: "[[a]]" },
    ];
    const { nodes, edges, backlinks } = buildGraph(notes);

    expect(nodes).toHaveLength(2);
    expect(edges).toEqual(
      expect.arrayContaining([
        { source: "a", target: "b", dangling: false },
        { source: "b", target: "a", dangling: false },
      ])
    );
    expect(backlinks.a).toEqual(["b"]);
    expect(backlinks.b).toEqual(["a"]);
  });

  it("returns empty nodes/edges/backlinks for an empty note list", () => {
    expect(buildGraph([])).toEqual({ nodes: [], edges: [], backlinks: {} });
  });
});

describe("suggestConnections", () => {
  // Every fixture body below is hand-picked so the expected token overlap
  // can be counted by eye (see links.ts's suggestConnections doc comment
  // for the exact tokenize/stopword/length rules being exercised) —
  // deliberately NOT realistic prose, so there's no ambiguity about what
  // "the correct answer" is.

  it("flags a pair sharing >= 3 significant terms, with the example terms named in the reason", () => {
    // Titles are single letters (below the 4-char minimum), so only body
    // tokens participate — isolates the "shared terms" path from "title
    // mention" entirely.
    const a = { slug: "a", title: "A", body: "alpha bravo charlie delta echo" };
    const b = { slug: "b", title: "B", body: "alpha bravo charlie foxtrot golf" };

    const result = suggestConnections([a, b]);

    expect(result).toHaveLength(1);
    expect(result[0].a).toBe("a");
    expect(result[0].b).toBe("b");
    expect(result[0].reasons).toHaveLength(1);
    expect(result[0].reasons[0]).toContain("shares 3 significant terms");
    expect(result[0].reasons[0]).toContain("alpha");
    expect(result[0].reasons[0]).toContain("bravo");
    expect(result[0].reasons[0]).toContain("charlie");
  });

  it("does NOT flag a pair sharing only 2 significant terms (below the threshold)", () => {
    const a = { slug: "a", title: "A", body: "alpha bravo cat dog" }; // cat/dog are 3 chars, filtered
    const b = { slug: "b", title: "B", body: "alpha bravo fox owl" }; // fox/owl are 3 chars, filtered
    expect(suggestConnections([a, b])).toEqual([]);
  });

  it("flags a note's exact title appearing as plain text in another note's body, not yet wikilinked", () => {
    const releaseChecklist = { slug: "release-checklist", title: "Release checklist", body: "Steps for shipping." };
    const shippingNotes = {
      slug: "shipping-notes",
      title: "Ship notes",
      body: "See the release checklist before shipping.",
    };

    const result = suggestConnections([releaseChecklist, shippingNotes]);

    expect(result).toHaveLength(1);
    expect(result[0].reasons.some((r) => r.includes('mentions "Release checklist"'))).toBe(true);
  });

  it("does not match a title mention inside a fenced code block", () => {
    const target = { slug: "target-note", title: "Target note", body: "Body text." };
    const other = {
      slug: "other-note",
      title: "Other note",
      body: "```\nThis mentions Target note only inside a code fence.\n```",
    };
    expect(suggestConnections([target, other])).toEqual([]);
  });

  it("skips a pair that's already linked (in either direction), even if it would otherwise match", () => {
    const a = { slug: "a", title: "A", body: "alpha bravo charlie delta [[b]]" };
    const b = { slug: "b", title: "B", body: "alpha bravo charlie foxtrot" };
    // Same shared-term overlap as the first test above, but this time `a`
    // already links to `b` — nothing to suggest.
    expect(suggestConnections([a, b])).toEqual([]);
  });

  it("returns an empty array for zero or one notes", () => {
    expect(suggestConnections([])).toEqual([]);
    expect(suggestConnections([{ slug: "a", title: "A", body: "alpha bravo charlie" }])).toEqual([]);
  });

  it("sorts multiple suggestions by number of corroborating reasons, most first", () => {
    const a = { slug: "a", title: "A", body: "alpha bravo charlie delta echo" };
    const b = { slug: "b", title: "B", body: "alpha bravo charlie foxtrot golf" };
    const releaseChecklist = { slug: "release-checklist", title: "Release checklist", body: "Steps for shipping." };
    const shippingNotes = {
      slug: "shipping-notes",
      title: "Ship notes",
      body: "See the release checklist before shipping.",
    };

    const result = suggestConnections([a, b, releaseChecklist, shippingNotes]);

    expect(result).toHaveLength(2);
    // release-checklist/shipping-notes corroborates via BOTH shared terms
    // (release/checklist/shipping all appear in both bodies) AND the
    // title-mention rule, so it has more reasons than the a/b pair (shared
    // terms only) and must sort first.
    expect(result[0].reasons.length).toBeGreaterThan(result[1].reasons.length);
    expect([result[0].a, result[0].b].sort()).toEqual(["release-checklist", "shipping-notes"]);
    expect([result[1].a, result[1].b].sort()).toEqual(["a", "b"]);
  });
});
