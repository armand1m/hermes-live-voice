import { basename, dirname, join } from "node:path";
import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod/v3";
import {
  AGENT_WATCH_SCHEMA_VERSION,
  AgentWatchRecordSchema,
  WatchIdSchema,
  parseAgentWatchRecord,
  type AgentWatchRecord,
} from "../../../domain/external-work/index.js";
import type {
  AgentWatchListOptions,
  AgentWatchStorePort,
  AgentWatchUpdateOptions,
} from "../../../application/external-work/ports/agent-watch-store.port.js";

/**
 * Durable agent-watch registry (plan §B). Watches survive browser disconnects
 * and gateway restarts: the whole registry is one JSON document written
 * atomically (temp file + fsync + rename + directory sync) with revision
 * checks per update. Watches are few (explicitly registered), so the document
 * stays small; stopped watches prune by age and count.
 */

const DEFAULT_FILENAME = "agent-watches-v1.json";
const DEFAULT_MAX_RECORDS = 256;
const DEFAULT_STOPPED_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_STORE_BYTES = 8 * 1024 * 1024;

const AgentWatchStoreDocumentSchema = z.object({
  schemaVersion: z.literal(AGENT_WATCH_SCHEMA_VERSION),
  watches: z.array(AgentWatchRecordSchema),
}).strict();

export class AgentWatchStoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentWatchStoreConflictError";
  }
}

export class AgentWatchNotFoundError extends Error {
  constructor(watchId: string) {
    super(`Agent watch not found: ${watchId}`);
    this.name = "AgentWatchNotFoundError";
  }
}

export interface FileAgentWatchStoreOptions {
  directory: string;
  filename?: string;
  maxRecords?: number;
  stoppedRetentionMs?: number;
  now?: () => number;
}

interface LoadedState {
  records: Map<string, AgentWatchRecord>;
  mtimeMs: number;
}

export class FileAgentWatchStore implements AgentWatchStorePort {
  private readonly filePath: string;
  private readonly maxRecords: number;
  private readonly stoppedRetentionMs: number;
  private readonly now: () => number;
  private state?: LoadedState;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(options: FileAgentWatchStoreOptions) {
    this.filePath = join(options.directory, options.filename ?? DEFAULT_FILENAME);
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.stoppedRetentionMs = options.stoppedRetentionMs ?? DEFAULT_STOPPED_RETENTION_MS;
    this.now = options.now ?? Date.now;
  }

  async load(watchId: string): Promise<AgentWatchRecord | undefined> {
    return this.serialized(async () => {
      const records = await this.ensureLoaded();
      const record = records.get(WatchIdSchema.parse(watchId));
      return record ? cloneWatch(record) : undefined;
    });
  }

  async list(options: AgentWatchListOptions = {}): Promise<AgentWatchRecord[]> {
    return this.serialized(async () => {
      const records = await this.ensureLoaded();
      const filtered = [...records.values()].filter((record) =>
        (options.ownerId === undefined || record.ownerId === options.ownerId)
        && (options.statuses === undefined || options.statuses.includes(record.status))
        && (options.host === undefined || record.host === options.host)
        && (options.linkedTaskId === undefined || record.linkedTaskId === options.linkedTaskId));
      const ordered = filtered.sort(
        (left, right) => right.updatedAt - left.updatedAt || left.watchId.localeCompare(right.watchId));
      const limited = options.limit === undefined ? ordered : ordered.slice(0, options.limit);
      return limited.map(cloneWatch);
    });
  }

  async put(record: AgentWatchRecord): Promise<AgentWatchRecord> {
    return this.serialized(async () => {
      const records = await this.ensureLoaded();
      const parsed = parseAgentWatchRecord(record);
      const existing = records.get(parsed.watchId);
      if (existing && existing.revision !== parsed.revision - 1 && existing.revision >= parsed.revision) {
        throw new AgentWatchStoreConflictError(
          `Watch ${parsed.watchId} already exists at revision ${existing.revision}.`,
        );
      }
      records.set(parsed.watchId, parsed);
      await this.persist(records);
      return cloneWatch(parsed);
    });
  }

  async update(
    watchId: string,
    updater: (current: AgentWatchRecord) => AgentWatchRecord,
    options: AgentWatchUpdateOptions = {},
  ): Promise<AgentWatchRecord> {
    return this.serialized(async () => {
      const records = await this.ensureLoaded();
      const id = WatchIdSchema.parse(watchId);
      const current = records.get(id);
      if (!current) throw new AgentWatchNotFoundError(id);
      if (options.expectedRevision !== undefined && current.revision !== options.expectedRevision) {
        throw new AgentWatchStoreConflictError(
          `Watch revision conflict for ${id}: expected ${options.expectedRevision}, found ${current.revision}.`,
        );
      }
      const updated = parseAgentWatchRecord(updater(cloneWatch(current)));
      if (updated.revision !== current.revision + 1) {
        throw new AgentWatchStoreConflictError("Watch updates must advance revision by exactly one.");
      }
      if (updated.watchId !== current.watchId || updated.ownerId !== current.ownerId) {
        throw new AgentWatchStoreConflictError("Watch identity and owner are immutable.");
      }
      records.set(id, updated);
      await this.persist(records);
      return cloneWatch(updated);
    });
  }

  async delete(watchId: string): Promise<boolean> {
    return this.serialized(async () => {
      const records = await this.ensureLoaded();
      const deleted = records.delete(WatchIdSchema.parse(watchId));
      if (deleted) await this.persist(records);
      return deleted;
    });
  }

  async prune(options: { stoppedBefore?: number; maxRecords?: number }): Promise<{ deleted: number; watchIds: string[] }> {
    return this.serialized(async () => {
      const records = await this.ensureLoaded();
      const cutoff = options.stoppedBefore ?? (this.now() - this.stoppedRetentionMs);
      const deleted: string[] = [];
      for (const [watchId, record] of records) {
        if (record.status === "stopped" && record.updatedAt < cutoff) {
          records.delete(watchId);
          deleted.push(watchId);
        }
      }
      // Active watches are never evicted; only stale stopped ones overflow.
      const limit = options.maxRecords ?? this.maxRecords;
      if (records.size > limit) {
        const stopped = [...records.values()]
          .filter((record) => record.status === "stopped")
          .sort((left, right) => left.updatedAt - right.updatedAt);
        for (const record of stopped) {
          if (records.size <= limit) break;
          records.delete(record.watchId);
          deleted.push(record.watchId);
        }
      }
      if (deleted.length > 0) await this.persist(records);
      return { deleted: deleted.length, watchIds: deleted };
    });
  }

  async close(): Promise<void> {
    await this.operationTail;
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async ensureLoaded(): Promise<Map<string, AgentWatchRecord>> {
    if (this.state) return this.state.records;
    let stats: Stats | undefined;
    try {
      stats = await lstat(this.filePath);
    } catch {
      stats = undefined;
    }
    const records = new Map<string, AgentWatchRecord>();
    if (stats?.isFile()) {
      const payload = await readFile(this.filePath, "utf8");
      if (payload.trim()) {
        const document = AgentWatchStoreDocumentSchema.parse(JSON.parse(payload));
        for (const watch of document.watches) records.set(watch.watchId, watch);
      }
    }
    this.state = { records, mtimeMs: stats?.mtimeMs ?? 0 };
    return records;
  }

  private async persist(records: Map<string, AgentWatchRecord>): Promise<void> {
    const document = {
      schemaVersion: AGENT_WATCH_SCHEMA_VERSION,
      watches: [...records.values()].sort(
        (left, right) => left.createdAt - right.createdAt || left.watchId.localeCompare(right.watchId)),
    };
    const payload = JSON.stringify(
      AgentWatchStoreDocumentSchema.parse(document),
    );
    if (Buffer.byteLength(payload, "utf8") > MAX_STORE_BYTES) {
      throw new Error("Agent watch store exceeded its safe size limit; refusing to write unbounded state.");
    }
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = join(dirname(this.filePath), `.${basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`);
    let handle;
    let renamed = false;
    try {
      handle = await open(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await handle.writeFile(payload, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(tempPath, 0o600);
      await rename(tempPath, this.filePath);
      renamed = true;
      await syncDirectory(dirname(this.filePath));
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      if (!renamed) await unlink(tempPath).catch(() => undefined);
    }
  }
}

function cloneWatch(record: AgentWatchRecord): AgentWatchRecord {
  return structuredClone(record);
}

/** Directory sync is not available on every supported operating system. */
async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } catch {
    // Directory sync is best-effort durability, never a hard requirement.
  } finally {
    await handle.close();
  }
}
