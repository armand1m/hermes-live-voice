// Deterministic spoken templates for task and external-work state. These are
// the voice's words for durable facts, so they stay template-based (never
// LLM-generated) and must not overstate progress or completion.
import type { AgentWatchRecord } from "../../domain/external-work/index.js";
import type { TaskRecord } from "../../domain/tasks/index.js";
import type { ArchivedTasksSummary } from "./ports/task-supervisor.port.js";
import { TASK_REVIEW_THRESHOLD_MS } from "./task-public-projection.js";

export function notificationDigest(records: TaskRecord[]): string {
  return records.slice(0, 3).map((record) => {
    const title = record.title.slice(0, 100);
    if (record.status === "completed") {
      const result = record.output?.trim();
      return `${title} is complete.${result ? ` ${result.slice(0, 180)}` : " The result is available in the task inbox."}`;
    }
    return `${title} needs attention: ${record.status.replaceAll("_", " ")}.`;
  }).join(" ").slice(0, 500);
}

/** Honest spoken summary of watched external work; never claims completion. */
export function externalWatchesSpokenSummary(watches: readonly AgentWatchRecord[]): string {
  const byState = new Map<string, number>();
  for (const watch of watches) {
    const state = watch.lastObserved?.state ?? "not-yet-observed";
    byState.set(state, (byState.get(state) ?? 0) + 1);
  }
  const hosts = [...new Set(watches.map((watch) => watch.host))].join(" and ");
  const parts = [...byState.entries()].map(([state, count]) => `${count} ${state.replace("-", " ")}`);
  return `You are watching ${watches.length} agent${watches.length === 1 ? "" : "s"} on ${hosts}: ${parts.join(", ")}. Idle means the outcome needs inspection, not completion.`;
}

export function taskInboxSpokenSummary(records: readonly TaskRecord[], now = Date.now()): string {
  if (!records.length) return "Your background task inbox is empty.";
  const count = (states: string[]) => records.filter((record) => states.includes(record.status)).length;
  const needsReview = records.filter((record) =>
    record.status === "running"
    && now - (record.lastMeaningfulProgressAt ?? record.lastActivityAt ?? record.createdAt)
      >= TASK_REVIEW_THRESHOLD_MS).length;
  const running = count(["running", "dispatching"]);
  const parts = [
    [running - needsReview, "running"],
    [count(["queued"]), "queued"],
    [count(["delegated"]), "delegated to external agents"],
    [needsReview, "running without verified progress and needing review"],
    [count(["stopping", "waiting_for_approval"]), "awaiting attention"],
    [count(["completed", "failed", "cancelled"]), "finished"],
    [count(["unknown", "dispatch_unknown"]), "with an uncertain outcome"],
  ].filter(([number]) => Number(number) > 0).map(([number, state]) => `${number} ${state}`);
  return `Your tasks: ${parts.join(", ")}.`;
}

export function archiveSweepSpokenSummary(summary: ArchivedTasksSummary): string {
  const parts: string[] = [];
  if (summary.archived > 0) {
    parts.push(
      summary.archived === 1
        ? "I archived one finished task"
        : `I archived ${summary.archived} finished tasks`,
    );
  } else {
    parts.push("There are no finished tasks to archive right now");
  }
  if (summary.skippedUnread > 0) {
    parts.push(
      summary.skippedUnread === 1
        ? "one finished task still has an unheard announcement, so I left it in the inbox"
        : `${summary.skippedUnread} finished tasks still have unheard announcements, so I left them in the inbox`,
    );
  }
  return `${parts.join(", and ")}.`;
}
