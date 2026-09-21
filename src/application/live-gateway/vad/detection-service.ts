import type { AppConfig } from "../../../config.js";
import type { Logger } from "../../../logger.js";
import { EnergyProbabilityEngine } from "./energy-engine.js";
import { SileroProbabilityEngine } from "./silero-engine.js";
import { loadSileroModel } from "./silero-model.js";
import { SpeechGate, type SpeechGateOptions } from "./speech-gate.js";

export type SpeechDetectionEngineName = "silero" | "energy";

export interface SpeechDetectionService {
  /** Engine new gates will use once the model resolves. */
  readonly engine: SpeechDetectionEngineName;
  /** Starts loading the Silero model in the background (no-op for energy). */
  prewarm(): Promise<void>;
  /** Creates a per-session speech gate once the engine is ready. */
  createGate(options?: Omit<SpeechGateOptions, "engine" | "config">): Promise<SpeechGate>;
}

/**
 * Process-wide speech detection factory. Silero (the default) loads a small
 * ONNX model; when the runtime or model is unavailable the service degrades
 * to the dependency-free energy engine without failing sessions.
 */
export function createSpeechDetectionService(config: AppConfig, logger: Logger): SpeechDetectionService {
  const modelReady = config.vad.engine === "smart"
    ? loadSileroModel({ modelPath: config.vad.modelPath, logger })
    : Promise.resolve(undefined);
  let resolvedEngine: SpeechDetectionEngineName | undefined;
  let engineReady: Promise<SpeechDetectionEngineName> | undefined;

  const service: SpeechDetectionService = {
    get engine(): SpeechDetectionEngineName {
      return resolvedEngine ?? (config.vad.engine === "energy" ? "energy" : "silero");
    },
    async prewarm(): Promise<void> {
      await resolveEngine();
    },
    async createGate(options): Promise<SpeechGate> {
      const engineName = await resolveEngine();
      const model = engineName === "silero" ? await modelReady : undefined;
      const engine = model
        ? new SileroProbabilityEngine(model)
        : new EnergyProbabilityEngine();
      return new SpeechGate({ ...options, engine, config: config.vad });
    },
  };

  async function resolveEngine(): Promise<SpeechDetectionEngineName> {
    if (config.vad.engine === "energy") return "energy";
    if (!engineReady) {
      engineReady = modelReady.then((model) => {
        resolvedEngine = model ? "silero" : "energy";
        return resolvedEngine;
      });
    }
    return engineReady;
  }

  return service;
}
