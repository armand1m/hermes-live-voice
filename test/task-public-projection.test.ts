import { describe, expect, it } from "vitest";
import {
  acknowledgeTaskNotification,
  appendTaskActivity,
  appendTaskEvent,
  createTaskRecord,
  markTaskStopRequested,
  markTaskNotificationAnnounced,
  transitionTask,
} from "../src/domain/tasks/index.js";
import {
  TASK_REVIEW_THRESHOLD_MS,
  notificationIdForTask,
  projectSupersededTaskNotification,
  projectTaskLifecycle,
  projectTaskNotification,
  projectTaskSnapshot,
} from "../src/application/live-gateway/task-public-projection.js";
import { buildQueueSupervision } from "../src/application/task-supervisor/task-queue-supervision.js";

describe("task public projection", () => {
  it("exposes queue position and blockers for queued tasks (v11 supervision)", () => {
    const running = transitionTask(
      transitionTask(
        createTaskRecord({ ownerIdentity: "owner", input: "Diamond indicator fix", now: 10 }),
        "dispatching",
        { now: 11 },
      ),
      "running",
      { now: 12, runId: "run_diamond" },
    );
    const queuedFirst = createTaskRecord({
      ownerIdentity: "owner",
      input: "Archive the persona files",
      now: 13,
    });
    const queuedSecond = createTaskRecord({
      ownerIdentity: "owner",
      input: "Inspect the Mac mini",
      now: 14,
    });
    const supervision = buildQueueSupervision([running, queuedFirst, queuedSecond], {
      maxConcurrent: 1,
      trustDeclaredReadOnly: false,
    });

    // The active exclusive task holds the only slot: both queued tasks are
    // behind it, and their positions are truthful FIFO placement.
    expect(supervision.get(queuedFirst.taskId)).toEqual({
      position: 1,
      blockedBy: [{ taskId: running.taskId, title: running.title, reason: "capacity" }],
    });
    expect(supervision.get(queuedSecond.taskId)).toMatchObject({ position: 2 });
    expect(supervision.get(running.taskId)).toBeUndefined();

    const snapshot = projectTaskSnapshot(queuedFirst, {
      queue: supervision.get(queuedFirst.taskId),
    });
    expect(snapshot.queue).toEqual({
      position: 1,
      blockedBy: [{ taskId: running.taskId, title: "Diamond indicator fix", reason: "capacity" }],
    });
    // Supervision fields are opt-in: a projection without them (pre-v11
    // clients) emits neither queue placement nor attention state.
    expect(projectTaskSnapshot(queuedFirst)).not.toHaveProperty("queue");
    expect(JSON.stringify(projectTaskSnapshot(queuedFirst))).not.toContain("needs_review");
  });

  it("flags ten minutes without verified progress as needs_review with evidence", () => {
    const started = 1_000_000;
    const running = transitionTask(
      transitionTask(
        createTaskRecord({ ownerIdentity: "owner", input: "Long investigation", now: started }),
        "dispatching",
        { now: started + 1 },
      ),
      "running",
      { now: started + 2, runId: "run_slow" },
    );
    const withActivity = appendTaskActivity(running, {
      summary: "Hermes is using terminal: grep visualizer",
      now: started + 3,
      meaningfulAt: started + 3,
    });

    // Fresh task: no review flag even when the projection clock advances a bit.
    expect(projectTaskSnapshot(withActivity, { now: started + 3 + TASK_REVIEW_THRESHOLD_MS - 1 }))
      .not.toHaveProperty("attention");

    // Past the threshold with no verified finding since: flag it, with the
    // duration and the last retained evidence — and no claim of failure.
    const stale = projectTaskSnapshot(withActivity, { now: started + 3 + TASK_REVIEW_THRESHOLD_MS + 120_000 });
    expect(stale.attention).toMatchObject({
      state: "needs_review",
      stalledForMs: TASK_REVIEW_THRESHOLD_MS + 120_000,
    });
    expect(stale.attention!.evidence).toContain("No verified progress for 12 minutes");
    expect(stale.attention!.evidence).toContain("grep visualizer");
    expect(stale.attention!.evidence).not.toContain("failed");
    expect(stale.state).toBe("running");
  });

  it("projects retained tool activity as live progress instead of repeating task.started", () => {
    const queued = createTaskRecord({ ownerIdentity: "owner", input: "Inspect", now: 10 });
    const dispatching = transitionTask(queued, "dispatching", { now: 20 });
    const running = transitionTask(dispatching, "running", { now: 30, runId: "run_activity" });
    const active = appendTaskEvent(running, {
      now: 40,
      summary: "Hermes is using terminal: git status",
    });

    expect(projectTaskLifecycle(active)).toMatchObject({
      type: "task.progress",
      progress: { message: "Hermes is using terminal: git status" },
    });
    expect(projectTaskSnapshot(active)).toMatchObject({
      state: "running",
      progress: { message: "Hermes is using terminal: git status" },
    });
  });

  it("never exposes upstream run ids or retained output in list snapshots", () => {
    const queued = createTaskRecord({ ownerIdentity: "owner", input: "Inspect repository", now: 10 });
    const dispatching = transitionTask(queued, "dispatching", { now: 20 });
    const running = transitionTask(dispatching, "running", { now: 30, runId: "secret-upstream-run" });
    const completed = transitionTask(running, "completed", { now: 40, output: "All tests pass." });

    const listSnapshot = projectTaskSnapshot(completed);
    expect(listSnapshot).toMatchObject({
      state: "completed",
      result: { summary: "All tests pass.", truncated: true },
    });
    expect(listSnapshot.result).not.toHaveProperty("output");
    expect(JSON.stringify(listSnapshot)).not.toContain("secret-upstream-run");

    const detail = projectTaskSnapshot(completed, { includeOutput: true });
    expect(detail.result).toMatchObject({ output: "All tests pass.", truncated: false });
  });

  it("projects explicit uncertainty without claiming failure", () => {
    const queued = createTaskRecord({ ownerIdentity: "owner", input: "Deploy", now: 10 });
    const dispatching = transitionTask(queued, "dispatching", { now: 20 });
    const uncertain = transitionTask(dispatching, "dispatch_unknown", {
      now: 30,
      error: "Hermes did not confirm the run id.",
    });

    expect(projectTaskLifecycle(uncertain)).toMatchObject({
      type: "task.unknown",
      error: { code: "task_dispatch_unknown", recoverable: false },
    });
    expect(projectTaskSnapshot(uncertain)).toMatchObject({ state: "unknown" });
  });

  it("projects durable stop intent as stopping without hiding terminal or uncertain truth", () => {
    const queued = createTaskRecord({ ownerIdentity: "owner", input: "Deploy", now: 10 });
    const dispatching = transitionTask(queued, "dispatching", { now: 20 });
    const dispatchStop = markTaskStopRequested(dispatching, { now: 30 });

    expect(projectTaskSnapshot(dispatchStop)).toMatchObject({ state: "stopping" });
    expect(projectTaskLifecycle(dispatchStop, "stop_dispatch")).toMatchObject({
      type: "task.stopping",
      requestId: "stop_dispatch",
    });

    const dispatchUnknown = transitionTask(dispatchStop, "dispatch_unknown", { now: 40 });
    expect(projectTaskSnapshot(dispatchUnknown)).toMatchObject({ state: "unknown" });
    expect(projectTaskLifecycle(dispatchUnknown)).toMatchObject({ type: "task.unknown" });

    const running = transitionTask(dispatching, "running", { now: 30, runId: "run_stop" });
    const runningStop = markTaskStopRequested(running, { now: 40 });
    const unknown = transitionTask(runningStop, "unknown", { now: 50 });
    const completed = transitionTask(runningStop, "completed", { now: 50, output: "Finished before stopping." });
    expect(projectTaskSnapshot(unknown)).toMatchObject({ state: "unknown" });
    expect(projectTaskLifecycle(unknown)).toMatchObject({ type: "task.unknown" });
    expect(projectTaskSnapshot(completed)).toMatchObject({ state: "completed" });
    expect(projectTaskLifecycle(completed)).toMatchObject({ type: "task.completed" });
  });

  it("reports omitted, summarized, and upstream-truncated output truthfully", () => {
    const queued = createTaskRecord({ ownerIdentity: "owner", input: "Generate", now: 10 });
    const dispatching = transitionTask(queued, "dispatching", { now: 20 });
    const running = transitionTask(dispatching, "running", { now: 30, runId: "run_long" });
    const completed = transitionTask(running, "completed", {
      now: 40,
      output: "x".repeat(5_000),
      outputTruncated: true,
    });

    expect(projectTaskSnapshot(completed).result).toMatchObject({
      summary: "x".repeat(4_000),
      truncated: true,
    });
    expect(projectTaskSnapshot(completed, { includeOutput: true }).result).toMatchObject({
      output: "x".repeat(5_000),
      truncated: true,
    });
    expect(projectTaskLifecycle(completed)).toMatchObject({
      type: "task.completed",
      result: { truncated: true },
    });
  });

  it("never projects retained upstream failure details", () => {
    const queued = createTaskRecord({ ownerIdentity: "owner", input: "Fail safely", now: 10 });
    const dispatching = transitionTask(queued, "dispatching", { now: 20 });
    const failed = transitionTask(dispatching, "failed", {
      now: 30,
      error: "Bearer upstream-secret at /Users/private/provider.ts",
    });

    const rendered = JSON.stringify({
      snapshot: projectTaskSnapshot(failed),
      lifecycle: projectTaskLifecycle(failed),
    });
    expect(rendered).not.toContain("upstream-secret");
    expect(rendered).not.toContain("/Users/private");
    expect(projectTaskSnapshot(failed).error).toMatchObject({ code: "task_failed" });
  });

  it("correlates idempotent stop outcomes across every terminal state", () => {
    const queued = createTaskRecord({ ownerIdentity: "owner", input: "Review", now: 10 });
    const cancelled = transitionTask(queued, "cancelled", { now: 20 });
    expect(projectTaskLifecycle(cancelled, "stop_1")).toMatchObject({
      type: "task.cancelled",
      requestId: "stop_1",
    });

    const dispatching = transitionTask(
      createTaskRecord({ ownerIdentity: "owner", input: "Review", now: 10 }),
      "dispatching",
      { now: 20 },
    );
    const running = transitionTask(dispatching, "running", { now: 30, runId: "run_2" });
    const completed = transitionTask(running, "completed", { now: 40, output: "Done" });
    expect(projectTaskLifecycle(completed, "stop_2")).toMatchObject({
      type: "task.completed",
      requestId: "stop_2",
    });
  });

  it("keeps notification identity and creation time stable across delivery bookkeeping", () => {
    const queued = createTaskRecord({ ownerIdentity: "owner", input: "Review", now: 10 });
    const dispatching = transitionTask(queued, "dispatching", { now: 20 });
    const running = transitionTask(dispatching, "running", { now: 30, runId: "run_1" });
    const completed = transitionTask(running, "completed", { now: 40, output: "Done" });

    const original = projectTaskNotification(completed);
    const announced = markTaskNotificationAnnounced(completed, 50);
    const acknowledged = acknowledgeTaskNotification(announced, 60);

    expect(original).toMatchObject({
      notificationId: notificationIdForTask(completed),
      kind: "completed",
      delivery: "when_idle",
      createdAt: 40,
      acknowledged: false,
    });
    expect(notificationIdForTask(announced)).toBe(original?.notificationId);
    expect(notificationIdForTask(acknowledged)).toBe(original?.notificationId);
    expect(projectTaskNotification(announced)?.createdAt).toBe(40);
    expect(projectTaskNotification(acknowledged)).toMatchObject({
      notificationId: original?.notificationId,
      createdAt: 40,
      acknowledged: true,
    });
  });

  it("projects an explicit withdrawal when uncertainty re-enters recovery", () => {
    const queued = createTaskRecord({ ownerIdentity: "owner", input: "Stop exactly", now: 10 });
    const dispatching = transitionTask(queued, "dispatching", { now: 20 });
    const running = transitionTask(dispatching, "running", { now: 30, runId: "run_stop" });
    const unknown = transitionTask(running, "unknown", { now: 40, error: "Ambiguous stop response" });
    const unknownNotification = projectTaskNotification(unknown);
    const waiting = transitionTask(unknown, "waiting_for_approval", { now: 50 });
    const stopping = transitionTask(waiting, "stopping", { now: 60 });

    expect(projectTaskNotification(waiting)).toBeUndefined();
    expect(projectSupersededTaskNotification(waiting)).toEqual({
      notificationId: unknownNotification?.notificationId,
      kind: "unknown",
      delivery: "when_idle",
      message: expect.any(String),
      createdAt: 40,
      acknowledged: true,
    });
    expect(projectTaskNotification(stopping)).toBeUndefined();
    expect(projectSupersededTaskNotification(stopping)).toEqual({
      notificationId: unknownNotification?.notificationId,
      kind: "unknown",
      delivery: "when_idle",
      message: expect.any(String),
      createdAt: 40,
      acknowledged: true,
    });
  });

  it("never exposes an invented actionable approval while Hermes approval IDs are uncorrelated", () => {
    const queued = createTaskRecord({ ownerIdentity: "owner", input: "Deploy", now: 10 });
    const dispatching = transitionTask(queued, "dispatching", { now: 20 });
    const running = transitionTask(dispatching, "running", { now: 30, runId: "run_1" });
    const waiting = transitionTask(running, "waiting_for_approval", { now: 40 });

    expect(projectTaskSnapshot(waiting)).toMatchObject({
      state: "stopping",
      progress: { message: expect.any(String) },
    });
    expect(projectTaskNotification(waiting)).toBeUndefined();
    expect(projectTaskLifecycle(waiting).type).toBe("task.progress");
  });
});
