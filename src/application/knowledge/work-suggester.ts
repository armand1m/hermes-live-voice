import type { AgentWatchRecord } from "../../domain/external-work/index.js";
import type { TaskRecord } from "../../domain/tasks/index.js";
import { TASK_REVIEW_THRESHOLD_MS } from "../live-gateway/task-public-projection.js";
import { queryTerms } from "./query-terms.js";

// Evidence-based work suggestions mined from the owner's own task history and
// agent watches. Deterministic rules only: every suggestion names the task it
// came from and why, and none is ever acted on without the user's go-ahead.

const DAY_MS = 24 * 60 * 60_000;
const FAILURE_WINDOW_MS = 7 * DAY_MS;
const RECURRENCE_WINDOW_MS = 30 * DAY_MS;
const RECURRENCE_MIN_TASKS = 3;
const RECURRENCE_MIN_DAYS = 2;

export type WorkSuggestionKind =
  | "confirm_delegated"
  | "check_stalled"
  | "follow_up_failure"
  | "review_result"
  | "recurring_request";

export interface WorkSuggestion {
  kind: WorkSuggestionKind;
  /** The task the suggestion is about (latest one for recurring requests). */
  taskId: string;
  title: string;
  /** One spoken sentence: what to do and the evidence for it. */
  reason: string;
}

/** Higher first: things waiting on the user outrank ideas. */
const PRIORITY: Record<WorkSuggestionKind, number> = {
  confirm_delegated: 5,
  check_stalled: 4,
  follow_up_failure: 3,
  review_result: 2,
  recurring_request: 1,
};

export function suggestWork(
  tasks: readonly TaskRecord[],
  watches: readonly AgentWatchRecord[],
  now: number,
  limit = 3,
): WorkSuggestion[] {
  const suggestions: WorkSuggestion[] = [];
  const followedUp = new Set(tasks.map((task) => task.parentTaskId).filter((id): id is string => Boolean(id)));

  for (const task of tasks) {
    const title = task.title.trim().slice(0, 100) || "an untitled task";
    if (task.status === "delegated") {
      const watch = watches.find((candidate) => candidate.linkedTaskId === task.taskId && candidate.status === "watching");
      const state = watch?.lastObserved?.state;
      if (state === "done" || state === "idle") {
        suggestions.push({
          kind: "confirm_delegated",
          taskId: task.taskId,
          title,
          reason: `The agent working on ${title} ${state === "done" ? "reports done" : "went idle"} — check its work and tell me whether to close the task.`,
        });
      }
      continue;
    }
    if (task.status === "running") {
      const reference = task.lastMeaningfulProgressAt ?? task.lastActivityAt ?? task.createdAt;
      const stalledMs = now - reference;
      if (stalledMs >= TASK_REVIEW_THRESHOLD_MS) {
        suggestions.push({
          kind: "check_stalled",
          taskId: task.taskId,
          title,
          reason: `${title} has shown no verified progress for ${Math.floor(stalledMs / 60_000)} minutes — worth checking whether it is stuck.`,
        });
      }
      continue;
    }
    if (task.status === "failed" && now - task.updatedAt <= FAILURE_WINDOW_MS && !followedUp.has(task.taskId)) {
      const error = task.error?.trim().replace(/\s+/gu, " ").slice(0, 120);
      suggestions.push({
        kind: "follow_up_failure",
        taskId: task.taskId,
        title,
        reason: `${title} failed${error ? ` (${error})` : ""} and nothing has followed up on it yet.`,
      });
      continue;
    }
    if (task.status === "completed" && task.notification.unread) {
      suggestions.push({
        kind: "review_result",
        taskId: task.taskId,
        title,
        reason: `${title} finished and its result is still unread.`,
      });
    }
  }

  suggestions.push(...recurringRequests(tasks, now));
  return suggestions
    .sort((a, b) => PRIORITY[b.kind] - PRIORITY[a.kind])
    .slice(0, Math.max(1, limit));
}

/**
 * Requests the user keeps making: finished tasks whose titles share the same
 * leading content terms, at least three times over at least two days in the
 * last month. Suggests turning them into a one-step routine.
 */
function recurringRequests(tasks: readonly TaskRecord[], now: number): WorkSuggestion[] {
  const groups = new Map<string, TaskRecord[]>();
  for (const task of tasks) {
    if (task.status !== "completed" || now - task.createdAt > RECURRENCE_WINDOW_MS) continue;
    const signature = queryTerms(task.title).slice(0, 3).sort().join(" ");
    if (signature.split(" ").length < 2) continue;
    groups.set(signature, [...(groups.get(signature) ?? []), task]);
  }
  const suggestions: WorkSuggestion[] = [];
  for (const group of groups.values()) {
    const days = new Set(group.map((task) => Math.floor(task.createdAt / DAY_MS)));
    if (group.length < RECURRENCE_MIN_TASKS || days.size < RECURRENCE_MIN_DAYS) continue;
    const latest = group.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
    const title = latest.title.trim().slice(0, 100);
    suggestions.push({
      kind: "recurring_request",
      taskId: latest.taskId,
      title,
      reason: `You've asked for "${title}" ${group.length} times on ${days.size} different days — I could run it now, or you could ask Hermes to make it a skill or a scheduled job.`,
    });
  }
  return suggestions;
}

/** One short spoken answer for the suggestions (or their absence). */
export function workSuggestionsSpokenSummary(suggestions: readonly WorkSuggestion[]): string {
  if (suggestions.length === 0) return "Nothing is waiting on you right now, and I don't see a recurring request worth automating.";
  const [first, ...rest] = suggestions;
  return [first!.reason, ...rest.map((suggestion) => `Also: ${suggestion.reason}`)].join(" ");
}
