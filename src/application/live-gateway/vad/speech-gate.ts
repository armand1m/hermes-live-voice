import type { VadConfig } from "../../../config.js";
import {
  decodePcm16Base64,
  requirePcmSampleRate,
  resamplePcm16Samples,
  type PcmAudioFrame,
} from "../../../domain/audio/pcm.js";

export const SILERO_VAD_SAMPLE_RATE = 16_000;
const SPEECH_CHUNK_SAMPLES = 512;
const SPEECH_CHUNK_MS = SPEECH_CHUNK_SAMPLES * 1_000 / SILERO_VAD_SAMPLE_RATE;
/** Keeps the raised echo threshold armed briefly after downlink audio stops. */
const ECHO_GUARD_HOLD_MS = 300;
/** Slack before a frame gap is treated as confirmed silence while speech is active. */
const FRAME_GAP_SLACK_MS = 250;

export interface SpeechProbabilityEngine {
  reset(): void;
  /** Scores 16 kHz mono samples; resolves one probability per 512-sample chunk consumed. */
  score(samples: Float32Array): Promise<number[]>;
}

export interface GateDecision {
  /** Original frames to forward to the realtime provider, in order. */
  forward: PcmAudioFrame[];
  /** Confirmed speech started on this frame (emit before forwarding). */
  started: boolean;
  /** Confirmed speech stopped after this frame's tail drained (emit after forwarding). */
  stopped: boolean;
  /** Speech probability at the moment speech was confirmed. */
  probability?: number;
}

/**
 * Everything the gate consumed and decided, in order — enough to replay the
 * exact same inputs through a gate with different settings (VAD tuning).
 */
export interface SpeechGateObserver {
  onDownlink?(active: boolean, holdMs: number, at: number): void;
  onIngest?(record: {
    at: number;
    frame: PcmAudioFrame;
    /** One speech probability per 32 ms chunk scored from this frame. */
    probabilities: readonly number[];
    started: boolean;
    stopped: boolean;
    forwarded: number;
  }): void;
  onReset?(at: number): void;
  onExpired?(at: number): void;
}

/** Timer seam: live gates use real timers, replays a virtual clock. */
export interface SpeechGateScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SpeechGateOptions {
  engine: SpeechProbabilityEngine;
  config: VadConfig;
  /** Forward every frame ungated (semantic VAD streaming) while still emitting speech events. */
  streamThrough?: boolean;
  /** Invoked when active speech expires without further frames (no ingest can report it). */
  onSpeechExpired?: () => void;
  now?: () => number;
  observer?: SpeechGateObserver;
  scheduler?: SpeechGateScheduler;
}

const REAL_TIMERS: SpeechGateScheduler = {
  setTimeout(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    handle.unref?.();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

interface PrerollEntry {
  frame: PcmAudioFrame;
  ms: number;
}

/**
 * Gateway-side speech gate: turns a stream of client audio frames into
 * confirmed speech start/stop decisions plus the exact frames the realtime
 * provider should see. While speech is unconfirmed, frames accumulate in a
 * short preroll ring so the first phoneme survives detection latency.
 */
export class SpeechGate {
  private readonly engine: SpeechProbabilityEngine;
  private readonly config: VadConfig;
  private readonly streamThrough: boolean;
  private readonly onSpeechExpired?: () => void;
  private readonly now: () => number;
  private readonly observer: SpeechGateObserver | undefined;
  private readonly scheduler: SpeechGateScheduler;

  private active = false;
  private startStreakMs = 0;
  private stopStreakMs = 0;
  private tailRemainingMs = 0;
  private downlink = false;
  private echoHoldMs = 0;
  private preroll: PrerollEntry[] = [];
  private lastFrameAt = 0;
  private expiryTimer: unknown;

  constructor(options: SpeechGateOptions) {
    this.engine = options.engine;
    this.config = options.config;
    this.streamThrough = options.streamThrough ?? false;
    this.onSpeechExpired = options.onSpeechExpired;
    this.now = options.now ?? (() => Date.now());
    this.observer = options.observer;
    this.scheduler = options.scheduler ?? REAL_TIMERS;
  }

  /** Arms or disarms the echo guard; agent audio playing down keeps it active. */
  setDownlinkActive(active: boolean, holdMs: number = ECHO_GUARD_HOLD_MS): void {
    this.observer?.onDownlink?.(active, holdMs, this.now());
    this.downlink = active;
    if (active) this.echoHoldMs = Math.max(this.echoHoldMs, holdMs);
  }

  async ingest(frame: PcmAudioFrame): Promise<GateDecision> {
    const receivedAt = this.now();
    this.lastProbabilities = [];
    const decision = await this.decide(frame, receivedAt);
    this.observer?.onIngest?.({
      at: receivedAt,
      frame,
      probabilities: this.lastProbabilities,
      started: decision.started,
      stopped: decision.stopped,
      forwarded: decision.forward.length,
    });
    return decision;
  }

  private lastProbabilities: number[] = [];

  private async decide(frame: PcmAudioFrame, receivedAt: number): Promise<GateDecision> {
    const sourceRate = requirePcmSampleRate(frame.mimeType);
    const samples = decodePcm16Base64(frame.data);
    const frameMs = samples.length * 1_000 / sourceRate;
    if (frameMs <= 0) {
      return { forward: this.streamThrough ? [frame] : [], started: false, stopped: false };
    }
    const gapMs = this.lastFrameAt === 0 ? 0 : receivedAt - this.lastFrameAt;
    this.lastFrameAt = receivedAt;
    if (!this.downlink) this.echoHoldMs = Math.max(0, this.echoHoldMs - frameMs);

    let started = false;
    let probability: number | undefined;
    let stopConfirmed = false;

    if (this.active && gapMs >= this.config.stopSustainMs + FRAME_GAP_SLACK_MS) {
      // The client pre-gate closed mid-speech: the missing audio was quiet, so
      // confirm the stop without queuing another silence tail.
      this.confirmStop(false);
      stopConfirmed = true;
    }

    const probabilities = await this.engine.score(resamplePcm16Samples(samples, sourceRate, SILERO_VAD_SAMPLE_RATE));
    this.lastProbabilities = probabilities;
    for (const probabilityAtChunk of probabilities) {
      if (!this.active) {
        const echoGuarded = this.downlink || this.echoHoldMs > 0;
        if (echoGuarded && this.config.halfDuplex) {
          // Half-duplex policy: while assistant audio is still draining (plus
          // the turn tail), confirmed speech never starts a turn — the mic
          // hearing the agent's own voice cannot become user speech. Frames
          // still score and preroll keeps rolling, so speech that continues
          // past the window starts a clean turn immediately.
          this.startStreakMs = 0;
          continue;
        }
        const threshold = echoGuarded ? this.config.echoStartProbability : this.config.startProbability;
        const sustainMs = echoGuarded ? this.config.echoStartSustainMs : this.config.startSustainMs;
        if (probabilityAtChunk >= threshold) {
          this.startStreakMs += SPEECH_CHUNK_MS;
          if (this.startStreakMs >= sustainMs) {
            this.active = true;
            started = true;
            probability = probabilityAtChunk;
            this.stopStreakMs = 0;
          }
        } else {
          this.startStreakMs = 0;
        }
      } else if (probabilityAtChunk <= this.config.stopProbability) {
        this.stopStreakMs += SPEECH_CHUNK_MS;
        if (this.stopStreakMs >= this.config.stopSustainMs) {
          this.confirmStop(true);
          stopConfirmed = true;
        }
      } else {
        this.stopStreakMs = 0;
      }
    }

    const decision: GateDecision = {
      forward: [],
      started,
      stopped: false,
      ...(probability === undefined ? {} : { probability }),
    };

    if (this.streamThrough) {
      decision.forward.push(frame);
      if (stopConfirmed) decision.stopped = true;
      this.scheduleExpiry();
      return decision;
    }

    if (started) {
      decision.forward = this.preroll.map((entry) => entry.frame).concat(frame);
      this.preroll = [];
    } else if (this.active) {
      decision.forward.push(frame);
    } else if (this.tailRemainingMs > 0) {
      decision.forward.push(frame);
      this.tailRemainingMs -= frameMs;
      if (this.tailRemainingMs <= 0) {
        this.tailRemainingMs = 0;
        decision.stopped = true;
      }
    } else {
      // A stop confirmed with no tail left to drain reports immediately; a
      // fresh quiet frame just joins the preroll.
      if (stopConfirmed) decision.stopped = true;
      this.preroll.push({ frame, ms: frameMs });
      const prerollBudget = this.config.prerollMs + frameMs;
      while (this.preroll.length > 1 && this.prerollMs() > prerollBudget) {
        this.preroll.shift();
      }
    }

    this.scheduleExpiry();
    return decision;
  }

  reset(): void {
    this.observer?.onReset?.(this.now());
    this.active = false;
    this.startStreakMs = 0;
    this.stopStreakMs = 0;
    this.tailRemainingMs = 0;
    this.downlink = false;
    this.echoHoldMs = 0;
    this.preroll = [];
    this.lastFrameAt = 0;
    if (this.expiryTimer !== undefined) {
      this.scheduler.clearTimeout(this.expiryTimer);
      this.expiryTimer = undefined;
    }
    this.engine.reset();
  }

  private prerollMs(): number {
    return this.preroll.reduce((total, entry) => total + entry.ms, 0);
  }

  private confirmStop(withTail: boolean): void {
    this.active = false;
    this.startStreakMs = 0;
    this.stopStreakMs = 0;
    this.tailRemainingMs = withTail ? this.config.tailMs : 0;
  }

  /**
   * Speech end is only observable from frames; when the stream itself stops we
   * need a timer to release the turn (and fire onSpeechExpired) eventually.
   */
  private scheduleExpiry(): void {
    if (this.expiryTimer !== undefined) {
      this.scheduler.clearTimeout(this.expiryTimer);
      this.expiryTimer = undefined;
    }
    const idle = !this.active && this.tailRemainingMs === 0;
    if (idle) return;
    const expireInMs = this.active
      ? this.config.stopSustainMs + this.config.tailMs + FRAME_GAP_SLACK_MS
      : this.config.tailMs + FRAME_GAP_SLACK_MS;
    this.expiryTimer = this.scheduler.setTimeout(() => {
      this.expiryTimer = undefined;
      if (!this.active && this.tailRemainingMs === 0) return;
      this.observer?.onExpired?.(this.now());
      this.active = false;
      this.startStreakMs = 0;
      this.stopStreakMs = 0;
      this.tailRemainingMs = 0;
      this.lastFrameAt = 0;
      this.preroll = [];
      this.engine.reset();
      this.onSpeechExpired?.();
    }, expireInMs);
  }
}
