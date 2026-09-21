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

export interface SpeechTimingMetrics {
  /** Provider response start latency after a tool call began, p50/p95 in ms. */
  toolSpeechP50Ms: number | null;
  toolSpeechP95Ms: number | null;
  /** Task completion → spoken announcement delivery, p50/p95 in ms. */
  announcementDelayP50Ms: number | null;
  announcementDelayP95Ms: number | null;
  /** Gateway-injected filler clips spoken this session (filler side-channel). */
  fillerInjections: number;
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
    };
  }
}
