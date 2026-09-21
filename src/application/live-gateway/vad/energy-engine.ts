import { SILERO_VAD_SAMPLE_RATE, type SpeechProbabilityEngine } from "./speech-gate.js";

const CHUNK_SAMPLES = 512;
const DEFAULT_THRESHOLD = 0.012;

function chunkProbability(chunk: Float32Array, threshold: number): number {
  let energy = 0;
  for (let i = 0; i < chunk.length; i += 1) {
    energy += chunk[i] * chunk[i];
  }
  const level = Math.sqrt(energy / Math.max(1, chunk.length));
  return level >= threshold ? 1 : 0;
}

/**
 * Dependency-free fallback engine: binary per-chunk RMS loudness at the same
 * 32 ms chunk cadence as Silero. All temporal behavior (sustain, hangover,
 * hysteresis) comes from the SpeechGate config; the threshold mirrors the
 * browser client's legacy PcmVoiceActivityDetector.
 */
export class EnergyProbabilityEngine implements SpeechProbabilityEngine {
  private readonly threshold: number;

  constructor(options: { threshold?: number } = {}) {
    this.threshold = options.threshold ?? DEFAULT_THRESHOLD;
  }

  reset(): void {
    // Stateless per chunk; nothing to reset.
  }

  async score(samples: Float32Array): Promise<number[]> {
    if (samples.length === 0) return [];
    const probabilities: number[] = [];
    for (let offset = 0; offset < samples.length; offset += CHUNK_SAMPLES) {
      const remaining = samples.length - offset;
      if (remaining < CHUNK_SAMPLES && probabilities.length > 0) break;
      probabilities.push(chunkProbability(samples.subarray(offset), this.threshold));
    }
    return probabilities;
  }
}

export const ENERGY_CHUNK_SAMPLES = CHUNK_SAMPLES;
export const ENERGY_SAMPLE_RATE = SILERO_VAD_SAMPLE_RATE;
