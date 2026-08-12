/**
 * links.ts is the heart of Phase 8 — every test here is plain data in/out,
 * no filesystem, no temp dirs (unlike store.test.ts/routes.test.ts).
 */
import { describe, expect, it } from "vitest";
import { buildGraph, extractLinks } from "./links.js";

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
