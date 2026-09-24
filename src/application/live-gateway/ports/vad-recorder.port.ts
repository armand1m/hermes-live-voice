import type { VadConfig } from "../../../config.js";
import type { SpeechGateObserver } from "../vad/speech-gate.js";

/** Session context recorded next to gate inputs, used to label turns offline. */
export type VadContextEvent =
  | { type: "user_final"; text: string; fromVoice: boolean }
  | { type: "echo_dropped"; text: string }
  | { type: "response_started"; scope?: string };

/** One voice session's recording: the gate observer plus context notes. */
export interface VadSessionRecording {
  readonly observer: SpeechGateObserver;
  note(event: VadContextEvent): void;
  close(): Promise<void>;
}

/**
 * Opt-in local recorder of what the speech gate heard, for offline endpointing
 * tuning (`hermes-live-voice vad replay`). Returns undefined when a session
 * cannot be recorded (budget exhausted, directory unwritable).
 */
export interface VadRecorderPort {
  start(sessionId: string, vad: VadConfig): VadSessionRecording | undefined;
}
