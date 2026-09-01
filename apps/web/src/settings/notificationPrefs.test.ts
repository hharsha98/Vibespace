import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getNotificationPermission,
  loadNotifyOnAgentIdle,
  notifyAgentIdle,
  requestNotificationPermission,
  saveNotifyOnAgentIdle,
} from "./notificationPrefs.js";

function stubLocalStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadNotifyOnAgentIdle / saveNotifyOnAgentIdle", () => {
  it("defaults to off when nothing is stored (no window)", () => {
    expect(loadNotifyOnAgentIdle()).toBe(false);
  });

  it("round-trips true and false", () => {
    stubLocalStorage();
    saveNotifyOnAgentIdle(true);
    expect(loadNotifyOnAgentIdle()).toBe(true);
    saveNotifyOnAgentIdle(false);
    expect(loadNotifyOnAgentIdle()).toBe(false);
  });
});

describe("getNotificationPermission", () => {
  it("reports \"unsupported\" when there is no Notification global", () => {
    expect(getNotificationPermission()).toBe("unsupported");
  });

  it("reads Notification.permission when it exists", () => {
    vi.stubGlobal("Notification", { permission: "denied" });
    expect(getNotificationPermission()).toBe("denied");
  });
});

describe("requestNotificationPermission — the click-only contract", () => {
  it("does NOT call Notification.requestPermission just from being imported/available — only an explicit call to this function may", () => {
    const requestPermission = vi.fn().mockResolvedValue("granted");
    vi.stubGlobal("Notification", { permission: "default", requestPermission });
    // Merely having the module loaded and the global present must not, on
    // its own, have triggered a request — this is the automated proxy for
    // "never requested on page load," since there's no page-load effect to
    // literally simulate without jsdom (see Settings.tsx's own onClick,
    // which is the ONLY call site).
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("calls the real Notification.requestPermission exactly once when explicitly invoked", async () => {
    const requestPermission = vi.fn().mockResolvedValue("granted");
    vi.stubGlobal("Notification", { permission: "default", requestPermission });
    const result = await requestNotificationPermission();
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(result).toBe("granted");
  });

  it("returns \"unsupported\" without throwing when there is no Notification global", async () => {
    await expect(requestNotificationPermission()).resolves.toBe("unsupported");
  });
});

describe("notifyAgentIdle", () => {
  it("does not construct a Notification when the preference is off", () => {
    stubLocalStorage();
    saveNotifyOnAgentIdle(false);
    const ctor = vi.fn();
    vi.stubGlobal("Notification", Object.assign(ctor, { permission: "granted" }));
    vi.stubGlobal("document", { hidden: true });
    notifyAgentIdle("Claude Code");
    expect(ctor).not.toHaveBeenCalled();
  });

  it("does not construct a Notification when permission was never granted", () => {
    stubLocalStorage();
    saveNotifyOnAgentIdle(true);
    const ctor = vi.fn();
    vi.stubGlobal("Notification", Object.assign(ctor, { permission: "default" }));
    vi.stubGlobal("document", { hidden: true });
    notifyAgentIdle("Claude Code");
    expect(ctor).not.toHaveBeenCalled();
  });

  it("does not construct a Notification while the tab is in the foreground", () => {
    stubLocalStorage();
    saveNotifyOnAgentIdle(true);
    const ctor = vi.fn();
    vi.stubGlobal("Notification", Object.assign(ctor, { permission: "granted" }));
    vi.stubGlobal("document", { hidden: false });
    notifyAgentIdle("Claude Code");
    expect(ctor).not.toHaveBeenCalled();
  });

  it("constructs a real Notification when the preference is on, permission is granted, and the tab is hidden", () => {
    stubLocalStorage();
    saveNotifyOnAgentIdle(true);
    const ctor = vi.fn();
    vi.stubGlobal("Notification", Object.assign(ctor, { permission: "granted" }));
    vi.stubGlobal("document", { hidden: true });
    notifyAgentIdle("Claude Code");
    expect(ctor).toHaveBeenCalledTimes(1);
    expect(ctor.mock.calls[0][0]).toBe("vibespace");
    expect(ctor.mock.calls[0][1]).toEqual({ body: expect.stringContaining("Claude Code") });
  });
});
