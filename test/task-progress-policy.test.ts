import { describe, expect, it } from "vitest";
import { createTaskRecord } from "../src/domain/tasks/task.js";
import { appendTaskActivity, transitionTask } from "../src/domain/tasks/task-transition.js";
import {
  nextTaskProgressAnnouncement,
  startTaskProgressTracking,
} from "../src/application/live-gateway/task-progress-policy.js";

const MINUTE = 60_000;
const MILESTONE = 4 * MINUTE;

const queued = () => createTaskRecord({ ownerIdentity: "owner", input: "Fix the flaky deploy test", title: "Deploy test fix", now: 1_000 });
const running = (record = queued(), now = 2_000) =>
  transitionTask(transitionTask(record, "dispatching", { now }), "running", { now: now + 1, runId: "run_1" });

describe("task progress policy", () => {
  it("announces the start of a task the session saw queued, once", () => {
    const tracking = startTaskProgressTracking(queued(), 1_000);
    const started = running();
    expect(nextTaskProgressAnnouncement(started, tracking, 3_000, MILESTONE)).toEqual({
      taskId: started.taskId, message: "Deploy test fix has started.",
    });
    expect(nextTaskProgressAnnouncement(started, tracking, 3_500, MILESTONE)).toBeUndefined();
  });

  it("never announces a start for a task that was already running when first seen", () => {
    const started = running();
    const tracking = startTaskProgressTracking(started, 3_000);
    expect(nextTaskProgressAnnouncement(started, tracking, 3_100, MILESTONE)).toBeUndefined();
  });

  it("reports the latest recorded step at most once per milestone window", () => {
    let record = running();
    const tracking = startTaskProgressTracking(record, 3_000);
    record = appendTaskActivity(record, { summary: "Hermes is using terminal: npm test", now: 60_000 });
    // Not yet due.
    expect(nextTaskProgressAnnouncement(record, tracking, 2 * MINUTE, MILESTONE)).toBeUndefined();
    expect(nextTaskProgressAnnouncement(record, tracking, 3_000 + MILESTONE, MILESTONE)).toEqual({
      taskId: record.taskId, message: "Deploy test fix is still running. Latest step: Hermes is using terminal: npm test.",
    });
    // Same evidence is never repeated.
    expect(nextTaskProgressAnnouncement(record, tracking, 3_000 + 2 * MILESTONE, MILESTONE)?.message)
      .not.toContain("Latest step");
  });

  it("says once when a run shows no new activity, and resumes after activity", () => {
    let record = running();
    const tracking = startTaskProgressTracking(record, 3_000);
    const quietAt = 3_000 + 6 * MINUTE;
    expect(nextTaskProgressAnnouncement(record, tracking, quietAt, MILESTONE)?.message)
      .toBe("Deploy test fix is still running, but it has shown no new activity for 6 minutes.");
    expect(nextTaskProgressAnnouncement(record, tracking, quietAt + MILESTONE, MILESTONE)).toBeUndefined();
    record = appendTaskActivity(record, { summary: "Hermes finished terminal.", now: quietAt + MILESTONE });
    expect(nextTaskProgressAnnouncement(record, tracking, quietAt + MILESTONE + 1, MILESTONE)?.message)
      .toBe("Deploy test fix is still running. Latest step: Hermes finished terminal.");
  });

  it("stays silent for terminal and delegated tasks", () => {
    const record = running();
    const tracking = startTaskProgressTracking(queued(), 1_000);
    const completed = transitionTask(record, "completed", { now: 5_000, output: "done" });
    expect(nextTaskProgressAnnouncement(completed, tracking, 10 * MINUTE, MILESTONE)).toBeUndefined();
  });
});
