import type { SpeechSink } from "./ports/speech-sink.port.js";

// Speech mux: serializes gateway-side TTS utterances (sidecar-synthesized)
// into the client audio stream. Utterances queue in order, one speaks at a
// time, and abort() stops the in-flight utterance and drops the queue —
// barge-in and provider speech always win. The mux never speaks over anyone:
// callers gate what may start; abort handles what must stop.

export type SpeechMuxEmit =
  | { kind: "audio"; data: string; mimeType: string; final: boolean }
  | { kind: "transcript"; text: string };

export type SpeechMuxOutcome = "spoken" | "aborted" | "skipped" | "failed" | "unavailable";

interface QueuedUtterance {
  text: string;
  immediate: boolean;
  resolve: (outcome: SpeechMuxOutcome) => void;
}

export interface SpeechMuxOptions {
  client: SpeechSink;
  emit: (message: SpeechMuxEmit) => void;
  /** Asked before a non-immediate utterance starts; false defers it briefly. */
  gate: () => boolean;
  /** Called when sidecar speech starts and stops (echo guard bookkeeping). */
  onSpeakingChange?: (speaking: boolean) => void;
  /** Diagnostics for sidecar failures; speech silently falls back. */
  onUnavailable?: (error: string) => void;
}

const GATE_RETRY_MS = 500;
const MAX_GATE_RETRIES = 40;

export class SpeechMux {
  private readonly options: SpeechMuxOptions;
  private readonly queue: QueuedUtterance[] = [];
  private pumping = false;
  private activeAbort?: AbortController;
  private aborted = false;

  constructor(options: SpeechMuxOptions) {
    this.options = options;
  }

  get speaking(): boolean {
    return this.activeAbort !== undefined;
  }

  /** True when the sidecar is currently considered healthy. */
  get available(): boolean {
    return this.options.client.healthy;
  }

  /**
   * Speak one utterance through the sidecar. Immediate utterances (receipts)
   * bypass the gate but never barge-in protection: abort() still silences
   * them mid-frame.
   */
  speak(text: string, options: { immediate?: boolean } = {}): Promise<SpeechMuxOutcome> {
    if (!text.trim()) return Promise.resolve("spoken");
    if (!this.options.client.healthy) return Promise.resolve("unavailable");
    this.aborted = false;
    return new Promise<SpeechMuxOutcome>((resolve) => {
      this.queue.push({ text: text.trim(), immediate: options.immediate === true, resolve });
      void this.pump();
    });
  }

  /** Stop the in-flight utterance and drop everything queued. */
  abort(): void {
    this.aborted = true;
    this.activeAbort?.abort(new Error("speech mux aborted"));
    for (const utterance of this.queue.splice(0)) utterance.resolve("aborted");
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0 && !this.aborted) {
        const utterance = this.queue[0]!;
        if (!utterance.immediate) {
          let allowed = false;
          for (let attempt = 0; attempt < MAX_GATE_RETRIES; attempt += 1) {
            if (this.aborted) break;
            if (this.options.gate()) {
              allowed = true;
              break;
            }
            await delay(GATE_RETRY_MS);
          }
          if (!allowed) {
            this.queue.shift()!.resolve("skipped");
            continue;
          }
        }
        if (this.aborted) break;
        this.queue.shift();
        const outcome = await this.speakUtterance(utterance.text);
        utterance.resolve(outcome);
      }
    } finally {
      this.pumping = false;
    }
    // Utterances queued while the pump was draining still get their turn.
    if (this.queue.length > 0 && !this.aborted) void this.pump();
  }

  private async speakUtterance(text: string): Promise<SpeechMuxOutcome> {
    const controller = new AbortController();
    this.activeAbort = controller;
    this.options.onSpeakingChange?.(true);
    this.options.emit({ kind: "transcript", text });
    try {
      return await this.options.client.speak(text, {
        signal: controller.signal,
        onFrame: (frame) => this.options.emit({
          kind: "audio",
          data: frame.data,
          mimeType: frame.mimeType,
          final: frame.final,
        }),
      });
    } finally {
      this.activeAbort = undefined;
      this.options.onSpeakingChange?.(false);
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
