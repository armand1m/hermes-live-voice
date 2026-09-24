import type { AgentWatchRecord } from "../../../domain/external-work/index.js";

export interface AgentWatchListOptions {
  ownerId?: string;
  statuses?: readonly AgentWatchRecord["status"][];
  linkedTaskId?: string;
  limit?: number;
}

export interface AgentWatchUpdateOptions {
  expectedRevision?: number;
}

export interface AgentWatchStorePort {
  close?(): Promise<void>;
  load(watchId: string): Promise<AgentWatchRecord | undefined>;
  list(options?: AgentWatchListOptions): Promise<AgentWatchRecord[]>;
  put(record: AgentWatchRecord): Promise<AgentWatchRecord>;
  update(
    watchId: string,
    updater: (current: AgentWatchRecord) => AgentWatchRecord,
    options?: AgentWatchUpdateOptions,
  ): Promise<AgentWatchRecord>;
  delete(watchId: string): Promise<boolean>;
  prune(options: { stoppedBefore?: number; maxRecords?: number }): Promise<{ deleted: number; watchIds: string[] }>;
}
