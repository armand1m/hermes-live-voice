import type { SpeechProbabilityEngine } from "./speech-gate.js";

/** Minimal contract over a loaded Silero ONNX session (kept ORT-type free). */
export interface OrtVadModel {
  /**
   * Scores one 512-sample chunk at 16 kHz. `input576` is the 64-sample
   * rolling context prepended to the chunk; `state` is the [2, 1, 128]
   * recurrent state carried between calls.
   */
  scoreChunk(input576: Float32Array, state: Float32Array): Promise<{ probability: number; state: Float32Array }>;
}

const CONTEXT_SAMPLES = 64;
const CHUNK_SAMPLES = 512;
const STATE_SAMPLES = 2 * 1 * 128;

/** Streaming Silero v5 wrapper: chunk buffering, context rotation, and state carry. */
export class SileroProbabilityEngine implements SpeechProbabilityEngine {
  private readonly model: OrtVadModel;
  private state: Float32Array = new Float32Array(STATE_SAMPLES);
  private context: Float32Array = new Float32Array(CONTEXT_SAMPLES);
  private residual: Float32Array = new Float32Array(0);

  constructor(model: OrtVadModel) {
    this.model = model;
  }

  reset(): void {
    this.state = new Float32Array(STATE_SAMPLES);
    this.context = new Float32Array(CONTEXT_SAMPLES);
    this.residual = new Float32Array(0);
  }

  async score(samples: Float32Array): Promise<number[]> {
    if (this.residual.length > 0) {
      const merged = new Float32Array(this.residual.length + samples.length);
      merged.set(this.residual, 0);
      merged.set(samples, this.residual.length);
      this.residual = merged;
    } else {
      this.residual = samples.slice();
    }

    const probabilities: number[] = [];
    while (this.residual.length >= CHUNK_SAMPLES) {
      const chunk = this.residual.subarray(0, CHUNK_SAMPLES);
      const input = new Float32Array(CONTEXT_SAMPLES + CHUNK_SAMPLES);
      input.set(this.context, 0);
      input.set(chunk, CONTEXT_SAMPLES);
      const result = await this.model.scoreChunk(input, this.state);
      this.state = result.state;
      this.context = Float32Array.from(chunk.subarray(chunk.length - CONTEXT_SAMPLES));
      probabilities.push(result.probability);
      this.residual = this.residual.slice(CHUNK_SAMPLES);
    }
    return probabilities;
  }
}

export const SILERO_CHUNK_SAMPLES = CHUNK_SAMPLES;
export const SILERO_CONTEXT_SAMPLES = CONTEXT_SAMPLES;
