/** Port for gateway-side speech synthesis (the TTS sidecar). */

export interface SpeechSinkFrame {
  data: string;
  mimeType: string;
  final: boolean;
}

export type SpeechSinkOutcome = "spoken" | "failed" | "aborted";

export interface SpeechSink {
  /** False while the sink is in a failure cooldown. */
  readonly healthy: boolean;
  /** Synthesizes text and streams aligned PCM frames; abortable. */
  speak(
    text: string,
    handlers: { onFrame: (frame: SpeechSinkFrame) => void; signal: AbortSignal },
  ): Promise<SpeechSinkOutcome>;
}
