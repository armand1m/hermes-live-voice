import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Browser-only module intentionally ships as plain ESM JavaScript.
// @ts-expect-error No declaration file is emitted for browser assets.
import { DEFAULT_MASTER_VOLUME, SOUND_SPECS, createSfx, loadAudioPrefs, resolveModeCue, saveAudioPrefs } from "../clients/browser/sfx.js";

class FakeParam {
  value: number;
  events: Array<{ method: string; value: number; time: number }> = [];
  constructor(initial = 0) {
    this.value = initial;
  }
  setValueAtTime(value: number, time: number) {
    this.events.push({ method: "set", value, time });
    this.value = value;
  }
  linearRampToValueAtTime(value: number, time: number) {
    this.events.push({ method: "linear", value, time });
    this.value = value;
  }
  exponentialRampToValueAtTime(value: number, time: number) {
    this.events.push({ method: "exponential", value, time });
    this.value = value;
  }
}

class FakeNode {
  connections: unknown[] = [];
  connect(node: unknown) {
    this.connections.push(node);
    return node;
  }
}

class FakeOscillator extends FakeNode {
  type = "";
  frequency = new FakeParam(440);
  started: number[] = [];
  stopped: number[] = [];
  start(time: number) {
    this.started.push(time);
  }
  stop(time: number) {
    this.stopped.push(time);
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam(1);
}

class FakeFilter extends FakeNode {
  type = "";
  frequency = new FakeParam(350);
}

class FakeAudioContext {
  state = "running";
  currentTime = 10;
  destination = new FakeNode();
  oscillators: FakeOscillator[] = [];
  gains: FakeGain[] = [];
  filters: FakeFilter[] = [];
  resumeCalls = 0;
  closed = false;
  createOscillator() {
    const node = new FakeOscillator();
    this.oscillators.push(node);
    return node;
  }
  createGain() {
    const node = new FakeGain();
    this.gains.push(node);
    return node;
  }
  createBiquadFilter() {
    const node = new FakeFilter();
    this.filters.push(node);
    return node;
  }
  resume() {
    this.resumeCalls += 1;
    this.state = "running";
    return Promise.resolve();
  }
  close() {
    this.closed = true;
    return Promise.resolve();
  }
}

function makeSfx(overrides: Record<string, unknown> = {}) {
  const context = new FakeAudioContext();
  const sfx = createSfx({ contextFactory: () => context, ...overrides });
  return { sfx, context };
}

describe("createSfx rendering", () => {
  it("renders a simple chirp with a frequency ramp, envelope, and bounded stop", () => {
    const { sfx, context } = makeSfx();
    expect(sfx.play("unmute")).toBe(true);

    const spec = SOUND_SPECS.unmute;
    expect(context.oscillators).toHaveLength(spec.voices.length);
    const osc = context.oscillators[0]!;
    expect(osc.type).toBe(spec.voices[0]!.type);
    const freqEvents = osc.frequency.events;
    expect(freqEvents[0]).toMatchObject({ method: "set", value: spec.voices[0]!.fromHz });
    expect(freqEvents.at(-1)).toMatchObject({ method: "exponential", value: spec.voices[0]!.toHz });
    // Voice gains chain into one master gain wired once to the destination.
    expect(context.gains).toHaveLength(spec.voices.length + 1);
    const master = context.gains[0]!;
    expect(master.gain.value).toBeCloseTo(DEFAULT_MASTER_VOLUME);
    expect(master.connections).toEqual([context.destination]);
    // Stop is scheduled past the envelope release so the tail is not clipped.
    const voiceGain = context.gains[1]!;
    const peak = voiceGain.gain.events.find((event) => event.method === "linear")!;
    expect(peak.value).toBeCloseTo(spec.voices[0]!.gain);
    expect(osc.started[0]).toBeGreaterThan(context.currentTime - 1);
    expect(osc.stopped[0]).toBeGreaterThanOrEqual(osc.started[0]! + spec.voices[0]!.durationSec);
  });

  it("routes the error dyad through a lowpass filter", () => {
    const { sfx, context } = makeSfx();
    expect(sfx.play("error")).toBe(true);
    expect(context.oscillators).toHaveLength(2);
    expect(context.filters).toHaveLength(1);
    const filter = context.filters[0]!;
    expect(filter.type).toBe("lowpass");
    expect(filter.connections).toEqual([context.gains[0]]);
    for (const gain of context.gains.slice(1)) {
      expect(gain.connections).toEqual([filter]);
    }
  });

  it("accepts expression-prefixed cue names from the controller", () => {
    const { sfx, context } = makeSfx();
    expect(sfx.play("expression:satisfied")).toBe(true);
    expect(context.oscillators).toHaveLength(SOUND_SPECS.satisfied.voices.length);
  });

  it("drops unknown cue names without touching the graph", () => {
    const { sfx, context } = makeSfx();
    expect(sfx.play("does-not-exist")).toBe(false);
    expect(context.oscillators).toHaveLength(0);
  });

  it("never schedules on a suspended context and drops disabled cues", () => {
    const { sfx, context } = makeSfx();
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      context.state = "suspended";
      expect(sfx.play("connected")).toBe(false);
      expect(context.oscillators).toHaveLength(0);

      context.state = "running";
      sfx.setEnabled(false);
      expect(sfx.play("connected")).toBe(false);
      expect(context.oscillators).toHaveLength(0);
      clock.mockReturnValue(SOUND_SPECS.connected.refractoryMs + 10);
      sfx.setEnabled(true);
      expect(sfx.play("connected")).toBe(true);
      expect(context.oscillators).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });

  it("collapses bursts with the per-sound refractory window", () => {
    const { sfx } = makeSfx();
    const clock = vi.spyOn(performance, "now").mockReturnValue(1_000);
    try {
      expect(sfx.play("error")).toBe(true);
      expect(sfx.play("error")).toBe(false);
      clock.mockReturnValue(1_000 + SOUND_SPECS.error.refractoryMs + 1);
      expect(sfx.play("error")).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  it("ducks cues to half gain while the assistant is speaking", () => {
    const plain = makeSfx();
    expect(plain.sfx.play("satisfied")).toBe(true);
    const ducked = makeSfx({ isSpeaking: () => true });
    expect(ducked.sfx.play("satisfied")).toBe(true);

    const plainPeak = peakOf(plain.context);
    const duckedPeak = peakOf(ducked.context);
    expect(plainPeak).toBeCloseTo(SOUND_SPECS.satisfied.voices[0]!.gain);
    expect(duckedPeak).toBeCloseTo(SOUND_SPECS.satisfied.voices[0]!.gain * 0.5);
  });

  it("applies setVolume to the master gain and disposes cleanly", () => {
    const { sfx, context } = makeSfx();
    sfx.play("unmute");
    sfx.setVolume(0.25);
    expect(context.gains[0]!.gain.value).toBeCloseTo(0.25);

    sfx.dispose();
    expect(context.closed).toBe(true);
    expect(sfx.play("unmute")).toBe(false);
    expect(() => sfx.prime()).not.toThrow();
    expect(context.oscillators).toHaveLength(1);
  });

  it("primes a suspended context for the user gesture", () => {
    const { sfx, context } = makeSfx();
    context.state = "suspended";
    sfx.prime();
    expect(context.resumeCalls).toBe(1);
    expect(context.gains[0]!.connections).toEqual([context.destination]);
  });
});

function peakOf(context: FakeAudioContext): number {
  const voiceGain = context.gains[1]!;
  return voiceGain.gain.events.find((event) => event.method === "linear")!.value;
}

describe("resolveModeCue", () => {
  const ctx = { micActive: true, connected: true };

  it("announces session establishment and loss", () => {
    expect(resolveModeCue("dormant", "listening", ctx)).toBe("connected");
    expect(resolveModeCue("offline", "idle", ctx)).toBe("connected");
    expect(resolveModeCue("dormant", "offline", ctx)).toBe("disconnected");
    expect(resolveModeCue("speaking", "offline", ctx)).toBe("disconnected");
  });

  it("maps entity modes to their cues", () => {
    expect(resolveModeCue("idle", "thinking", ctx)).toBe("thinking");
    expect(resolveModeCue("thinking", "tool", ctx)).toBe("tool");
    expect(resolveModeCue("idle", "waiting", ctx)).toBe("waiting");
    expect(resolveModeCue("thinking", "speaking", ctx)).toBe("speaking");
    expect(resolveModeCue("listening", "paused", ctx)).toBe("paused");
    expect(resolveModeCue("listening", "error", ctx)).toBe("error");
  });

  it("returns the turn hand-off only when the mic is live and connected", () => {
    expect(resolveModeCue("speaking", "idle", ctx)).toBe("idleReturn");
    expect(resolveModeCue("waiting", "idle", ctx)).toBe("idleReturn");
    expect(resolveModeCue("tool", "idle", ctx)).toBe("idleReturn");
    expect(resolveModeCue("speaking", "idle", { micActive: false, connected: true })).toBeNull();
    expect(resolveModeCue("speaking", "idle", { micActive: true, connected: false })).toBeNull();
    expect(resolveModeCue("listening", "idle", ctx)).toBeNull();
  });

  it("stays silent for self-caused or repeated modes", () => {
    expect(resolveModeCue("idle", "listening", ctx)).toBeNull();
    expect(resolveModeCue("", "dormant", ctx)).toBeNull();
    expect(resolveModeCue("idle", "dormant", ctx)).toBeNull();
    expect(resolveModeCue("thinking", "thinking", ctx)).toBeNull();
    expect(resolveModeCue("", "")).toBeNull();
  });
});

describe("audio preferences", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MapStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("round-trips settings and clamps volume", () => {
    expect(loadAudioPrefs()).toEqual({});
    saveAudioPrefs({ effects: false });
    saveAudioPrefs({ effectsVolume: 0.4 });
    expect(loadAudioPrefs()).toEqual({ effects: false, effectsVolume: 0.4 });
    saveAudioPrefs({ effectsVolume: 5 });
    expect(loadAudioPrefs()).toMatchObject({ effectsVolume: 1 });
  });

  it("ignores malformed or blocked storage", () => {
    saveAudioPrefs(JSON.stringify("junk") as unknown as Record<string, never>);
    expect(loadAudioPrefs()).toEqual({});

    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(loadAudioPrefs()).toEqual({});
    expect(() => saveAudioPrefs({ effects: true })).not.toThrow();
  });
});

class MapStorage {
  private map = new Map<string, string>();
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
}
