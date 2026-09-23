import type { TaskRecord } from "../../domain/tasks/index.js";

/**
 * Truthful queue placement (plan §A): a queued task must be able to say where
 * it stands and what is holding it back, instead of a status answer that
 * conflates queued work with running work.
 */

export interface TaskQueueBlockerView {
  taskId: string;
  title: string;
  reason: "capacity" | "conflicting_write";
}

export interface TaskQueueSupervisionView {
  position: number;
  blockedBy: TaskQueueBlockerView[];
}

export interface QueueSupervisionOptions {
  maxConcurrent: number;
  /** Mirrors the supervisor's admission policy flag for read-only tasks. */
  trustDeclaredReadOnly: boolean;
}

const ACTIVE_QUEUED_BLOCKING_STATUSES = new Set<TaskRecord["status"]>([
  "dispatching",
  "running",
  "waiting_for_approval",
  "stopping",
  "unknown",
  "dispatch_unknown",
]);

export function buildQueueSupervision(
  records: readonly TaskRecord[],
  options: QueueSupervisionOptions,
): Map<string, TaskQueueSupervisionView> {
  const views = new Map<string, TaskQueueSupervisionView>();
  const active = records.filter((record) =>
    ACTIVE_QUEUED_BLOCKING_STATUSES.has(record.status)
    && record.upstreamRunMissingAt === undefined
    && record.operatorContainedAt === undefined);
  const queued = records
    .filter((record) => record.status === "queued")
    .sort((left, right) => left.createdAt - right.createdAt || left.taskId.localeCompare(right.taskId));
  queued.forEach((candidate, index) => {
    views.set(candidate.taskId, {
      position: index + 1,
      blockedBy: blockersFor(candidate, active, options),
    });
  });
  return views;
}

function blockersFor(
  candidate: TaskRecord,
  active: readonly TaskRecord[],
  options: QueueSupervisionOptions,
): TaskQueueBlockerView[] {
  if (active.length === 0) return [];
  const blockers: TaskQueueBlockerView[] = [];
  const candidateRoot = candidate.rootTaskId ?? candidate.taskId;
  // Same lineage always serializes: a queued follow-up cannot outrun its root.
  const lineage = active.filter((record) => (record.rootTaskId ?? record.taskId) === candidateRoot);
  for (const record of lineage) {
    blockers.push({ taskId: record.taskId, title: record.title, reason: "conflicting_write" });
  }
  if (blockers.length > 0) return blockers.slice(0, 4);
  if (!admittingParallel(candidate, active, options)) {
    if (options.trustDeclaredReadOnly && candidate.executionMode === "parallel_read_only") {
      // A read-only task is blocked only by overlapping keys, not by capacity.
      for (const record of active) {
        if (!resourcesAreDisjoint(candidate.resourceKeys, record.resourceKeys)) {
          blockers.push({ taskId: record.taskId, title: record.title, reason: "conflicting_write" });
        }
      }
      return blockers.slice(0, 4);
    }
    // Exclusive admission is FIFO: whatever holds the execution slots now is
    // what this task is waiting on.
    for (const record of active.slice(0, options.maxConcurrent)) {
      blockers.push({ taskId: record.taskId, title: record.title, reason: "capacity" });
    }
  }
  return blockers.slice(0, 4);
}

function admittingParallel(
  candidate: TaskRecord,
  active: readonly TaskRecord[],
  options: QueueSupervisionOptions,
): boolean {
  if (active.length < options.maxConcurrent) return true;
  if (!options.trustDeclaredReadOnly || candidate.executionMode !== "parallel_read_only") return false;
  return active.every((record) =>
    record.executionMode === "parallel_read_only"
    && resourcesAreDisjoint(candidate.resourceKeys, record.resourceKeys));
}

function resourcesAreDisjoint(left: readonly string[], right: readonly string[]): boolean {
  const rightKeys = new Set(right);
  return left.every((key) => !rightKeys.has(key));
}
