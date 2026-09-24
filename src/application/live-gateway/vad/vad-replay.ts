import type { VadConfig } from "../../../config.js";
import { requirePcmSampleRate, type PcmAudioFrame } from "../../../domain/audio/pcm.js";
import { SpeechGate, type SpeechProbabilityEngine } from "./speech-gate.js";

// Offline endpointing replay: feed a recorded session's exact gate inputs
// (frames at their arrival times, downlink changes, resets) through a real
// SpeechGate with candidate settings on a virtual clock, and measure what the
// user would have experienced. Same gate code, same engine, same audio — only
// the settings differ, so candidates are directly comparable.

/** A new turn starting this soon after a stop means the stop cut the user off. */
export const SPLIT_WINDOW_MS = 1_500;
/** Chunk probability that counts as the user actually speaking. */
const VOICED_PROBABILITY = 0.5;

export interface RecordedFrameEvent {
  type: "frame";
  t: number;
  mimeType: string;
  offset: number;
  length: number;
  started?: boolean;
  stopped?: boolean;
}
export type RecordedEvent =
  | RecordedFrameEvent
  | { type: "downlink"; t: number; active: boolean; holdMs: number }
  | { type: "reset"; t: number }
  | { type: "expired"; t: number }
  | { type: "user_final"; t: number; text: string; fromVoice: boolean }
  | { type: "echo_dropped"; t: number; text: string }
  | { type: "response_started"; t: number; scope?: string };

export interface VadRecording {
  sessionId: string;
  startedAt: number;
  /** Settings the session was recorded with (the live baseline). */
  vad: VadConfig;
  events: RecordedEvent[];
  audio: Buffer;
}

export interface ReplayMetrics {
  /** Turns the gate opened. */
  turns: number;
  /** Stops followed by a new start within SPLIT_WINDOW_MS: likely cut-offs. */
  splitTurns: number;
  /** Per stop: last voiced audio → stop decision, the silence the user waited. */
  silenceWaitsMs: number[];
  /** Voiced audio that never reached the provider (lost words). */
  clippedVoicedMs: number;
  voicedMs: number;
  /** Turns opened while assistant audio was playing (echo / barge-in risk). */
  downlinkStarts: number;
  /** Decisions the live gate made, for checking a baseline replay reproduces them. */
  recordedStarts: number;
  recordedStops: number;
}

interface VirtualTimer {
  id: number;
  due: number;
  callback: () => void;
}

export async function replayRecording(
  recording: VadRecording,
  config: VadConfig,
  engine: SpeechProbabilityEngine,
): Promise<ReplayMetrics> {
  let now = 0;
  let nextTimerId = 1;
  const timers: VirtualTimer[] = [];
  const metrics: ReplayMetrics = {
    turns: 0, splitTurns: 0, silenceWaitsMs: [], clippedVoicedMs: 0, voicedMs: 0,
    downlinkStarts: 0, recordedStarts: 0, recordedStops: 0,
  };
  let downlink = false;
  let speaking = false;
  let lastVoicedAt: number | undefined;
  let lastStopAt: number | undefined;
  const voicedFrames = new Map<PcmAudioFrame, number>();
  const forwardedFrames = new Set<PcmAudioFrame>();

  const onStart = (at: number) => {
    metrics.turns += 1;
    if (downlink) metrics.downlinkStarts += 1;
    if (lastStopAt !== undefined && at - lastStopAt <= SPLIT_WINDOW_MS) metrics.splitTurns += 1;
    speaking = true;
    lastVoicedAt = undefined;
  };
  const onStop = (at: number) => {
    if (!speaking) return;
    speaking = false;
    lastStopAt = at;
    if (lastVoicedAt !== undefined) metrics.silenceWaitsMs.push(Math.max(0, at - lastVoicedAt));
  };

  // The gate's observer hands back each frame's chunk probabilities.
  let frameScores: readonly number[] = [];
  engine.reset();
  const gate = new SpeechGate({
    engine,
    config,
    now: () => now,
    observer: { onIngest: (record) => { frameScores = record.probabilities; } },
    scheduler: {
      setTimeout(callback, delayMs) {
        const timer = { id: nextTimerId++, due: now + delayMs, callback };
        timers.push(timer);
        return timer.id;
      },
      clearTimeout(handle) {
        const index = timers.findIndex((timer) => timer.id === handle);
        if (index >= 0) timers.splice(index, 1);
      },
    },
    onSpeechExpired: () => onStop(now),
  });

  const advanceTo = (t: number) => {
    for (;;) {
      timers.sort((a, b) => a.due - b.due || a.id - b.id);
      const due = timers[0];
      if (!due || due.due > t) break;
      timers.shift();
      now = due.due;
      due.callback();
    }
    now = Math.max(now, t);
  };

  for (const event of recording.events) {
    advanceTo(event.t);
    switch (event.type) {
      case "downlink":
        downlink = event.active;
        gate.setDownlinkActive(event.active, event.holdMs);
        break;
      case "reset":
        gate.reset();
        speaking = false;
        break;
      case "frame": {
        if (event.started) metrics.recordedStarts += 1;
        if (event.stopped) metrics.recordedStops += 1;
        if (event.offset < 0) continue; // audio past the per-session budget
        const frame: PcmAudioFrame = {
          data: recording.audio.subarray(event.offset, event.offset + event.length).toString("base64"),
          mimeType: event.mimeType,
        };
        const frameMs = (event.length / 2) * 1_000 / requirePcmSampleRate(event.mimeType);
        const decision = await gate.ingest(frame);
        const voiced = frameScores.some((probability) => probability >= VOICED_PROBABILITY);
        if (decision.started) onStart(now);
        for (const forwarded of decision.forward) forwardedFrames.add(forwarded);
        if (voiced) {
          voicedFrames.set(frame, frameMs);
          metrics.voicedMs += frameMs;
          if (speaking) lastVoicedAt = now;
        }
        if (decision.stopped) onStop(now);
        break;
      }
      default:
        break;
    }
  }
  // Let a trailing expiry fire: the stream simply ended.
  advanceTo(now + 60_000);
  for (const [frame, ms] of voicedFrames) {
    if (!forwardedFrames.has(frame)) metrics.clippedVoicedMs += ms;
  }
  return metrics;
}

export interface CandidateSummary {
  label: string;
  config: VadConfig;
  turns: number;
  splitTurns: number;
  splitRate: number;
  silenceWaitP50Ms: number | null;
  silenceWaitP95Ms: number | null;
  clippedVoicedMs: number;
  downlinkStarts: number;
}

/** Sum per-session metrics into one comparable row per candidate. */
export function summarizeCandidate(label: string, config: VadConfig, runs: readonly ReplayMetrics[]): CandidateSummary {
  const waits = runs.flatMap((run) => run.silenceWaitsMs).sort((a, b) => a - b);
  const turns = runs.reduce((sum, run) => sum + run.turns, 0);
  const splitTurns = runs.reduce((sum, run) => sum + run.splitTurns, 0);
  const pick = (quantile: number) => waits.length
    ? waits[Math.min(waits.length - 1, Math.floor(quantile * (waits.length - 1)))]!
    : null;
  return {
    label,
    config,
    turns,
    splitTurns,
    splitRate: turns ? splitTurns / turns : 0,
    silenceWaitP50Ms: pick(0.5),
    silenceWaitP95Ms: pick(0.95),
    clippedVoicedMs: Math.round(runs.reduce((sum, run) => sum + run.clippedVoicedMs, 0)),
    downlinkStarts: runs.reduce((sum, run) => sum + run.downlinkStarts, 0),
  };
}
