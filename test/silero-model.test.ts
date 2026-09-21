import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { resamplePcm16Samples, decodePcm16Base64 } from "../src/domain/audio/pcm.js";
import { SileroProbabilityEngine, SILERO_CHUNK_SAMPLES, type OrtVadModel } from "../src/application/live-gateway/vad/silero-engine.js";
import { loadSileroModel, resolveSileroModelPath, resetSileroModelCache } from "../src/application/live-gateway/vad/silero-model.js";
import type { Logger } from "../src/logger.js";

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const MODEL_PATH = resolveSileroModelPath();
const modelAvailable = existsSync(MODEL_PATH);

/** Fake OrtVadModel that records calls and returns a canned probability. */
function fakeModel(probability = 0.9) {
  const calls: Array<{ input: Float32Array; state: Float32Array }> = [];
  let state = new Float32Array(256).fill(0.01);
  const model: OrtVadModel = {
    async scoreChunk(input, currentState) {
      calls.push({ input: Float32Array.from(input), state: Float32Array.from(currentState) });
      state = state.map((value, index) => value + index + 1);
      return { probability, state: Float32Array.from(state) };
    },
  };
  return { model, calls };
}

describe("silero probability engine", () => {
  it("feeds 64-sample context + 512-sample chunks and carries state between calls", async () => {
    const { model, calls } = fakeModel();
    const engine = new SileroProbabilityEngine(model);

    const first = new Float32Array(SILERO_CHUNK_SAMPLES).fill(0.1);
    const probs1 = await engine.score(first);
    expect(probs1).toEqual([0.9]);
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toHaveLength(576);
    // Fresh engine starts with a zeroed context.
    expect(Array.from(calls[0].input.slice(0, 64)).every((v) => v === 0)).toBe(true);
    expect(Array.from(calls[0].input.slice(64))).toEqual(Array.from(first));
    expect(calls[0].state.every((v) => v === 0)).toBe(true);

    const second = new Float32Array(SILERO_CHUNK_SAMPLES).fill(0.2);
    await engine.score(second);
    expect(calls).toHaveLength(2);
    // The next context is the tail of the previous chunk, and state round-trips.
    expect(Array.from(calls[1].input.slice(0, 64))).toEqual(Array.from(second).slice(0, 0).concat(Array.from(first).slice(SILERO_CHUNK_SAMPLES - 64)));
    expect(calls[1].state).toEqual(Float32Array.from({ length: 256 }, (_, index) => 0.01 + index + 1));
  });

  it("buffers sub-chunk residuals across score calls at the documented cadence", async () => {
    const { model, calls } = fakeModel();
    const engine = new SileroProbabilityEngine(model);
    // 800-sample frames (50 ms at 16 kHz) produce 1, 2, 1, 2, ... chunks:
    // the residual re-aligns every 16 frames (800 * 16 = 512 * 25).
    const pattern: number[] = [];
    for (let frame = 0; frame < 16; frame += 1) {
      const probs = await engine.score(new Float32Array(800).fill(0.05));
      pattern.push(probs.length);
    }
    expect(pattern.slice(0, 4)).toEqual([1, 2, 1, 2]);
    expect(pattern.reduce((total, chunks) => total + chunks, 0)).toBe(25);
    expect(calls).toHaveLength(25);
  });

  it("reset() clears context and state so detection restarts cold", async () => {
    const { model, calls } = fakeModel();
    const engine = new SileroProbabilityEngine(model);
    await engine.score(new Float32Array(SILERO_CHUNK_SAMPLES).fill(0.3));
    engine.reset();
    await engine.score(new Float32Array(SILERO_CHUNK_SAMPLES).fill(0.3));
    expect(calls[1].input.slice(0, 64).every((v) => v === 0)).toBe(true);
    expect(calls[1].state.every((v) => v === 0)).toBe(true);
  });
});

describe("silero model loader", () => {
  it("falls back to undefined when the model file is missing", async () => {
    resetSileroModelCache();
    const missing = await loadSileroModel({ modelPath: "/nonexistent/silero_vad.onnx", logger });
    expect(missing).toBeUndefined();
    resetSileroModelCache();
  });

  it("rejects relative model paths", () => {
    expect(() => resolveSileroModelPath("models/silero_vad.onnx")).toThrow(/absolute path/u);
  });
});

describe.skipIf(!modelAvailable)("vendored silero model", () => {
  it("separates the bundled e2e speech fixture from silence", async () => {
    const model = await loadSileroModel({ logger });
    expect(model).toBeDefined();

    const wav = await readFile("test/fixtures/hello.wav");
    const pcmChunk = wav.indexOf("data");
    const pcmBytes = wav.subarray(pcmChunk + 8, wav.length);
    const samples = decodePcm16Base64(pcmBytes.toString("base64"));
    const audio16k = resamplePcm16Samples(samples, 24_000, 16_000);

    const engine = new SileroProbabilityEngine(model!);
    const probabilities: number[] = [];
    for (let offset = 0; offset + SILERO_CHUNK_SAMPLES <= audio16k.length; offset += SILERO_CHUNK_SAMPLES) {
      const probs = await engine.score(audio16k.subarray(offset, offset + SILERO_CHUNK_SAMPLES));
      probabilities.push(...probs);
    }
    expect(probabilities.length).toBeGreaterThan(100);
    const speech = probabilities.filter((p) => p >= 0.5);
    expect(speech.length).toBeGreaterThan(20);
    expect(Math.max(...probabilities)).toBeGreaterThan(0.7);
    // The leading silence of the fixture must not look like speech.
    expect(Math.max(...probabilities.slice(0, 20))).toBeLessThan(0.3);
  }, 30_000);
});
