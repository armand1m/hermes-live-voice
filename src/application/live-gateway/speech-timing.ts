// Speech-timing telemetry behind GET /v1/metrics and the browser diagnostics
// overlay. The audio-delivery ring in live-gateway-session.ts answers "did the
// gateway feed frames late"; these counters answer the other half of natural
// conversation — "how long did the user wait to hear anything after asking":
// tool call → first spoken response, and task completion → spoken announcement.

const SAMPLE_WINDOW = 32;
/** Pending-announcement ledger cap; oversized only if a client never goes idle. */
const MAX_PENDING_ANNOUNCEMENTS = 64;

/** Fixed-size ring of millisecond samples with percentile reads. */
class NumberRing {
  private readonly samples = new Float64Array(SAMPLE_WINDOW);
  private length = 0;
  private next = 0;

  push(value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    this.samples[this.next] = value;
    this.next = (this.next + 1) % this.samples.length;
    if (this.length < this.samples.length) this.length += 1;
  }

  percentile(quantile: number): number | null {
    if (this.length === 0) return null;
    const view = Array.from(this.samples.subarray(0, this.length)).sort((a, b) => a - b);
    const index = Math.min(this.length - 1, Math.floor(quantile * (this.length - 1)));
    return view[index]!;
  }
}

/** p50/p95 of one turn stage, in ms; null until a turn has been sampled. */
export interface StagePercentiles {
  p50Ms: number | null;
  p95Ms: number | null;
}

export const TURN_STAGES = ["endpoint", "asr", "brain", "tts", "response", "total"] as const;
export type TurnStage = typeof TURN_STAGES[number];

/**
 * One completed turn, split at the boundaries the gateway can observe:
 * endpoint = gate speech-stop → provider commit; asr = commit → user final;
 * brain = user final → first spoken assistant text; tts = that text → first
 * provider audio frame; response = user final → first audio; total = speech
 * stop → first audio. Stages the turn never crossed (text input has no
 * endpoint or ASR) are absent.
 */
export type TurnLatencySample = Partial<Record<TurnStage, number>>;

interface TurnMarks {
  speechEndAt?: number;
  commitAt?: number;
  userFinalAt?: number;
  assistantTextAt?: number;
}

export interface SpeechTimingMetrics {
  /** Provider response start latency after a tool call began, p50/p95 in ms. */
  toolSpeechP50Ms: number | null;
  toolSpeechP95Ms: number | null;
  /** Task completion → spoken announcement delivery, p50/p95 in ms. */
  announcementDelayP50Ms: number | null;
  announcementDelayP95Ms: number | null;
  /** Gateway-injected filler clips spoken this session (filler side-channel). */
  fillerInjections: number;
  /** Per-stage voice-turn latency over the recent turn window. */
  turnLatency: Record<TurnStage, StagePercentiles>;
}

/**
 * Per-session timing tracker. All inputs are timestamps fed by the session's
 * existing event paths; nothing samples on its own, so the tracker is inert
 * unless a conversation is actually running.
 */
export class SpeechTimingTracker {
  private readonly toolSpeech = new NumberRing();
  private readonly announcementDelay = new NumberRing();
  private readonly announcementFirstSeenAt = new Map<string, number>();
  private pendingToolStartedAt: number | null = null;
  private fillerInjections = 0;
  private readonly turnStages = Object.fromEntries(
    TURN_STAGES.map((stage) => [stage, new NumberRing()]),
  ) as Record<TurnStage, NumberRing>;
  private turn: TurnMarks | null = null;

  /** The gateway gate confirmed the end of user speech: a new voice turn begins. */
  noteSpeechEnded(at: number): void {
    this.turn = { speechEndAt: at };
  }

  /** The provider accepted the turn's audio commit. */
  noteTurnCommitted(at: number): void {
    if (this.turn?.speechEndAt !== undefined && this.turn.commitAt === undefined) this.turn.commitAt = at;
  }

  /**
   * The final user transcript arrived. A text turn (or a voice final with no
   * open voice timeline) starts fresh here, so a stale speech-stop left by a
   * dropped echo turn never inflates the next turn's endpoint/total.
   */
  noteUserFinal(at: number, fromVoice: boolean): void {
    if (!fromVoice || !this.turn || this.turn.userFinalAt !== undefined) this.turn = {};
    this.turn.userFinalAt = at;
  }

  /** The first spoken assistant text of the answer (brain reply or receipt). */
  noteAssistantText(at: number): void {
    if (this.turn?.userFinalAt !== undefined && this.turn.assistantTextAt === undefined) this.turn.assistantTextAt = at;
  }

  /**
   * The first provider audio frame of the answer closes the turn. Returns the
   * completed sample (for logging) or undefined when no turn was pending.
   */
  noteFirstAudio(at: number): TurnLatencySample | undefined {
    const turn = this.turn;
    if (turn?.userFinalAt === undefined) return undefined;
    this.turn = null;
    const sample: TurnLatencySample = {};
    const span = (stage: TurnStage, from: number | undefined, to: number | undefined): void => {
      if (from === undefined || to === undefined || to < from) return;
      sample[stage] = to - from;
      this.turnStages[stage].push(to - from);
    };
    span("endpoint", turn.speechEndAt, turn.commitAt);
    span("asr", turn.commitAt, turn.userFinalAt);
    span("brain", turn.userFinalAt, turn.assistantTextAt);
    span("tts", turn.assistantTextAt, at);
    span("response", turn.userFinalAt, at);
    span("total", turn.speechEndAt, at);
    return sample;
  }

  /** Earliest outstanding tool call wins: the user has been waiting since then. */
  noteToolCallStarted(at: number): void {
    if (this.pendingToolStartedAt === null || at < this.pendingToolStartedAt) {
      this.pendingToolStartedAt = at;
    }
  }

  /**
   * A provider response began. Task-notification speech is excluded: it is
   * itself an announcement, not the answer the user is waiting on.
   */
  noteResponseStarted(scope: string | undefined, at: number): void {
    if (scope === "task_notification") return;
    if (this.pendingToolStartedAt === null) return;
    this.toolSpeech.push(at - this.pendingToolStartedAt);
    this.pendingToolStartedAt = null;
  }

  noteAnnouncementPending(taskId: string, at: number): void {
    if (this.announcementFirstSeenAt.has(taskId)) return;
    if (this.announcementFirstSeenAt.size >= MAX_PENDING_ANNOUNCEMENTS) {
      let oldestKey: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, seenAt] of this.announcementFirstSeenAt) {
        if (seenAt < oldestAt) {
          oldestAt = seenAt;
          oldestKey = key;
        }
      }
      if (oldestKey !== undefined) this.announcementFirstSeenAt.delete(oldestKey);
    }
    this.announcementFirstSeenAt.set(taskId, at);
  }

  noteAnnouncementDelivered(taskId: string, at: number): void {
    const firstSeenAt = this.announcementFirstSeenAt.get(taskId);
    if (firstSeenAt === undefined) return;
    this.announcementFirstSeenAt.delete(taskId);
    this.announcementDelay.push(at - firstSeenAt);
  }

  /** An announcement was dropped without speech (retry budget exhausted). */
  forgetAnnouncement(taskId: string): void {
    this.announcementFirstSeenAt.delete(taskId);
  }

  noteFillerInjection(): void {
    this.fillerInjections += 1;
  }

  metrics(): SpeechTimingMetrics {
    return {
      toolSpeechP50Ms: this.toolSpeech.percentile(0.5),
      toolSpeechP95Ms: this.toolSpeech.percentile(0.95),
      announcementDelayP50Ms: this.announcementDelay.percentile(0.5),
      announcementDelayP95Ms: this.announcementDelay.percentile(0.95),
      fillerInjections: this.fillerInjections,
      turnLatency: Object.fromEntries(TURN_STAGES.map((stage) => [stage, {
        p50Ms: this.turnStages[stage].percentile(0.5),
        p95Ms: this.turnStages[stage].percentile(0.95),
      }])) as Record<TurnStage, StagePercentiles>,
    };
  }
}
