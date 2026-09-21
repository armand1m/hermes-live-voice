import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Browser-only module intentionally ships as plain ESM JavaScript.
// @ts-expect-error No declaration file is emitted for browser assets.
import { RollingNumbers, computeVerdict, createDiagnosticsOverlay } from "../clients/browser/diagnostics.js";

describe("RollingNumbers", () => {
  it("reports percentiles over a fixed window without growing", () => {
    const ring = new RollingNumbers(8);
    for (let index = 1; index <= 20; index += 1) ring.push(index * 10);
    // The window keeps the newest 8 samples: 130..200. Percentiles are
    // nearest-rank over the sorted window.
    expect(ring.length).toBe(8);
    expect(ring.percentile(0.5)).toBe(160);
    expect(ring.percentile(0.95)).toBe(190);
    expect(ring.worst()).toBe(200);
  });

  it("ignores non-finite pushes", () => {
    const ring = new RollingNumbers(4);
    ring.push(Number.NaN);
    ring.push(Infinity);
    ring.push(12);
    expect(ring.length).toBe(1);
    expect(ring.percentile(0.5)).toBe(12);
  });

  it("returns null percentiles while empty", () => {
    expect(new RollingNumbers(4).percentile(0.5)).toBeNull();
    expect(new RollingNumbers(4).worst()).toBeNull();
  });
});

describe("computeVerdict", () => {
  const quietServer = {
    serverFresh: true,
    cores: 20,
    load1: 0.5,
    gatewayCpuPct: 4,
    voiceStackCpuPct: 120,
    eventLagMs: 2,
    gatewayAudioGapP95Ms: 80,
    lastAudioOutputMsAgo: 40,
  };

  it("attributes voice symptoms with hot server CPU to the server", () => {
    expect(computeVerdict({
      ...quietServer,
      voiceStackCpuPct: 1_500,
      jitterP95Ms: 420,
      latencyP95Ms: 900,
      fps: 60,
      fpsLowMs: 0,
      underrunMsAgo: null,
      expectingSpeech: true,
    })).toMatchObject({ verdict: "server" });
  });

  it("also flags the server through host load or event-loop starvation", () => {
    expect(computeVerdict({
      ...quietServer,
      load1: 25,
      latencyP95Ms: 3_200,
      fps: 60,
      fpsLowMs: 0,
      underrunMsAgo: null,
      expectingSpeech: false,
    })).toMatchObject({ verdict: "server" });
    expect(computeVerdict({
      ...quietServer,
      eventLagMs: 400,
      lastAudioOutputMsAgo: 2_000,
      expectingSpeech: true,
      latencyP95Ms: null,
      jitterP95Ms: null,
      fps: 60,
      fpsLowMs: 0,
      underrunMsAgo: null,
    })).toMatchObject({ verdict: "server" });
  });

  it("flags a hard mid-response audio feed stall as server-side even with quiet CPU", () => {
    // Another process can starve the host without moving the gateway or
    // voice-stack CPU counters; the gateway's own silent feed is the evidence.
    const verdict = computeVerdict({
      ...quietServer,
      lastAudioOutputMsAgo: 2_400,
      expectingSpeech: true,
      latencyP95Ms: null,
      jitterP95Ms: null,
      fps: 58,
      fpsLowMs: 0,
      underrunMsAgo: null,
    });
    expect(verdict).toMatchObject({ verdict: "server" });
    expect(verdict.reason).toContain("audio feed");
  });

  it("attributes low FPS or recent underruns with a quiet server to the client", () => {
    expect(computeVerdict({
      ...quietServer,
      latencyP95Ms: 700,
      jitterP95Ms: 90,
      fps: 22,
      fpsLowMs: 3_000,
      underrunMsAgo: null,
      expectingSpeech: false,
    })).toMatchObject({ verdict: "client" });
    expect(computeVerdict({
      ...quietServer,
      latencyP95Ms: null,
      jitterP95Ms: null,
      fps: 58,
      fpsLowMs: 0,
      underrunMsAgo: 1_500,
      expectingSpeech: true,
    })).toMatchObject({ verdict: "client" });
  });

  it("separates transport when only client-side arrivals widen", () => {
    expect(computeVerdict({
      ...quietServer,
      jitterP95Ms: 480,
      gatewayAudioGapP95Ms: 70,
      latencyP95Ms: 800,
      fps: 59,
      fpsLowMs: 0,
      underrunMsAgo: null,
      expectingSpeech: false,
    })).toMatchObject({ verdict: "transport" });
  });

  it("falls back to the client when jitter widens without tight server gaps", () => {
    expect(computeVerdict({
      ...quietServer,
      jitterP95Ms: 480,
      gatewayAudioGapP95Ms: 460,
      latencyP95Ms: 800,
      fps: 59,
      fpsLowMs: 0,
      underrunMsAgo: null,
      expectingSpeech: false,
    })).toMatchObject({ verdict: "client" });
  });

  it("stays nominal when nothing is strained and ignores stale server data", () => {
    expect(computeVerdict({
      ...quietServer,
      voiceStackCpuPct: 1_900,
      latencyP95Ms: 800,
      jitterP95Ms: 90,
      fps: 60,
      fpsLowMs: 0,
      underrunMsAgo: null,
      expectingSpeech: false,
      serverFresh: false,
    })).toMatchObject({ verdict: "nominal" });
    expect(computeVerdict({
      ...quietServer,
      latencyP95Ms: 800,
      jitterP95Ms: 90,
      fps: 60,
      fpsLowMs: 0,
      underrunMsAgo: null,
      expectingSpeech: false,
    })).toMatchObject({ verdict: "nominal" });
  });
});

describe("createDiagnosticsOverlay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("is inert without a DOM host", () => {
    const overlay = createDiagnosticsOverlay({ client: fakeEmitter() });
    expect(typeof overlay.dispose).toBe("function");
    overlay.dispose();
  });

  it("records turn latency and frame jitter from the client event stream", () => {
    const elements: any[] = [];
    const body = fakeElement() as ReturnType<typeof fakeElement> & { dataset: Record<string, string | undefined> };
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
    // The overlay prefers performance.now(); pin it to the (faked) wall clock
    // so virtual timer advances and measured intervals share one timeline.
    vi.stubGlobal("performance", { now: () => Date.now() });

    const client = fakeEmitter();
    const audio = fakeEmitter() as ReturnType<typeof fakeEmitter> & { playbackSources: Set<unknown> };
    audio.playbackSources = new Set();
    const overlay = createDiagnosticsOverlay({
      client,
      audio,
      metricsUrl: undefined,
      getFps: () => 60,
    });

    // One turn: VAD stop → first TTS frame after 240ms, second after 90ms.
    client.emit("input.speech_stopped", {});
    vi.advanceTimersByTime(240);
    client.emit("response.started", {});
    client.emit("audio.output", {});
    vi.advanceTimersByTime(90);
    client.emit("audio.output", {});
    vi.advanceTimersByTime(300);

    const text = elements.map((element) => String(element.textContent));
    const lat = text.find((value) => value.includes("p95"));
    expect(lat).toMatch(/^240ms \/ 240ms p95$/);
    const jit = text.find((value) => value.split(" / ").length === 3);
    expect(jit).toMatch(/^90ms \/ 90ms \/ 90ms$/);

    overlay.dispose();
    expect(body.dataset.diagnostics).toBeUndefined();
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
