import { describe, expect, it } from "vitest";
import { createPendingCommand } from "./pendingCommand.js";

describe("createPendingCommand", () => {
  it("consume() returns null when nothing has ever been set", () => {
    const pending = createPendingCommand();
    expect(pending.consume()).toBeNull();
  });

  it("consume() returns the set text exactly once, then null thereafter", () => {
    const pending = createPendingCommand();
    pending.set("echo hi");

    expect(pending.consume()).toBe("echo hi");
    expect(pending.consume()).toBeNull(); // the load-bearing property: consuming clears it
    expect(pending.consume()).toBeNull(); // and stays cleared on further calls
  });

  it("a second set() overwrites an earlier, not-yet-consumed value", () => {
    const pending = createPendingCommand();
    pending.set("first");
    pending.set("second");

    expect(pending.consume()).toBe("second");
    expect(pending.consume()).toBeNull();
  });

  it("set() after a consume() makes the box pending again", () => {
    const pending = createPendingCommand();
    pending.set("first");
    expect(pending.consume()).toBe("first");

    pending.set("second");
    expect(pending.consume()).toBe("second");
    expect(pending.consume()).toBeNull();
  });

  it("each createPendingCommand() call is an independent box", () => {
    const a = createPendingCommand();
    const b = createPendingCommand();
    a.set("only-on-a");

    expect(a.consume()).toBe("only-on-a");
    expect(b.consume()).toBeNull();
  });
});
