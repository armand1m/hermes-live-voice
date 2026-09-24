import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskRecord } from "../../domain/tasks/index.js";
import type { Logger } from "../../logger.js";
import type { HermesRunsPort } from "../live-gateway/ports/hermes-runs.port.js";
import type { TaskSupervisorPort } from "../live-gateway/ports/task-supervisor.port.js";
import type {
  KnowledgeDocument,
  KnowledgeHit,
  KnowledgeIndexPort,
  KnowledgeSearchOptions,
} from "./ports/knowledge-index.port.js";

// Keeps the local knowledge index in step with its sources. Tasks mirror the
// owner's task inbox (terminal results only: running work has no answer yet);
// sessions, skills, and memory are shared Hermes state refreshed on a slow
// timer. Every source is best effort — one failing source never blocks the
// others or the voice session.

export const KNOWLEDGE_REFRESH_MS = 10 * 60_000;
const MAX_INDEXED_TASKS = 500;
const MAX_INDEXED_SESSIONS = 200;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const MEMORY_FILES = ["MEMORY.md", "USER.md"] as const;
const MEMORY_ENTRY_SEPARATOR = /\n\s*§\s*\n/u;

export interface KnowledgeServiceOptions {
  index: KnowledgeIndexPort;
  hermes: Pick<HermesRunsPort, "listSessions" | "listSkills">;
  tasks: Pick<TaskSupervisorPort, "list" | "subscribe">;
  /** Owner whose task inbox is indexed (the gateway's server-managed identity). */
  ownerId: string;
  hermesHome: string;
  /** Session titles never indexed (the voice recall scratch session). */
  excludedSessionTitles?: readonly string[];
  logger: Logger;
  refreshMs?: number;
}

export class KnowledgeService {
  private unsubscribe?: () => void;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private indexedTaskIds = new Set<string>();

  constructor(private readonly options: KnowledgeServiceOptions) {}

  /** Backfill every source once, then follow task results and refresh the rest. */
  async start(): Promise<void> {
    this.unsubscribe = this.options.tasks.subscribe(this.options.ownerId, (record) => this.noteTask(record));
    await this.refresh();
    const refreshMs = this.options.refreshMs ?? KNOWLEDGE_REFRESH_MS;
    this.timer = setInterval(() => void this.refresh(), refreshMs);
    this.timer.unref?.();
  }

  close(): void {
    this.closed = true;
    this.unsubscribe?.();
    if (this.timer) clearInterval(this.timer);
    this.options.index.close();
  }

  search(query: string, options: Omit<KnowledgeSearchOptions, "ownerId"> = {}): KnowledgeHit[] {
    if (this.closed) return [];
    try {
      return this.options.index.search(query, { ...options, ownerId: this.options.ownerId });
    } catch (error) {
      this.options.logger.warn("knowledge search failed", { error: String(error) });
      return [];
    }
  }

  /** A task the owner permanently deleted must stop being recallable at once. */
  forgetTask(taskId: string): void {
    const keep = new Set<string>();
    for (const id of this.indexedTaskIds) if (id !== `task:${taskId}`) keep.add(id);
    this.indexedTaskIds = keep;
    this.options.index.retainOnly("task", keep);
  }

  counts(): Record<string, number> {
    return {
      task: this.options.index.count("task"),
      session: this.options.index.count("session"),
      skill: this.options.index.count("skill"),
      memory: this.options.index.count("memory"),
    };
  }

  private noteTask(record: TaskRecord): void {
    if (this.closed || !TERMINAL_STATUSES.has(record.status)) return;
    try {
      this.options.index.upsert([taskDocument(record)]);
      this.indexedTaskIds.add(`task:${record.taskId}`);
    } catch (error) {
      this.options.logger.warn("knowledge task indexing failed", { taskId: record.taskId, error: String(error) });
    }
  }

  async refresh(): Promise<void> {
    if (this.closed) return;
    await Promise.all([
      this.syncTasks(),
      this.syncSessions(),
      this.syncSkills(),
      this.syncMemory(),
    ].map((sync) => sync.catch((error: unknown) => {
      this.options.logger.warn("knowledge source sync failed", { error: String(error) });
    })));
  }

  private async syncTasks(): Promise<void> {
    const records = await this.options.tasks.list(this.options.ownerId, MAX_INDEXED_TASKS);
    const documents = records.filter((record) => TERMINAL_STATUSES.has(record.status)).map(taskDocument);
    this.options.index.upsert(documents);
    this.indexedTaskIds = new Set(documents.map((doc) => doc.id));
    // Archived or deleted tasks leave the inbox and leave recall with it.
    this.options.index.retainOnly("task", this.indexedTaskIds);
  }

  private async syncSessions(): Promise<void> {
    if (!this.options.hermes.listSessions) return;
    const excluded = new Set(this.options.excludedSessionTitles ?? []);
    const sessions = await this.options.hermes.listSessions({ limit: MAX_INDEXED_SESSIONS });
    const documents: KnowledgeDocument[] = sessions
      .filter((session) => (session.title || session.preview) && !excluded.has(session.title ?? ""))
      .map((session) => ({
        id: `session:${session.id}`,
        kind: "session",
        title: session.title?.trim() || "Untitled conversation",
        body: session.preview?.trim() ?? "",
        updatedAt: session.lastActive ?? session.startedAt ?? 0,
      }));
    this.options.index.upsert(documents);
    this.options.index.retainOnly("session", new Set(documents.map((doc) => doc.id)));
  }

  private async syncSkills(): Promise<void> {
    if (!this.options.hermes.listSkills) return;
    const skills = await this.options.hermes.listSkills();
    const documents: KnowledgeDocument[] = skills.map((skill) => ({
      id: `skill:${skill.name}`,
      kind: "skill",
      title: skill.name,
      body: [skill.category ? `Category: ${skill.category}.` : "", skill.description ?? ""].join(" ").trim(),
      updatedAt: 0,
    }));
    this.options.index.upsert(documents);
    this.options.index.retainOnly("skill", new Set(documents.map((doc) => doc.id)));
  }

  private async syncMemory(): Promise<void> {
    const documents: KnowledgeDocument[] = [];
    for (const file of MEMORY_FILES) {
      let content: string;
      try {
        content = await readFile(join(this.options.hermesHome, "memories", file), "utf8");
      } catch {
        continue;
      }
      for (const entry of content.split(MEMORY_ENTRY_SEPARATOR)) {
        const text = entry.trim();
        if (!text) continue;
        documents.push({
          id: `memory:${file}:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`,
          kind: "memory",
          title: file === "USER.md" ? "About the user" : "Agent memory",
          body: text,
          updatedAt: 0,
        });
      }
    }
    this.options.index.upsert(documents);
    this.options.index.retainOnly("memory", new Set(documents.map((doc) => doc.id)));
  }
}

function taskDocument(record: TaskRecord): KnowledgeDocument {
  const outcome = record.status === "completed"
    ? record.output?.trim() || "Completed without retained output."
    : record.status === "failed"
      ? `Failed: ${record.error?.trim() || "no retained error."}`
      : "Cancelled.";
  return {
    id: `task:${record.taskId}`,
    kind: "task",
    ownerId: record.ownerId,
    title: record.title,
    body: `Request: ${record.input}\nOutcome: ${outcome}`,
    updatedAt: record.updatedAt,
  };
}
