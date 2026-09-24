import { describe, expect, it } from "vitest";
import { suggestWork, workSuggestionsSpokenSummary } from "../src/application/knowledge/work-suggester.js";
import { createAgentWatchRecord, hashWatchOwnerId, recordWatchObservation } from "../src/domain/external-work/index.js";
import type { TaskRecord } from "../src/domain/tasks/index.js";
import { createTaskRecord } from "../src/domain/tasks/task.js";
import { appendTaskActivity, transitionTask } from "../src/domain/tasks/task-transition.js";

const DAY = 24 * 60 * 60_000;
const NOW = 40 * DAY;

function running(title: string, at: number, extra: { parentTaskId?: string; rootTaskId?: string } = {}): TaskRecord {
  const created = createTaskRecord({
    ownerIdentity: "owner", input: `${title} please`, title, now: at,
    ...(extra.parentTaskId ? { kind: "follow_up", parentTaskId: extra.parentTaskId, rootTaskId: extra.rootTaskId } : {}),
  });
  return transitionTask(transitionTask(created, "dispatching", { now: at + 1 }), "running", { now: at + 2, runId: "run_1" });
}
const completed = (title: string, at: number) => transitionTask(running(title, at), "completed", { now: at + 3, output: "ok" });
const failed = (title: string, at: number) => transitionTask(running(title, at), "failed", { now: at + 3, error: "SSH timed out" });
const read = (task: TaskRecord): TaskRecord => ({ ...task, notification: { unread: false, acknowledgedAt: task.updatedAt } });

describe("suggestWork", () => {
  it("returns nothing for a tidy history, and says so", () => {
    const suggestions = suggestWork([read(completed("Audit the release", NOW - DAY))], [], NOW);
    expect(suggestions).toEqual([]);
    expect(workSuggestionsSpokenSummary(suggestions)).toContain("Nothing is waiting on you");
  });

  it("puts work waiting on the user first: delegated done, then stalled, failures, unread results", () => {
    const delegated = transitionTask(running("Fix the diamond indicator", NOW - DAY), "delegated", { now: NOW - DAY + 10 });
    let watch = createAgentWatchRecord({
      ownerId: hashWatchOwnerId("owner"), host: "exodia", harness: "herdr", agentSessionValue: "4432988d-611f-437a-8b3a-9937984a86e2",
      paneId: "w4:p1", objective: "Fix it.", acceptanceCriteria: ["x"], linkedTaskId: delegated.taskId, now: NOW - DAY,
    });
    watch = recordWatchObservation(watch, { observation: { state: "done", at: NOW - 60_000, stateChangeSeq: 2 }, now: NOW - 60_000 });
    const stalled = running("Migrate the database", NOW - 30 * 60_000);
    const failure = failed("Check the Mac mini", NOW - 2 * DAY);
    const unread = completed("Summarize the logs", NOW - DAY);

    const suggestions = suggestWork([unread, failure, stalled, delegated], [watch], NOW, 5);
    expect(suggestions.map((suggestion) => suggestion.kind)).toEqual([
      "confirm_delegated", "check_stalled", "follow_up_failure", "review_result",
    ]);
    expect(suggestions[0]!.reason).toContain("reports done");
    expect(suggestions[2]!.reason).toContain("SSH timed out");
    // The default limit keeps the spoken answer short.
    expect(suggestWork([unread, failure, stalled, delegated], [watch], NOW)).toHaveLength(3);
  });

  it("skips failures that were followed up, are old, and runs that are making progress", () => {
    const failure = failed("Check the Mac mini", NOW - 2 * DAY);
    const followUp = read(transitionTask(
      running("Retry the Mac mini check", NOW - DAY, { parentTaskId: failure.taskId, rootTaskId: failure.taskId }),
      "completed", { now: NOW - DAY + 5, output: "ok" },
    ));
    const oldFailure = failed("Ancient failure", NOW - 20 * DAY);
    const active = appendTaskActivity(running("Build the site", NOW - 30 * 60_000), { summary: "Hermes is using terminal.", now: NOW - 60_000, meaningfulAt: NOW - 60_000 });
    expect(suggestWork([failure, followUp, oldFailure, active], [], NOW)).toEqual([]);
  });

  it("offers to automate a request repeated on several days", () => {
    const tasks = [
      read(completed("Check the Mac mini disk usage", NOW - 3 * DAY)),
      read(completed("Check Mac mini disk usage", NOW - 2 * DAY)),
      read(completed("Check the Mac mini disk usage", NOW - DAY)),
    ];
    const [suggestion] = suggestWork(tasks, [], NOW);
    expect(suggestion).toMatchObject({ kind: "recurring_request", taskId: tasks[2]!.taskId });
    expect(suggestion!.reason).toContain("3 times on 3 different days");
    // Three times on a single day is a burst, not a routine.
    const burst = [0, 1, 2].map((offset) => read(completed("Check the Mac mini disk usage", NOW - DAY + offset * 60_000)));
    expect(suggestWork(burst, [], NOW)).toEqual([]);
  });
});
