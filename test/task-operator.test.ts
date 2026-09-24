import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FileTaskStore,
  TaskStoreCorruptionError,
} from "../src/adapters/outbound/task-store/file-task-store.js";
import { runOfflineTaskCommand } from "../src/cli/task-operator.js";
import { loadConfig } from "../src/config.js";
import { acknowledgeTaskNotification, createTaskRecord, transitionTask } from "../src/domain/tasks/index.js";

const cleanup: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("offline task containment", () => {
  it("lists and contains one exact dispatch-unknown task without inventing an outcome", async () => {
    const root = await mkdtemp(join(tmpdir(), "hermes-live-operator-"));
    cleanup.push(root);
    const stateFile = join(root, "tasks-v1.json");
    const config = loadConfig({ HERMES_LIVE_TASK_STATE_FILE: stateFile });
    const store = new FileTaskStore({ directory: root });
    const uncertain = transitionTask(
      createTaskRecord({
        ownerIdentity: "alice",
        input: "Possibly accepted mutation",
        title: "Unknown task",
        now: 1,
      }),
      "dispatching",
      { now: 2 },
    );
    const unknown = transitionTask(uncertain, "dispatch_unknown", { now: 3 });
    await store.put(unknown);
    await store.close();

    const output: string[] = [];
    await runOfflineTaskCommand(["unresolved"], config, (value) => output.push(value));
    expect(JSON.parse(output[0]!)).toMatchObject({
      object: "hermes_live.unresolved_tasks",
      tasks: [{ taskId: unknown.taskId, status: "unknown" }],
    });
    expect(output[0]).not.toContain("Possibly accepted mutation");

    await expect(runOfflineTaskCommand(["contain", unknown.taskId], config, () => undefined)).rejects.toThrow(
      /--confirm-contained/,
    );
    await runOfflineTaskCommand(
      ["contain", unknown.taskId, "--confirm-contained"],
      config,
      (value) => output.push(value),
    );
    expect(JSON.parse(output.at(-1)!)).toMatchObject({
      object: "hermes_live.task_containment",
      contained: true,
      containedAt: expect.any(Number),
    });

    const reloaded = new FileTaskStore({ directory: root });
    const contained = await reloaded.load(unknown.taskId);
    expect(contained).toMatchObject({
      status: "dispatch_unknown",
      operatorContainedAt: expect.any(Number),
      notification: { unread: true },
    });
    expect(contained?.events.at(-1)).toMatchObject({ type: "operator_contained" });
    await reloaded.close();

    output.length = 0;
    await runOfflineTaskCommand(["unresolved"], config, (value) => output.push(value));
    expect(JSON.parse(output[0]!).tasks).toEqual([]);
  });

  it("inspects and contains older state without applying current retention limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "hermes-live-operator-preserve-"));
    cleanup.push(root);
    const stateFile = join(root, "tasks-v1.json");
    const config = loadConfig({ HERMES_LIVE_TASK_STATE_FILE: stateFile });
    const uncertain = transitionTask(
      transitionTask(createTaskRecord({ ownerIdentity: "alice", input: "Unknown", now: 1 }), "dispatching", { now: 2 }),
      "dispatch_unknown",
      { now: 3 },
    );
    const history = Array.from({ length: 250 }, (_, index) => {
      const createdAt = 10 + index * 3;
      return transitionTask(
        transitionTask(
          createTaskRecord({ ownerIdentity: "alice", input: `History ${index}`, now: createdAt }),
          "dispatching",
          { now: createdAt + 1 },
        ),
        "cancelled",
        { now: createdAt + 2 },
      );
    });
    const original = `${JSON.stringify({
      schemaVersion: uncertain.schemaVersion,
      updatedAt: history.at(-1)!.updatedAt,
      tasks: [uncertain, ...history],
    })}\n`;
    await writeFile(stateFile, original, { mode: 0o600 });

    const output: string[] = [];
    await runOfflineTaskCommand(["unresolved"], config, (value) => output.push(value));
    expect(JSON.parse(output[0]!)).toMatchObject({
      tasks: [{ taskId: uncertain.taskId, status: "unknown" }],
    });
    expect(await readFile(stateFile, "utf8")).toBe(original);

    await runOfflineTaskCommand(
      ["contain", uncertain.taskId, "--confirm-contained"],
      config,
      () => undefined,
    );
    const containedDocument = JSON.parse(await readFile(stateFile, "utf8"));
    expect(containedDocument.tasks).toHaveLength(251);
    expect(containedDocument.tasks.map((task: { taskId: string }) => task.taskId)).toEqual(
      expect.arrayContaining(history.map((task) => task.taskId)),
    );
    expect(containedDocument.tasks.find((task: { taskId: string }) => task.taskId === uncertain.taskId))
      .toMatchObject({ operatorContainedAt: expect.any(Number) });
  });

  it("refuses offline recovery while a gateway owns the task state", async () => {
    const root = await mkdtemp(join(tmpdir(), "hermes-live-operator-lock-"));
    cleanup.push(root);
    const config = loadConfig({ HERMES_LIVE_TASK_STATE_FILE: join(root, "tasks-v1.json") });
    const gatewayStore = new FileTaskStore({ directory: root });
    await gatewayStore.list();

    await expect(runOfflineTaskCommand(["unresolved"], config, () => undefined)).rejects.toThrow(
      /Stop the running Hermes Live gateway/,
    );
    await expect(
      runOfflineTaskCommand(["unlock", "--confirm-no-gateway"], config, () => undefined),
    ).rejects.toThrow(/Refusing to clear task state owned by live gateway PID/);
    await gatewayStore.close();
  });

  it("clears only an explicitly confirmed lock left by an unclean exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "hermes-live-operator-unlock-"));
    cleanup.push(root);
    const config = loadConfig({ HERMES_LIVE_TASK_STATE_FILE: join(root, "tasks-v1.json") });
    await mkdir(join(root, "tasks-v1.json.lock"), { mode: 0o700 });

    await expect(runOfflineTaskCommand(["unlock"], config, () => undefined)).rejects.toThrow(
      /--confirm-no-gateway/,
    );
    const output: string[] = [];
    await runOfflineTaskCommand(
      ["unlock", "--confirm-no-gateway"],
      config,
      (value) => output.push(value),
    );
    expect(JSON.parse(output[0]!)).toEqual({
      object: "hermes_live.task_store_unlock",
      cleared: true,
    });
  });

  it("preserves the command diagnosis when offline task-state cleanup also fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "hermes-live-operator-combined-failure-"));
    cleanup.push(root);
    const stateFile = join(root, "tasks-v1.json");
    const config = loadConfig({ HERMES_LIVE_TASK_STATE_FILE: stateFile });
    await writeFile(stateFile, "{not-json", { mode: 0o600 });
    const closeFailure = new TaskStoreCorruptionError(
      "Task store writer lock was only partially released; inspect the lock directory before restarting.",
    );
    vi.spyOn(FileTaskStore.prototype, "close").mockRejectedValueOnce(closeFailure);

    const failure = await runOfflineTaskCommand(["unresolved"], config, () => undefined).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({
        name: "TaskStoreCorruptionError",
        message: expect.stringContaining("invalid JSON"),
      }),
      closeFailure,
    ]);
  });

  it("surfaces an offline task-store close failure after an otherwise successful command", async () => {
    const root = await mkdtemp(join(tmpdir(), "hermes-live-operator-close-failure-"));
    cleanup.push(root);
    const config = loadConfig({ HERMES_LIVE_TASK_STATE_FILE: join(root, "tasks-v1.json") });
    const closeFailure = new Error("offline task-store close failed");
    vi.spyOn(FileTaskStore.prototype, "close").mockRejectedValueOnce(closeFailure);

    await expect(runOfflineTaskCommand(["unresolved"], config, () => undefined)).rejects.toBe(closeFailure);
  });
});

describe("offline task cleanup", () => {
  it("archives finished tasks, sweeps the rest, and lists the archive", async () => {
    const root = await mkdtemp(join(tmpdir(), "hermes-live-operator-archive-"));
    cleanup.push(root);
    const stateFile = join(root, "tasks-v1.json");
    const config = loadConfig({ HERMES_LIVE_TASK_STATE_FILE: stateFile });
    const completed = acknowledgeTaskNotification(
      finishedTask({ ownerIdentity: "alice", input: "Completed work", now: 10 }, "completed"),
      20,
    );
    const cancelled = acknowledgeTaskNotification(
      finishedTask({ ownerIdentity: "alice", input: "Cancelled work", now: 30 }, "cancelled"),
      40,
    );
    const unresolved = finishedTask({ ownerIdentity: "alice", input: "Unresolved work", now: 50 }, "unknown");
    // Deterministic store clock: with the wall clock, the fixed fixture
    // timestamps read as weeks-stale terminal records and put() retention
    // prunes them before the CLI ever sees the file.
    const store = new FileTaskStore({ directory: root, now: () => 1_000 });
    for (const record of [completed, cancelled, unresolved]) await store.put(record);
    await store.close();

    const output: string[] = [];
    await runOfflineTaskCommand(["archive", completed.taskId], config, (value) => output.push(value));
    expect(JSON.parse(output[0]!)).toMatchObject({
      object: "hermes_live.task_archived",
      task: { taskId: completed.taskId, status: "completed" },
      archiveFile: join(root, "tasks-v1.archive.json"),
    });

    output.length = 0;
    await runOfflineTaskCommand(["archive", "--all-finished"], config, (value) => output.push(value));
    expect(JSON.parse(output[0]!)).toEqual({
      object: "hermes_live.task_archive_sweep",
      archived: 1,
      taskIds: [cancelled.taskId],
      skippedUnread: 0,
    });

    output.length = 0;
    await runOfflineTaskCommand(["archive", "--list"], config, (value) => output.push(value));
    const listing = JSON.parse(output[0]!);
    expect(listing).toMatchObject({ object: "hermes_live.archived_tasks", count: 2 });
    expect(listing.tasks.map((task: { taskId: string }) => task.taskId).sort()).toEqual(
      [cancelled.taskId, completed.taskId].sort(),
    );

    const live = JSON.parse(await readFile(stateFile, "utf8"));
    expect(live.tasks).toHaveLength(1);
    expect(live.tasks[0]).toMatchObject({ taskId: unresolved.taskId, status: "unknown" });
    const archive = JSON.parse(await readFile(join(root, "tasks-v1.archive.json"), "utf8"));
    expect(archive).toMatchObject({ schemaVersion: 1, tasks: expect.any(Array) });
    expect(archive.tasks.map((task: { taskId: string }) => task.taskId).sort()).toEqual(
      [cancelled.taskId, completed.taskId].sort(),
    );
  });

  it("refuses to archive or delete tasks that are not terminal", async () => {
    const root = await mkdtemp(join(tmpdir(), "hermes-live-operator-refuse-"));
    cleanup.push(root);
    const stateFile = join(root, "tasks-v1.json");
    const config = loadConfig({ HERMES_LIVE_TASK_STATE_FILE: stateFile });
    const queued = createTaskRecord({ ownerIdentity: "alice", input: "Still queued", now: 1 });
    const store = new FileTaskStore({ directory: root });
    await store.put(queued);
    await store.close();

    await expect(runOfflineTaskCommand(["archive", queued.taskId], config, () => undefined)).rejects.toThrow(
      /Only terminal tasks can be archived/,
    );
    await expect(
      runOfflineTaskCommand(["delete", queued.taskId, "--confirm-permanent"], config, () => undefined),
    ).rejects.toThrow(/Only terminal tasks can be deleted/);
    await expect(runOfflineTaskCommand(["delete", queued.taskId], config, () => undefined)).rejects.toThrow(
      /--confirm-permanent/,
    );
    const live = JSON.parse(await readFile(stateFile, "utf8"));
    expect(live.tasks).toHaveLength(1);
  });

  it("restores an archived task and permanently deletes archived copies", async () => {
    const root = await mkdtemp(join(tmpdir(), "hermes-live-operator-restore-"));
    cleanup.push(root);
    const stateFile = join(root, "tasks-v1.json");
    const config = loadConfig({ HERMES_LIVE_TASK_STATE_FILE: stateFile });
    const kept = acknowledgeTaskNotification(
      finishedTask({ ownerIdentity: "alice", input: "Keep me", now: 10 }, "completed"),
      20,
    );
    const erased = acknowledgeTaskNotification(
      finishedTask({ ownerIdentity: "alice", input: "Erase me", now: 30 }, "failed", { error: "Broken." }),
      40,
    );
    // Deterministic store clock so put() retention cannot prune the fixed
    // fixture timestamps before the archive writes below.
    const store = new FileTaskStore({ directory: root, now: () => 1_000 });
    for (const record of [kept, erased]) await store.put(record);
    await store.archive(kept.taskId);
    await store.archive(erased.taskId);
    await store.close();

    const output: string[] = [];
    await runOfflineTaskCommand(["restore", kept.taskId], config, (value) => output.push(value));
    expect(JSON.parse(output[0]!)).toMatchObject({
      object: "hermes_live.task_restored",
      task: { taskId: kept.taskId, status: "completed" },
    });
    output.length = 0;
    await runOfflineTaskCommand(["delete", erased.taskId, "--confirm-permanent"], config, (value) => output.push(value));
    expect(JSON.parse(output[0]!)).toMatchObject({
      object: "hermes_live.task_deleted",
      taskId: erased.taskId,
      deleted: true,
      deletedFromArchive: true,
    });

    const live = JSON.parse(await readFile(stateFile, "utf8"));
    expect(live.tasks.map((task: { taskId: string }) => task.taskId)).toEqual([kept.taskId]);
    const archive = JSON.parse(await readFile(join(root, "tasks-v1.archive.json"), "utf8"));
    expect(archive.tasks).toEqual([]);

    // The live-inbox deletion path: a finished task that was never archived.
    output.length = 0;
    await runOfflineTaskCommand(["delete", kept.taskId, "--confirm-permanent"], config, (value) => output.push(value));
    expect(JSON.parse(output[0]!)).toMatchObject({
      object: "hermes_live.task_deleted",
      task: { taskId: kept.taskId, status: "completed" },
      deleted: true,
    });
    expect(JSON.parse(await readFile(stateFile, "utf8")).tasks).toEqual([]);
  });
});

function finishedTask(
  input: { ownerIdentity: string; input: string; now: number },
  status: "completed" | "failed" | "cancelled" | "unknown",
  options: { output?: string; error?: string } = {},
) {
  let record = createTaskRecord(input);
  record = transitionTask(record, "dispatching", { now: input.now + 1 });
  record = transitionTask(record, "running", { now: input.now + 2, runId: `run-${input.now}` });
  return transitionTask(record, status, {
    now: input.now + 3,
    ...(options.output !== undefined ? { output: options.output } : {}),
    ...(options.error !== undefined ? { error: options.error } : {}),
  });
}
