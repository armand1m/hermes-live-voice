import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Browser-only module intentionally ships as plain ESM JavaScript.
// @ts-expect-error No declaration file is emitted for browser assets.
import { computeBrainView, createDiagnosticsOverlay } from "../clients/browser/diagnostics.js";

describe("computeBrainView", () => {
  it("renders the primary brain with its model id", () => {
    const view = computeBrainView({ kind: "primary", brain: "qwen3.8-27b", ts: new Date(10_000).toISOString() }, 11_000);
    expect(view.kind).toBe("primary");
    expect(view.label).toBe("qwen3.8-27b · primary");
    expect(view.stale).toBe(false);
  });

  it("shouts on failover", () => {
    const view = computeBrainView({ kind: "failover", brain: "glm-5.2", ts: new Date(10_000).toISOString() }, 11_000);
    expect(view.kind).toBe("failover");
    expect(view.label).toBe("glm-5.2 · FAILOVER");
  });

  it("marks stale status (controller gone) without inventing a brain", () => {
    const view = computeBrainView({ kind: "primary", brain: "qwen3.8-27b", ts: new Date(0).toISOString() }, 61_000);
    expect(view.stale).toBe(true);
    expect(view.label).toContain("stale");
    // Still primary — a stale mirror must not read as an outage by itself.
    expect(view.kind).toBe("primary");
  });

  it("degrades to unknown for missing or malformed status", () => {
    expect(computeBrainView(null).kind).toBe("unknown");
    expect(computeBrainView({}).kind).toBe("unknown");
    expect(computeBrainView({ kind: "weird", brain: "", ts: "nope" }).label).toContain("?");
  });
});

describe("createDiagnosticsOverlay brain indicator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("polls /brain-status.json next to the metrics URL and shows the active brain", async () => {
    const elements: any[] = [];
    const body = fakeElement();
    const document = {
      body,
      hidden: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      createElement: () => {
        const element = fakeElement();
        elements.push(element);
        return element;
      },
    };
    vi.stubGlobal("document", document);
    vi.stubGlobal("performance", { now: () => Date.now() });

    let statusPayload: any = { kind: "primary", brain: "qwen3.8-27b", ts: new Date().toISOString() };
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => statusPayload,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const overlay = createDiagnosticsOverlay({
      client: fakeEmitter(),
      metricsUrl: "/voice/v1/metrics",
      getFps: () => 60,
    });

    // First poll fires on the brain interval; a render tick follows it.
    await vi.advanceTimersByTimeAsync(5_100);
    expect(fetchMock).toHaveBeenCalledWith(
      "/voice/brain-status.json",
      expect.objectContaining({ cache: "no-store" }),
    );
    await vi.advanceTimersByTimeAsync(300);
    let text = elements.map((element) => String(element.textContent));
    expect(text.some((value) => value === "qwen3.8-27b · primary")).toBe(true);

    // The controller flips to failover: the next poll updates the row.
    statusPayload = { kind: "failover", brain: "glm-5.2", ts: new Date().toISOString() };
    await vi.advanceTimersByTimeAsync(5_100);
    await vi.advanceTimersByTimeAsync(300);
    text = elements.map((element) => String(element.textContent));
    expect(text.some((value) => value === "glm-5.2 · FAILOVER")).toBe(true);

    overlay.dispose();
  });

  it("survives a missing brain-status file (deploys without the controller)", async () => {
    const elements: any[] = [];
    const document = {
      body: fakeElement(),
      hidden: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      createElement: () => {
        const element = fakeElement();
        elements.push(element);
        return element;
      },
    };
    vi.stubGlobal("document", document);
    vi.stubGlobal("performance", { now: () => Date.now() });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 })));

    const overlay = createDiagnosticsOverlay({
      client: fakeEmitter(),
      metricsUrl: "/v1/metrics",
      getFps: () => 60,
    });
    await vi.advanceTimersByTimeAsync(16_000);
    // The brain row stays a placeholder; the rest of the panel still renders.
    const text = elements.map((element) => String(element.textContent));
    expect(text.filter((value) => / · (primary|FAILOVER)/.test(value)).length).toBe(0);
    overlay.dispose();
    expect(typeof overlay.dispose).toBe("function");
  });

  it("derives no brain URL when metricsUrl is absent (legacy call sites)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const document = {
      body: fakeElement(),
      hidden: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      createElement: () => fakeElement(),
    };
    vi.stubGlobal("document", document);
    vi.stubGlobal("performance", { now: () => Date.now() });
    const overlay = createDiagnosticsOverlay({ client: fakeEmitter(), getFps: () => 60 });
    await vi.advanceTimersByTimeAsync(16_000);
    expect(fetchMock).not.toHaveBeenCalled();
    overlay.dispose();
  });
});

function fakeElement() {
  return {
    className: "",
    textContent: "",
    dataset: {},
    setAttribute: vi.fn(),
    append: vi.fn(),
    remove: vi.fn(),
  };
}

function fakeEmitter() {
  const listeners = new Map<string, Array<(value: unknown) => void>>();
  return {
    on(type: string, listener: (value: unknown) => void) {
      const bucket = listeners.get(type) ?? [];
      bucket.push(listener);
      listeners.set(type, bucket);
      return () => {
        const current = listeners.get(type) ?? [];
        const index = current.indexOf(listener);
        if (index >= 0) current.splice(index, 1);
      };
    },
    emit(type: string, value: unknown) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(value);
    },
  };
}
