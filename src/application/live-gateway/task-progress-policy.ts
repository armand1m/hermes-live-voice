// Spoken progress for running Hermes tasks (plan: background-task feedback).
// Template-only and evidence-based: it says a queued task started, reports
// the latest recorded step of a long run at a bounded cadence, and says so
// once when a run shows no new activity — it never invents percentages or
// claims completion (terminal outcomes stay with the durable notifications).
import type { TaskRecord } from "../../domain/tasks/index.js";

/** Minimum spacing between spoken updates for one task. */
export const DEFAULT_PROGRESS_MILESTONE_MS = 4 * 60_000;
/**
 * A task that starts sooner than this after it was created just started —
 * saying so right after the receipt is padding. Only a task that really
 * waited in line gets a "has started" line.
 */
export const START_ANNOUNCE_MIN_WAIT_MS = 10_000;

export interface TaskProgressTracking {
  /** The session saw this task waiting in the queue (its receipt promised a start report). */
  sawQueued: boolean;
  startAnnounced: boolean;
  /** When the last spoken update for this task went out (or when tracking began). */
  lastSpokenAt: number;
  /** Highest progress event sequence already covered by speech. */
  lastSpokenSequence: number;
  /** A "no new activity" line was spoken and no activity has arrived since. */
  quietAnnounced: boolean;
}

export interface TaskProgressAnnouncement {
  taskId: string;
  message: string;
}

export function startTaskProgressTracking(record: TaskRecord, now: number): TaskProgressTracking {
  return {
    sawQueued: record.status === "queued" || record.status === "dispatching",
    startAnnounced: false,
    lastSpokenAt: now,
    lastSpokenSequence: latestProgress(record)?.sequence ?? 0,
    quietAnnounced: false,
  };
}

/**
 * Decide the next spoken update for one task, updating `tracking` in place
 * when something is due. Returns undefined when nothing should be said.
 */
export function nextTaskProgressAnnouncement(
  record: TaskRecord,
  tracking: TaskProgressTracking,
  now: number,
  milestoneMs = DEFAULT_PROGRESS_MILESTONE_MS,
): TaskProgressAnnouncement | undefined {
  if (record.status === "queued" || record.status === "dispatching") {
    tracking.sawQueued = true;
    return undefined;
  }
  if (record.status !== "running") return undefined;
  const title = spokenTitle(record);

  if (tracking.sawQueued && !tracking.startAnnounced && now - record.createdAt >= START_ANNOUNCE_MIN_WAIT_MS) {
    tracking.startAnnounced = true;
    tracking.lastSpokenAt = now;
    tracking.lastSpokenSequence = latestProgress(record)?.sequence ?? tracking.lastSpokenSequence;
    return { taskId: record.taskId, message: `${title} has started.` };
  }
  tracking.startAnnounced = true;

  const latest = latestProgress(record);
  // New activity ends a quiet period even before the next update is due.
  if (latest && latest.sequence > tracking.lastSpokenSequence) tracking.quietAnnounced = false;
  if (now - tracking.lastSpokenAt < milestoneMs) return undefined;
  if (latest && latest.sequence > tracking.lastSpokenSequence) {
    tracking.lastSpokenAt = now;
    tracking.lastSpokenSequence = latest.sequence;
    tracking.quietAnnounced = false;
    return { taskId: record.taskId, message: `${title} is still running. Latest step: ${latestStepPhrase(latest.summary!)}` };
  }
  if (tracking.quietAnnounced) return undefined;
  const quietSince = record.lastActivityAt ?? record.lastMeaningfulProgressAt ?? record.updatedAt;
  const quietMinutes = Math.floor((now - quietSince) / 60_000);
  if (quietMinutes * 60_000 < milestoneMs) return undefined;
  tracking.lastSpokenAt = now;
  tracking.quietAnnounced = true;
  return {
    taskId: record.taskId,
    message: `${title} is still running, but it has shown no new activity for ${quietMinutes} minute${quietMinutes === 1 ? "" : "s"}.`,
  };
}

function latestProgress(record: TaskRecord): { sequence: number; summary?: string } | undefined {
  for (let index = record.events.length - 1; index >= 0; index -= 1) {
    const event = record.events[index]!;
    if (event.type === "progress" && event.summary) return event;
  }
  return undefined;
}

function spokenTitle(record: TaskRecord): string {
  const title = record.title.trim().slice(0, 100);
  return title || "Your task";
}

/** "Hermes is using terminal: npm test" → one short spoken clause. */
function latestStepPhrase(summary: string): string {
  const bounded = summary.replace(/\s+/gu, " ").trim().slice(0, 140);
  return /[.!?]$/u.test(bounded) ? bounded : `${bounded}.`;
}
