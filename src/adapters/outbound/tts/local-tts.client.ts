import type { AppConfig } from "../../../config.js";
import { errorToMessage } from "../../../domain/error-message.js";
import type { SpeechSink, SpeechSinkFrame, SpeechSinkOutcome } from "../../../application/live-gateway/ports/speech-sink.port.js";

// HTTP client for the gateway TTS sidecar (services/tts-sidecar): the same
// Qwen3-TTS GGML engine and speaker as the speech-to-speech stack, exposed as
// a streaming PCM endpoint. Speech through this path costs the provider LLM
// nothing and keeps working when the provider pipeline is stalled or dead.

/** PCM rate the provider's realtime boundary publishes (24 kHz PCM16 mono). */
export const SIDECAR_SAMPLE_RATE = 24_000;
const SIDECAR_MIME_TYPE = `audio/pcm;rate=${SIDECAR_SAMPLE_RATE}`;
/** Frames stay under the provider's per-frame audio size for smooth playback. */
export const SIDECAR_FRAME_BYTES = SIDECAR_SAMPLE_RATE * 2 * 100 / 1_000;
/** After a failure, the sidecar is left alone this long before retrying. */
const SIDECAR_COOLDOWN_MS = 60_000;


export interface SidecarTtsClientOptions {
  baseUrl: string;
  requestTimeoutMs: number;
  maxChars: number;
}

export class SidecarTtsClient implements SpeechSink {
  private readonly options: SidecarTtsClientOptions;
  private unhealthyUntil = 0;

  constructor(options: SidecarTtsClientOptions) {
    this.options = options;
  }

  get healthy(): boolean {
    return Date.now() >= this.unhealthyUntil;
  }

  async speak(
    text: string,
    handlers: { onFrame: (frame: SpeechSinkFrame) => void; signal: AbortSignal },
  ): Promise<SpeechSinkOutcome> {
    const bounded = text.trim().slice(0, this.options.maxChars);
    if (!bounded) return "spoken";
    const internal = new AbortController();
    const onCallerAbort = () => internal.abort(handlers.signal.reason);
    handlers.signal.addEventListener("abort", onCallerAbort, { once: true });
    // A hung synthesis must not wedge the speech queue: every chunk resets
    // the watchdog, and a silent stream aborts as a sidecar failure.
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const armStallWatchdog = () => {
      if (stallTimer !== undefined) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        internal.abort(new Error(`sidecar tts stream stalled for ${this.options.requestTimeoutMs}ms`));
      }, this.options.requestTimeoutMs);
      stallTimer.unref?.();
    };
    try {
      armStallWatchdog();
      const response = await fetch(`${this.options.baseUrl}/v1/tts`, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json", accept: "audio/pcm" },
        body: JSON.stringify({ text: bounded }),
        signal: internal.signal,
      });
      if (!response.ok || !response.body) {
        return this.fail(new Error(`sidecar tts responded ${response.status}`), handlers.signal);
      }
      const reader = response.body.getReader();
      let buffered = Buffer.alloc(0);
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        armStallWatchdog();
        // Align to 2-byte PCM16 samples before emitting any frame.
        buffered = buffered.length === 0
          ? Buffer.from(value)
          : Buffer.concat([buffered, Buffer.from(value)]);
        if (buffered.length < SIDECAR_FRAME_BYTES) continue;
        const evenBytes = buffered.length - (buffered.length % 2);
        for (let offset = 0; offset + SIDECAR_FRAME_BYTES <= evenBytes; offset += SIDECAR_FRAME_BYTES) {
          handlers.onFrame({
            data: buffered.subarray(offset, offset + SIDECAR_FRAME_BYTES).toString("base64"),
            mimeType: SIDECAR_MIME_TYPE,
            final: false,
          });
        }
        const consumed = evenBytes - (evenBytes % SIDECAR_FRAME_BYTES);
        buffered = buffered.subarray(consumed);
      }
      if (buffered.length >= 2) {
        const padded = buffered.length % 2 === 0
          ? buffered
          : Buffer.concat([buffered, Buffer.alloc(1)]);
        handlers.onFrame({
          data: padded.toString("base64"),
          mimeType: SIDECAR_MIME_TYPE,
          final: true,
        });
      }
      return "spoken";
    } catch (error) {
      return this.fail(error, handlers.signal);
    } finally {
      handlers.signal.removeEventListener("abort", onCallerAbort);
      if (stallTimer !== undefined) clearTimeout(stallTimer);
    }
  }

  private fail(error: unknown, signal: AbortSignal): SpeechSinkOutcome {
    if (signal.aborted || (error instanceof Error && error.name === "AbortError")) return "aborted";
    this.unhealthyUntil = Date.now() + SIDECAR_COOLDOWN_MS;
    return "failed";
  }
}

export function sidecarTtsClientFromConfig(config: AppConfig): SidecarTtsClient | undefined {
  if (!config.tts.baseUrl) return undefined;
  return new SidecarTtsClient({
    baseUrl: config.tts.baseUrl,
    requestTimeoutMs: config.tts.requestTimeoutMs,
    maxChars: config.tts.maxChars,
  });
}

/** Re-exported for callers that log sidecar failures. */
export function sidecarErrorMessage(error: unknown): string {
  return errorToMessage(error);
}
