import { describe, expect, it, vi } from "vitest";
import type { VadConfig } from "../src/config.js";
import { EnergyProbabilityEngine } from "../src/application/live-gateway/vad/energy-engine.js";
import { SpeechGate, type SpeechProbabilityEngine } from "../src/application/live-gateway/vad/speech-gate.js";
import { decodePcm16Base64 } from "../src/domain/audio/pcm.js";

function vadConfig(overrides: Partial<VadConfig> = {}): VadConfig {
  return {
    engine: "smart",
    startProbability: 0.5,
    stopProbability: 0.25,
    startSustainMs: 100,
    stopSustainMs: 500,
    echoStartProbability: 0.7,
    echoStartSustainMs: 200,
    prerollMs: 250,
    tailMs: 400,
    ...overrides,
  };
}

/** 50 ms of PCM16 at the given rate with a roughly constant amplitude. */
function frame(level: number, rate = 16_000): { data: string; mimeType: string } {
  const samples = new Int16Array(Math.round(rate * 0.05));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.round(Math.sin(i / 3) * level * 32_767);
  }
  return {
    data: Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString("base64"),
    mimeType: `audio/pcm;rate=${rate}`,
  };
}

function frameBytes(f: { data: string }): Int16Array {
  return decodePcm16Base64(f.data);
}

/**
 * Emits exactly one scripted probability per ingest call so sustain math is
 * deterministic: each call advances the gate by one 32 ms chunk. The final
 * scripted value repeats forever.
 */
class ScriptedEngine implements SpeechProbabilityEngine {
  private index = 0;
  public fed: Float32Array[] = [];
  constructor(private readonly probabilities: number[]) {}
  reset(): void {
    this.index = 0;
    this.fed = [];
  }
  async score(samples: Float32Array): Promise<number[]> {
    this.fed.push(samples);
    return [this.probabilities[Math.min(this.index++, this.probabilities.length - 1)]];
  }
}

const SPEECH = 0.9;
const QUIET_PROBABILITY = 0.05;
/** ceil(100 ms sustain / 32 ms chunk): probability calls needed to confirm start. */
const START_CALLS = 4;
/** ceil(500 ms stop sustain / 32 ms chunk). */
const STOP_CALLS = 16;

interface Started {
  calls: number;
  decision: Awaited<ReturnType<SpeechGate["ingest"]>>;
}

/** Ingests until the gate confirms speech; returns the call count and decision. */
async function startSpeech(gate: SpeechGate, level = 0.02, limit = 16): Promise<Started> {
  for (let call = 1; call <= limit; call += 1) {
    const decision = await gate.ingest(frame(level));
    if (decision.started) return { calls: call, decision };
  }
  throw new Error("Speech never confirmed within the call limit.");
}

function repeating(count: number, value: number, then = value): number[] {
  return [...Array.from({ length: count }, () => value), then];
}

describe("speech gate", () => {
  it("requires sustained speech probability before starting, then flushes preroll in order", async () => {
    const quiet = new SpeechGate({
      engine: new ScriptedEngine([QUIET_PROBABILITY]),
      config: vadConfig(),
    });
    expect((await quiet.ingest(frame(0.001))).started).toBe(false);

    // Preroll lead-in frames score below the threshold, so they only buffer.
    const prerollFrames = [frame(0.02), frame(0.02)];
    const gate = new SpeechGate({
      engine: new ScriptedEngine([QUIET_PROBABILITY, QUIET_PROBABILITY, SPEECH]),
      config: vadConfig(),
    });
    for (const prerollFrame of prerollFrames) {
      const decision = await gate.ingest(prerollFrame);
      expect(decision.forward).toHaveLength(0);
      expect(decision.started).toBe(false);
    }

    const { calls, decision: started } = await startSpeech(gate);
    expect(calls).toBe(START_CALLS);
    expect(started.probability).toBe(SPEECH);
    // Preroll lead-in + the sustain-building frames flush before the trigger.
    expect(started.forward.length).toBeGreaterThanOrEqual(prerollFrames.length + 1);
    expect(started.forward.length).toBeLessThanOrEqual(7);
    expect(frameBytes(started.forward[0])).toEqual(frameBytes(prerollFrames[0]));
    expect(started.forward.every((f) => f.mimeType === "audio/pcm;rate=16000")).toBe(true);
  });

  it("does not start when a sub-threshold chunk resets the sustain streak", async () => {
    const gate = new SpeechGate({
      engine: new ScriptedEngine([SPEECH, SPEECH, SPEECH, QUIET_PROBABILITY, SPEECH]),
      config: vadConfig(),
    });
    for (let i = 0; i < START_CALLS + 1; i += 1) {
      expect((await gate.ingest(frame(0.02))).started).toBe(false);
    }
  });

  it("keeps forwarding while active and reports stopped only after the silence tail drains", async () => {
    const gate = new SpeechGate({
      engine: new ScriptedEngine([...repeating(START_CALLS + 2, SPEECH), QUIET_PROBABILITY]),
      config: vadConfig({ tailMs: 100 }),
    });
    const { decision: started } = await startSpeech(gate);
    expect(started.started).toBe(true);

    // Silence keeps flowing to the provider until the stop sustains and the
    // 100 ms tail drains; exactly one stopped event fires, on the last one.
    let stoppedSeen = false;
    let quietCalls = 0;
    for (let i = 0; i < 40 && !stoppedSeen; i += 1) {
      const decision = await gate.ingest(frame(0.001));
      quietCalls += 1;
      expect(decision.forward).toHaveLength(1);
      stoppedSeen = decision.stopped;
    }
    expect(stoppedSeen).toBe(true);
    // 16 chunks of stop sustain plus the ~2-frame tail, all at 32 ms cadence.
    expect(quietCalls).toBeGreaterThanOrEqual(STOP_CALLS);
    expect(quietCalls).toBeLessThanOrEqual(STOP_CALLS + 4);

    const after = await gate.ingest(frame(0.001));
    expect(after.forward).toHaveLength(0);
    expect(after.stopped).toBe(false);
  });

  it("raises the start bar while the agent is speaking downlink (echo guard)", async () => {
    const guarded = new SpeechGate({
      engine: new ScriptedEngine([0.6]),
      config: vadConfig(),
    });
    guarded.setDownlinkActive(true);
    for (let i = 0; i < 8; i += 1) {
      expect((await guarded.ingest(frame(0.02))).started).toBe(false);
    }

    const confident = new SpeechGate({
      engine: new ScriptedEngine([0.8]),
      config: vadConfig(),
    });
    confident.setDownlinkActive(true);
    // 200 ms echo sustain at 32 ms per chunk needs 7 confirmed chunks.
    const { calls } = await startSpeech(confident);
    expect(calls).toBe(7);
  });

  it("keeps the echo guard armed briefly after downlink audio stops", async () => {
    const gate = new SpeechGate({
      engine: new ScriptedEngine([0.6]),
      config: vadConfig(),
    });
    gate.setDownlinkActive(true);
    await gate.ingest(frame(0.02));
    gate.setDownlinkActive(false);
    // The 300 ms hold (minus the 50 ms already consumed) still blocks 0.6.
    for (let i = 0; i < 4; i += 1) {
      expect((await gate.ingest(frame(0.02))).started).toBe(false);
    }
  });

  it("treats a mid-speech frame gap as confirmed silence and emits stopped without a tail", async () => {
    let clock = 1_000;
    const gate = new SpeechGate({
      engine: new ScriptedEngine([SPEECH]),
      config: vadConfig(),
      now: () => clock,
    });
    await startSpeech(gate);

    clock += 2_000; // client pre-gate closed mid-speech
    const resumed = await gate.ingest(frame(0.001));
    expect(resumed.stopped).toBe(true);
    expect(resumed.forward).toHaveLength(0);
  });

  it("expires an open speech turn when frames stop arriving entirely", async () => {
    vi.useFakeTimers();
    try {
      const expired = vi.fn();
      const gate = new SpeechGate({
        engine: new ScriptedEngine([SPEECH]),
        config: vadConfig(),
        onSpeechExpired: expired,
      });
      await startSpeech(gate);

      vi.advanceTimersByTime(500 + 400 + 250 + 100);
      expect(expired).toHaveBeenCalledTimes(1);

      // A late frame starts a fresh detection cycle instead of resuming the expired turn.
      const late = await gate.ingest(frame(0.02));
      expect(late.started).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("streams every frame ungated in stream-through mode while still confirming speech", async () => {
    const gate = new SpeechGate({
      engine: new ScriptedEngine([QUIET_PROBABILITY, SPEECH]),
      config: vadConfig(),
      streamThrough: true,
    });
    const one = await gate.ingest(frame(0.001));
    expect(one.forward).toHaveLength(1);
    expect(one.started).toBe(false);
    const { calls, decision } = await startSpeech(gate);
    expect(calls).toBe(START_CALLS);
    expect(decision.forward).toHaveLength(1); // no preroll flush; everything already flows
  });

  it("resamples 24 kHz frames before scoring and forwards the original bytes", async () => {
    const engine = new ScriptedEngine([SPEECH]);
    const gate = new SpeechGate({ engine, config: vadConfig() });
    const source = frame(0.02, 24_000);
    for (let i = 0; i < START_CALLS; i += 1) {
      const decision = await gate.ingest(source);
      if (decision.started) {
        // 50 ms at 24 kHz resamples to 800 samples at 16 kHz.
        expect(engine.fed[0]).toHaveLength(800);
        for (const forwarded of decision.forward) {
          expect(forwarded.mimeType).toBe("audio/pcm;rate=24000");
        }
        return;
      }
    }
    throw new Error("Expected speech to confirm within the sustain window.");
  });

  it("bounds the preroll ring to the configured budget", async () => {
    const warm = new SpeechGate({
      engine: new ScriptedEngine([...repeating(6, QUIET_PROBABILITY), SPEECH]),
      config: vadConfig({ prerollMs: 100 }),
    });
    for (let i = 0; i < 6; i += 1) await warm.ingest(frame(0.02));
    const { decision: started } = await startSpeech(warm);
    expect(started.started).toBe(true);
    // 100 ms preroll budget keeps the ring near ~3 frames plus the trigger.
    expect(started.forward.length).toBeLessThanOrEqual(4);
  });
});

describe("energy probability engine", () => {
  it("maps loud chunks to 1 and quiet chunks to 0 at the chunk cadence", async () => {
    const engine = new EnergyProbabilityEngine({ threshold: 0.012 });
    const loud = new Float32Array(512 + 512);
    loud.fill(0.2);
    expect(await engine.score(loud)).toEqual([1, 1]);

    const quiet = new Float32Array(512);
    quiet.fill(0.001);
    expect(await engine.score(quiet)).toEqual([0]);
  });

  it("drives the gate end to end like the legacy browser VAD", async () => {
    const gate = new SpeechGate({
      engine: new EnergyProbabilityEngine({ threshold: 0.012 }),
      config: vadConfig(),
    });
    await gate.ingest(frame(0.001));
    const { calls } = await startSpeech(gate, 0.05);
    expect(calls).toBeLessThanOrEqual(8);
  });
});
