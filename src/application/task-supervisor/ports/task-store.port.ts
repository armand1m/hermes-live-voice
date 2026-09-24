import type { TaskRecord, TaskStatus } from "../../../domain/tasks/index.js";

export interface TaskListOptions {
  ownerId?: string;
  statuses?: readonly TaskStatus[];
  notificationUnread?: boolean;
  limit?: number;
}

export interface TaskUpdateOptions {
  expectedRevision?: number;
}

export interface TaskPruneOptions {
  terminalBefore?: number;
  maxRecords?: number;
}

export interface TaskPruneResult {
  deleted: number;
  taskIds: string[];
}

export interface TaskArchiveTerminalOptions {
  ownerId?: string;
}

export interface TaskArchiveTerminalResult {
  archived: number;
  taskIds: string[];
  /** Finished tasks kept because their terminal notification is still unread. */
  skippedUnread: number;
}

export interface TaskListArchivedOptions {
  limit?: number;
}

export interface TaskStorePort {
  close?(): Promise<void>;
  load(taskId: string): Promise<TaskRecord | undefined>;
  list(options?: TaskListOptions): Promise<TaskRecord[]>;
  put(record: TaskRecord): Promise<TaskRecord>;
  update(
    taskId: string,
    updater: (current: TaskRecord) => TaskRecord,
    options?: TaskUpdateOptions,
  ): Promise<TaskRecord>;
  /** Permanent removal. Implementations must refuse every non-terminal record. */
  delete(taskId: string): Promise<boolean>;
  prune(options?: TaskPruneOptions): Promise<TaskPruneResult>;
  /** Move one terminal record out of the live document into the archive. */
  archive?(taskId: string): Promise<TaskRecord | undefined>;
  /** Move every eligible terminal record into the archive, unread notifications kept. */
  archiveTerminal?(options?: TaskArchiveTerminalOptions): Promise<TaskArchiveTerminalResult>;
  /** Move one archived record back into the live document. */
  restore?(taskId: string): Promise<TaskRecord | undefined>;
  /** Permanently remove one record from the archive. */
  deleteArchived?(taskId: string): Promise<boolean>;
  /** Archived records, newest first, for offline inspection. */
  listArchived?(options?: TaskListArchivedOptions): Promise<TaskRecord[]>;
}
