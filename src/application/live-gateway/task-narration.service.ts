import type { PublicTaskSnapshot } from "../../domain/protocol/server-protocol.js";
import { errorToMessage } from "../../domain/error-message.js";
import type { TaskNarratorPort } from "./ports/task-narrator.port.js";

// Task narration service: turns one terminal task record into concise
// markdown through the configured LLM, and remembers the result by task id
// and revision (taskId:sequence:updatedAt) so a summary is computed exactly
// once per revision — reconnects, repeated drawer opens, and any number of
// clients all hit the cache. Both caches (successes and failures) are bounded
// FIFO; narration of evicted or revised tasks simply recomputes. Failed
// revisions trip a circuit breaker instead of a long quarantine (plan §A): a
// request that made the LLM answer 5xx is not re-sent on every drawer open,
// but a transient failure recovers after a minute — not a gateway restart —
// and concurrent requests for the same revision join the in-flight call.

/** Retained output fed to the model; the raw view keeps the rest. */
const MAX_OUTPUT_CHARS = 4_000;
/** Bounded cache: terminal history is capped by the store, this is the backstop. */
const DEFAULT_MAX_ENTRIES = 256;
/** Circuit breaker: first retry after one minute, doubling, capped at five. */
const DEFAULT_BREAKER_RETRY_MS = 60_000;
const DEFAULT_BREAKER_MAX_MS = 5 * 60_000;

export const NARRATOR_SYSTEM_PROMPT = [
  "You tidy voice-assistant task records into markdown for a compact on-screen log.",
  "Rules:",
  "- Use only facts present in the record. Never invent outcomes, numbers, names, or dates.",
  "- First line: a short bold one-line summary of what the task did.",
  "- Then the details that matter as tight bullet points; omit empty or trivial sections.",
  "- Keep commands, file paths, tool names, ids, and numbers verbatim inside backticks.",
  "- You may trim quoted output, but never round, convert, or paraphrase numbers.",
  "- Keep the whole answer under 150 words.",
  "- No tables. Headings at most ##. No preamble, no closing remarks, no code fence around the whole answer.",
].join("\n");

/** Build the fact sheet handed to the model. Exported for tests. */
export function narrationFactSheet(task: PublicTaskSnapshot): string {
  const lines = [`title: ${task.title || "(untitled)"}`, `state: ${task.state}`];
  if (task.kind === "follow_up") {
    lines.push(`lineage: follow-up task${task.parentTaskId ? ` of ${task.parentTaskId}` : ""}`);
  }
  if (task.progress?.message) lines.push(`last progress: ${task.progress.message}`);
  if (task.error) lines.push(`error: ${task.error.code}: ${task.error.message}`);
  if (task.result?.summary) lines.push(`summary: ${task.result.summary}`);
  if (task.result?.output) {
    const output = task.result.output;
    lines.push(`output: ${output.length > MAX_OUTPUT_CHARS
      ? `${output.slice(0, MAX_OUTPUT_CHARS)}… (truncated)`
      : output}`);
  }
  return lines.join("\n");
}

export interface TaskNarrationResult {
  taskId: string;
  sequence: number;
  updatedAt: number;
  markdown: string;
  model: string;
  cached: boolean;
}

export interface TaskNarrationServiceOptions {
  client: TaskNarratorPort;
  maxEntries?: number;
  /** Circuit breaker: delay before the first retry of a failed revision. */
  breakerRetryMs?: number;
  /** Circuit breaker ceiling: backoff stops growing at this delay. */
  breakerMaxMs?: number;
}

interface FailedEntry {
  failed: true;
  taskId: string;
  sequence: number;
  updatedAt: number;
  error: string;
  at: number;
  attempts: number;
}

export interface TaskNarrationService {
  /** Cached result for this exact revision, if present. */
  cached(taskId: string, sequence: number, updatedAt: number): TaskNarrationResult | undefined;
  /** Narrate (or join an in-flight call for) one task revision. */
  narrate(task: PublicTaskSnapshot): Promise<TaskNarrationResult>;
}

export function createTaskNarrationService(options: TaskNarrationServiceOptions): TaskNarrationService {
  const client = options.client;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const breakerRetryMs = options.breakerRetryMs ?? DEFAULT_BREAKER_RETRY_MS;
  const breakerMaxMs = Math.max(options.breakerMaxMs ?? DEFAULT_BREAKER_MAX_MS, breakerRetryMs);
  const cache = new Map<string, TaskNarrationResult | FailedEntry>();
  const inflight = new Map<string, Promise<TaskNarrationResult>>();

  const keyOf = (taskId: string, sequence: number, updatedAt: number) =>
    `${taskId}:${sequence}:${updatedAt}`;

  function remember(entry: TaskNarrationResult | FailedEntry) {
    const key = keyOf(entry.taskId, entry.sequence, entry.updatedAt);
    cache.set(key, entry);
    while (cache.size > maxEntries) {
      // Map preserves insertion order: drop the oldest remembered entry —
      // failures included, so a burst of dead revisions cannot grow the map.
      cache.delete(cache.keys().next().value as string);
    }
  }

  function breakerDelayMs(entry: FailedEntry): number {
    return Math.min(breakerRetryMs * 2 ** Math.min(entry.attempts - 1, 16), breakerMaxMs);
  }

  return {
    cached(taskId, sequence, updatedAt) {
      const entry = cache.get(keyOf(taskId, sequence, updatedAt));
      return entry && !("failed" in entry) ? entry : undefined;
    },

    async narrate(task) {
      const key = keyOf(task.taskId, task.sequence, task.updatedAt);
      const entry = cache.get(key);
      if (entry && !("failed" in entry)) return { ...entry, cached: true };
      if (entry && "failed" in entry) {
        const elapsed = Date.now() - entry.at;
        const delay = breakerDelayMs(entry);
        if (elapsed < delay) {
          const retryInSeconds = Math.ceil((delay - elapsed) / 1_000);
          throw new Error(
            `task narration is recovering after a recent failure (retrying in ~${retryInSeconds}s): ${entry.error}`,
          );
        }
        cache.delete(key);
      }
      const pending = inflight.get(key);
      if (pending) return pending;
      const run = (async () => {
        try {
          const markdown = await client.summarize(NARRATOR_SYSTEM_PROMPT, narrationFactSheet(task));
          const result: TaskNarrationResult = {
            taskId: task.taskId,
            sequence: task.sequence,
            updatedAt: task.updatedAt,
            markdown,
            model: client.model,
            cached: false,
          };
          remember(result);
          return result;
        } catch (error) {
          // Trip the breaker with backoff: never hammer a model that just
          // failed (it may have crashed outright), but never strand a task
          // log behind a 24-hour quarantine either.
          remember({
            failed: true,
            taskId: task.taskId,
            sequence: task.sequence,
            updatedAt: task.updatedAt,
            error: errorToMessage(error),
            at: Date.now(),
            attempts: (entry && "failed" in entry ? entry.attempts : 0) + 1,
          });
          throw error;
        } finally {
          inflight.delete(key);
        }
      })();
      inflight.set(key, run);
      return run;
    },
  };
}
