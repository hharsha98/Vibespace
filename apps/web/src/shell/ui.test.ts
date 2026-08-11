import { describe, expect, it } from "vitest";
import { sessionStatusKind } from "./ui.js";

// `sessionStatusKind` is the one bit of pure logic in shell/ui.tsx (the rest
// is JSX, which this test file deliberately doesn't touch — CI runs on
// ubuntu-latest with no browser/DOM, see the top-level "Testing" note in
// docs/DESIGN.md's phase spec). It's the single source of truth every
// status dot in the app (pane title bars, workspace rail rows, and later
// board cards/swarm nodes) uses to decide what colour "running" is.
describe("sessionStatusKind", () => {
  it("maps a running session to the ok (green) status", () => {
    expect(sessionStatusKind("running")).toBe("ok");
  });

  it("maps an exited session to idle (grey), not danger", () => {
    // Per docs/DESIGN.md §2's status table, "idle / exited" share one
    // token — a session that ran and finished isn't an error state on its
    // own, so it should read the same grey as an empty pane, not red.
    expect(sessionStatusKind("exited")).toBe("idle");
  });

  it("maps an empty pane (no session at all) to idle (grey)", () => {
    expect(sessionStatusKind("empty")).toBe("idle");
  });
});
