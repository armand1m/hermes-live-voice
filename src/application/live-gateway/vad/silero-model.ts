import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "../../../logger.js";
import type { OrtVadModel } from "./silero-engine.js";

// Non-literal specifier so TypeScript never resolves the optional dependency.
const ORT_MODULE_ID = "onnxruntime-node";
const SILERO_INPUT_SAMPLES = 576;
const SILERO_STATE_SAMPLES = 2 * 1 * 128;

/** Structural shape of the onnxruntime-node surface this module uses. */
interface OrtSession {
  run(feeds: Record<string, unknown>): Promise<{
    output: { data: ArrayLike<number> };
    stateN: { data: ArrayLike<number> };
  }>;
}

interface OrtModule {
  Tensor: new (
    type: "float32" | "int64",
    data: Float32Array | BigInt64Array,
    dims: readonly number[],
  ) => unknown;
  InferenceSession: {
    create(model: Buffer, options: Record<string, unknown>): Promise<OrtSession>;
  };
}

let modelPromise: Promise<OrtVadModel | undefined> | undefined;

/** Test hook: forget the cached model so the next load re-runs. */
export function resetSileroModelCache(): void {
  modelPromise = undefined;
}

export function resolveSileroModelPath(modelPath?: string): string {
  if (modelPath) {
    if (!isAbsolute(modelPath)) {
      throw new Error("HERMES_LIVE_VAD_MODEL must be an absolute path.");
    }
    return modelPath;
  }
  return fileURLToPath(new URL("../../../../assets/models/silero_vad.onnx", import.meta.url));
}

/**
 * Loads the vendored Silero VAD v5 model once per process. Returns undefined
 * (with a warning) when onnxruntime-node or the model file is unavailable so
 * callers can fall back to the energy engine.
 */
export function loadSileroModel(options: { modelPath?: string; logger: Logger }): Promise<OrtVadModel | undefined> {
  if (!modelPromise) {
    modelPromise = createSileroModel(options).catch((error: unknown) => {
      options.logger.warn("silero vad unavailable, falling back to energy detection", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    });
  }
  return modelPromise;
}

async function createSileroModel(options: { modelPath?: string; logger: Logger }): Promise<OrtVadModel | undefined> {
  const modelPath = resolveSileroModelPath(options.modelPath);
  if (!existsSync(modelPath)) {
    options.logger.warn("silero vad model file missing, falling back to energy detection", { modelPath });
    return undefined;
  }

  const ort = await import(ORT_MODULE_ID) as unknown as OrtModule;
  const modelBytes = await readFile(modelPath);
  const session = await ort.InferenceSession.create(modelBytes, {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
    intraOpNumThreads: 1,
  });

  return {
    async scoreChunk(input576: Float32Array, state: Float32Array): Promise<{ probability: number; state: Float32Array }> {
      if (input576.length !== SILERO_INPUT_SAMPLES) {
        throw new Error(`Silero input chunk must hold ${SILERO_INPUT_SAMPLES} samples.`);
      }
      if (state.length !== SILERO_STATE_SAMPLES) {
        throw new Error(`Silero state must hold ${SILERO_STATE_SAMPLES} samples.`);
      }
      const outputs = await session.run({
        input: new ort.Tensor("float32", input576, [1, SILERO_INPUT_SAMPLES]),
        state: new ort.Tensor("float32", state, [2, 1, 128]),
        sr: new ort.Tensor("int64", BigInt64Array.of(16_000n), []),
      });
      return {
        probability: outputs.output.data[0],
        state: Float32Array.from(outputs.stateN.data),
      };
    },
  };
}
