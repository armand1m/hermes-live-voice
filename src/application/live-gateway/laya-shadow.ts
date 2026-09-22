import { createHash } from "node:crypto";
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AppConfig } from "../../config.js";
import type { Logger } from "../../logger.js";

// LAYA System-1 shadow client (docs/laya-system1.md): logs per-turn routing
// classifications next to the brain's actual tool calls so agreement and
// calibration can be measured on real traffic before any active gating.
// Shadow mode only — nothing here may gate, rewrite, or delay a reply, task,
// or speech path. Every failure (sidecar down, timeout, malformed response)
// degrades to an "unknown" row in the log, never a thrown error.

/** Hard state budget: LAYA's 512-token window destroys decisions that put the
 * current utterance at the end of a long context, so the utterance always
 * comes first and the recent-turn tail is dropped before anything else. */
export const LAYA_STATE_BUDGET_CHARS = 1_400;
/** Recent turns kept in the state, one line each (newest preferred). */
export const LAYA_STATE_RECENT_TURNS = 6;
/** Rotate the shadow log once it grows past this. */
export const LAYA_SHADOW_LOG_MAX_BYTES = 10 * 1024 * 1024;
/** Answer cache entries (utterance hash → answers), for Phase-2 admission reuse. */
const MAX_CACHED_ANSWERS = 64;
/** Cached answers older than this are re-asked. */
const ANSWER_CACHE_TTL_MS = 10 * 60_000;
/** Pending (not yet outcome-joined) rows; oldest is finalized on overflow. */
const MAX_PENDING_ROWS = 16;

/**
 * The Phase-1 question set (plan §3.1 + §3.2): route classification plus the
 * two cheap noul signals. Three questions keeps the sidecar predict under
 * ~1.5 s on CPU; `route` has 4 options, well under the ≥11-option bucket the
 * laya checkpoint ships unclamped-temperature confidence for.
 */
export const LAYA_SHADOW_QUESTIONS = {
  route: {
    type: "choice",
    instructions: "What should the voice agent do with this user turn?",
    criteria: {
      answer_directly: "quick conversational reply or acknowledgement, no tools needed",
      continue_hermes_conversation: "question about memory or persisted chat that needs the Hermes session",
      start_background_task: "meaningful work (files, terminal, research, code, host checks) that should run as a durable background task",
      task_control: "asking to list, check, follow up, or stop an existing background task",
    },
  },
  trivial_chat: {
    type: "noul",
    instructions: "Is this turn pure small talk or social acknowledgement that needs no work at all?",
  },
  read_only: {
    type: "noul",
    instructions: "Is the requested work provably read-only (no writes, no git mutations, no deploys, no external messages)?",
  },
} as const;

export interface LayaTurnLine {
  speaker: "user" | "assistant";
  text: string;
}

export interface LayaStateInput {
  /** The finalized user utterance for this turn. Always placed first. */
  utterance: string;
  /** Prior turns, oldest → newest; the builder keeps the newest that fit. */
  recentTurns?: readonly LayaTurnLine[];
  /** Titles of currently active background tasks (one summary line). */
  activeTaskTitles?: readonly string[];
  /** Hard character budget; defaults to LAYA_STATE_BUDGET_CHARS. */
  budgetChars?: number;
}

export interface LayaState {
  state: string;
  utteranceHash: string;
}

/** Utterance first, then the newest recent turns (one line each), then one
 * active-task-titles line — all under the hard budget. Overflow drops the
 * recent-turn tail first, then the task line; the utterance is never dropped
 * (only truncated if it alone exceeds the budget). */
export function buildLayaState(input: LayaStateInput): LayaState {
  const budget = input.budgetChars ?? LAYA_STATE_BUDGET_CHARS;
  const prefix = "user: ";
  // The utterance is never dropped — an over-budget utterance is truncated
  // head-first (the request's opening words carry the routing signal).
  const utterance = input.utterance.trim().slice(0, Math.max(1, budget - prefix.length));
  let remaining = budget - prefix.length - utterance.length;

  const keepTurns: string[] = [];
  const recentTurns = input.recentTurns ?? [];
  for (let index = recentTurns.length - 1; index >= 0 && keepTurns.length < LAYA_STATE_RECENT_TURNS; index -= 1) {
    const turn = recentTurns[index]!;
    const line = `${turn.speaker}: ${turn.text.trim().slice(0, 200)}`;
    const cost = line.length + 1 + (keepTurns.length === 0 ? 1 + "recent turns:".length : 0);
    if (cost > remaining) break;
    keepTurns.push(line);
    remaining -= cost;
  }

  const taskTitles = (input.activeTaskTitles ?? []).slice(0, 8).map((title) => title.trim()).filter(Boolean);
  let taskLine = "";
  if (taskTitles.length > 0) {
    const candidate = `active tasks: ${taskTitles.join("; ").slice(0, 240)}`;
    if (candidate.length + 1 <= remaining) taskLine = candidate;
  }

  const sections = [`${prefix}${utterance}`];
  if (keepTurns.length > 0) {
    sections.push("recent turns:");
    sections.push(...keepTurns.reverse());
  }
  if (taskLine) sections.push(taskLine);

  return {
    state: sections.join("\n").slice(0, budget),
    utteranceHash: utteranceHash(input.utterance),
  };
}

/** Stable per-turn key: sha256 over the finalized user text (pre-truncation). */
export function utteranceHash(utterance: string): string {
  return `sha256:${createHash("sha256").update(utterance, "utf8").digest("hex")}`;
}

export interface LayaShadowToolCall {
  name: string;
  /** Only meaningful for start_background_task; omitted otherwise. */
  executionMode?: string;
}

export interface LayaShadowRow {
  ts: number;
  sessionId: string;
  utteranceHash: string;
  state: string;
  questions: Record<string, unknown>;
  answers: Record<string, unknown> | null;
  layaLatencyMs: number | null;
  cached: boolean;
  timeout: boolean;
  brain: {
    toolCalls: Array<{ name: string; executionMode?: string }>;
    taskAccepted: boolean | null;
    turnHadSpeech: boolean;
  };
}

interface PendingRow {
  row: LayaShadowRow;
  /** Resolves once the turn's fetch settled (answer, timeout, or error). */
  settleFetch?: Promise<void>;
  /** True once a newer turn replaced this row for the session. */
  outdated?: boolean;
}

export interface LayaShadowLogOptions {
  filePath: string;
  maxBytes?: number;
  logger?: Logger;
}

/** Append-only JSONL writer with size-based rotation (turns.jsonl → turns.jsonl.1). */
export class LayaShadowLog {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly logger?: Logger;
  private directoryReady: Promise<void> | undefined;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: LayaShadowLogOptions) {
    this.filePath = options.filePath;
    this.maxBytes = options.maxBytes ?? LAYA_SHADOW_LOG_MAX_BYTES;
    this.logger = options.logger;
  }

  append(line: string): Promise<void> {
    // Serialize so concurrent turns never interleave partial lines.
    this.writeChain = this.writeChain.then(() => this.writeOne(line)).catch(() => undefined);
    return this.writeChain;
  }

  private async writeOne(line: string): Promise<void> {
    try {
      if (!this.directoryReady) {
        this.directoryReady = mkdir(dirname(this.filePath), { recursive: true }).then(() => undefined);
      }
      await this.directoryReady;
      const size = await stat(this.filePath).then((info) => info.size).catch(() => 0);
      if (size > 0 && size >= this.maxBytes) {
        await rename(this.filePath, `${this.filePath}.1`).catch(() => undefined);
      }
      await appendFile(this.filePath, `${line}\n`, "utf8");
    } catch (error) {
      this.directoryReady = undefined;
      this.logger?.warn("laya shadow log write failed", { error: String(error) });
    }
  }
}

export interface LayaShadowRecorderOptions {
  baseUrl: string;
  timeoutMs: number;
  log: LayaShadowLog;
  logger?: Logger;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * One per gateway (shared log file). Sessions call noteTurn on the finalized
 * user transcript and noteOutcome once the brain's tool calls for that turn
 * are known; the completed row is appended when the outcome join lands.
 * All network work is fire-and-forget with a hard timeout.
 */
export class LayaShadowRecorder {
  private readonly options: LayaShadowRecorderOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly pending = new Map<string, PendingRow>();
  private readonly answerCache = new Map<string, { answers: Record<string, unknown>; latencyMs: number; at: number }>();

  constructor(options: LayaShadowRecorderOptions) {
    this.options = options;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
  }

  /**
   * Record a finalized user turn. Returns immediately; the sidecar call runs
   * in the background and updates the pending row (or the answer cache if the
   * row was already finalized). Never throws.
   */
  noteTurn(sessionId: string, state: LayaState, turnHadSpeech: boolean, questions: Record<string, unknown> = LAYA_SHADOW_QUESTIONS): void {
    // A previous turn whose outcome never joined (no terminal response event,
    // e.g. provider dropped mid-receipt): finalize it as-is so the row and its
    // LAYA answer are not lost.
    this.finalizeOldestIfFull();
    const row: LayaShadowRow = {
      ts: this.now(),
      sessionId,
      utteranceHash: state.utteranceHash,
      state: state.state,
      questions,
      answers: null,
      layaLatencyMs: null,
      cached: false,
      timeout: false,
      brain: { toolCalls: [], taskAccepted: null, turnHadSpeech },
    };
    const pendingRow: PendingRow = { row };
    // A newer turn for this session supersedes any still-fetching older row.
    const previous = this.pending.get(sessionId);
    if (previous) previous.outdated = true;
    this.pending.set(sessionId, pendingRow);

    const cached = this.answerCache.get(state.utteranceHash);
    if (cached && this.now() - cached.at <= ANSWER_CACHE_TTL_MS) {
      row.answers = cached.answers;
      row.layaLatencyMs = cached.latencyMs;
      row.cached = true;
      return;
    }

    const started = this.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    timer.unref?.();
    pendingRow.settleFetch = this.fetchImpl(`${this.options.baseUrl}/decide`, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ state: state.state, questions }),
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error(`laya sidecar responded ${response.status}`);
      const payload = (await response.json()) as { answers?: Record<string, unknown> };
      if (!payload || typeof payload !== "object" || !payload.answers) {
        throw new Error("laya sidecar response missing answers");
      }
      const latencyMs = Math.max(0, this.now() - started);
      this.cacheAnswers(state.utteranceHash, payload.answers, latencyMs);
      if (!pendingRow.outdated) {
        row.answers = payload.answers;
        row.layaLatencyMs = latencyMs;
      }
    }).catch(() => {
      if (!pendingRow.outdated) {
        // Only a deadline abort counts as a timeout; a refused connection or
        // malformed response is an "unknown" answer (answers stay null).
        row.timeout = controller.signal.aborted;
      }
    }).finally(() => clearTimeout(timer));
  }

  /**
   * Join the brain's actual behavior for the turn: the tool calls executed
   * (with the applied execution mode) and whether a task was accepted. Writes
   * the row exactly once; no-op when the session has no pending row. The
   * append waits for an in-flight fetch to settle first (bounded by the
   * request timeout) so a brain that settles faster than the sidecar does
   * not lose the answer from the log.
   */
  noteOutcome(sessionId: string, toolCalls: readonly LayaShadowToolCall[], taskAccepted: boolean | null): void {
    const pending = this.pending.get(sessionId);
    if (!pending) return;
    this.pending.delete(sessionId);
    pending.row.brain.toolCalls = toolCalls.map((call) => ({
      name: call.name,
      ...(call.executionMode ? { executionMode: call.executionMode } : {}),
    }));
    pending.row.brain.taskAccepted = taskAccepted;
    const write = () => {
      void this.options.log.append(JSON.stringify(pending.row));
    };
    if (pending.settleFetch) pending.settleFetch.then(write, write);
    else write();
  }

  /** Flush a session's pending row (session close) with whatever is known. */
  close(sessionId: string): void {
    this.noteOutcome(sessionId, [], null);
  }

  private cacheAnswers(hash: string, answers: Record<string, unknown>, latencyMs: number): void {
    this.answerCache.set(hash, { answers, latencyMs, at: this.now() });
    while (this.answerCache.size > MAX_CACHED_ANSWERS) {
      const oldest = this.answerCache.keys().next().value;
      if (oldest === undefined) break;
      this.answerCache.delete(oldest);
    }
  }

  private finalizeOldestIfFull(): void {
    if (this.pending.size < MAX_PENDING_ROWS) return;
    const oldest = this.pending.keys().next().value;
    if (oldest === undefined) return;
    this.noteOutcome(oldest, [], null);
  }
}

/** Shared recorder for the gateway; undefined (fully inert) unless a sidecar
 * URL is configured and shadow logging is enabled. Defensive against AppConfig
 * literals built with casts (tests) that predate this section. */
export function layaShadowRecorderFromConfig(
  config: AppConfig,
  log: LayaShadowLog,
  logger?: Logger,
): LayaShadowRecorder | undefined {
  const laya = config.laya as AppConfig["laya"] | undefined;
  if (!laya?.baseUrl || !laya.shadowEnabled) return undefined;
  return new LayaShadowRecorder({
    baseUrl: laya.baseUrl,
    timeoutMs: laya.timeoutMs,
    log,
    logger,
  });
}

/** Default shadow-log path: ~/.hermes/hermes-live/laya-shadow/turns.jsonl. */
export function defaultLayaShadowLogPath(home: string): string {
  return join(home, ".hermes", "hermes-live", "laya-shadow", "turns.jsonl");
}
