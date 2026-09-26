import { createHash } from "node:crypto";
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AppConfig } from "../../config.js";
import type { Logger } from "../../logger.js";
import { FRUSTRATION_LEVELS, MOOD_WORDS, parseLayaMood, type LayaMood } from "./laya-mood.js";

// LAYA System-1 shadow client (docs/laya-system1.md): logs per-turn routing
// classifications next to the brain's actual tool calls so agreement and
// calibration can be measured on real traffic before any active gating.
// Shadow mode only — nothing here may gate, rewrite, or delay a reply, task,
// or speech path. Every failure (sidecar down, timeout, malformed response)
// degrades to an "unknown" row in the log, never a thrown error.

/** Hard state budget for the utterance. LAYA reads a 512-token window. */
export const LAYA_STATE_BUDGET_CHARS = 1_400;
/** Rotate the shadow log once it grows past this. */
export const LAYA_SHADOW_LOG_MAX_BYTES = 10 * 1024 * 1024;
/** Answer cache entries (utterance hash → answers), for Phase-2 admission reuse. */
const MAX_CACHED_ANSWERS = 64;
/** Cached answers older than this are re-asked. */
const ANSWER_CACHE_TTL_MS = 10 * 60_000;
/** Pending (not yet outcome-joined) rows; oldest is finalized on overflow. */
const MAX_PENDING_ROWS = 16;
/** Row format; 2 = per-intent + mood questions over a structured state. */
export const LAYA_SHADOW_SCHEMA = 2;

/**
 * Question sets, phrased the way LAYA's own presets are (yes/no or graded
 * questions that name a field of a structured state). The 2026-09-26 offline
 * re-test on 71 hand-labeled turns: the original single 4-way `route` choice
 * over a free-text state scored at chance (AUC ~0.5); one noul per intent over
 * `{"utterance": …}` scored AUC 0.84-0.92 at ~0.5 s per call, and adding the
 * recent conversation to the state made every intent worse. The sidecar takes
 * at most 4 questions per call, so mood and intents are two calls — mood
 * first, since the diagnostics overlay and brain steering want it soonest.
 */
export const LAYA_MOOD_QUESTIONS = {
  small_talk: {
    type: "noul",
    instructions: "Is `utterance` only a greeting, small talk, thanks, or a short acknowledgement with no request?",
  },
  frustration: {
    type: "score",
    instructions: "How frustrated does the user sound in `utterance`?",
    criteria: [...FRUSTRATION_LEVELS],
  },
  mood: {
    type: "choice",
    instructions: "Which word best describes how the user feels in `utterance`?",
    criteria: { ...MOOD_WORDS },
  },
} as const;

export const LAYA_INTENT_QUESTIONS = {
  new_work: {
    type: "noul",
    instructions: "Does the user in `utterance` ask the assistant to do a piece of work, such as running, checking, building, fixing, researching, or starting an agent?",
  },
  task_status: {
    type: "noul",
    instructions: "Does `utterance` ask about the status, progress, details, or cleanup of tasks that are already running or finished?",
  },
  recall: {
    type: "noul",
    instructions: "Does `utterance` ask what the assistant knows or remembers about the user or about earlier conversations?",
  },
  remember: {
    type: "noul",
    instructions: "Does `utterance` state or correct a personal fact (a name, preference, or detail) the assistant should remember?",
  },
} as const;

/** Every question asked per turn, as logged in each row. */
export const LAYA_SHADOW_QUESTIONS = { ...LAYA_MOOD_QUESTIONS, ...LAYA_INTENT_QUESTIONS } as const;

export interface LayaStateInput {
  /** The finalized user utterance for this turn. */
  utterance: string;
  /** Hard character budget; defaults to LAYA_STATE_BUDGET_CHARS. */
  budgetChars?: number;
}

export interface LayaState {
  state: string;
  utteranceHash: string;
}

/**
 * `{"utterance": …}` — the field every question names. The utterance alone
 * outperformed utterance + recent turns in the re-test; an over-budget
 * utterance keeps its opening words, where the request usually is.
 */
export function buildLayaState(input: LayaStateInput): LayaState {
  const budget = input.budgetChars ?? LAYA_STATE_BUDGET_CHARS;
  const utterance = input.utterance.trim().slice(0, Math.max(1, budget));
  return {
    state: JSON.stringify({ utterance }),
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
  schema: typeof LAYA_SHADOW_SCHEMA;
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

export interface LayaTurnHooks {
  /** The user's mood for this turn, as soon as the mood call answers. */
  onMood?: (mood: LayaMood) => void;
}

class LayaTimeoutError extends Error {}

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
  noteTurn(sessionId: string, state: LayaState, turnHadSpeech: boolean, hooks: LayaTurnHooks = {}): void {
    // A previous turn whose outcome never joined (no terminal response event,
    // e.g. provider dropped mid-receipt): finalize it as-is so the row and its
    // LAYA answer are not lost.
    this.finalizeOldestIfFull();
    const row: LayaShadowRow = {
      schema: LAYA_SHADOW_SCHEMA,
      ts: this.now(),
      sessionId,
      utteranceHash: state.utteranceHash,
      state: state.state,
      questions: LAYA_SHADOW_QUESTIONS,
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
      this.reportMood(cached.answers, hooks);
      return;
    }

    const started = this.now();
    let timedOut = false;
    pendingRow.settleFetch = (async () => {
      // Mood first: the overlay and brain steering want it soonest.
      const mood = await this.ask(state.state, LAYA_MOOD_QUESTIONS).catch((error: unknown) => {
        if (error instanceof LayaTimeoutError) timedOut = true;
        return undefined;
      });
      if (mood) this.reportMood(mood, hooks);
      const intents = await this.ask(state.state, LAYA_INTENT_QUESTIONS).catch((error: unknown) => {
        if (error instanceof LayaTimeoutError) timedOut = true;
        return undefined;
      });
      if (!mood && !intents) {
        if (!pendingRow.outdated) row.timeout = timedOut;
        return;
      }
      const answers = { ...(mood ?? {}), ...(intents ?? {}) };
      const latencyMs = Math.max(0, this.now() - started);
      if (mood && intents) this.cacheAnswers(state.utteranceHash, answers, latencyMs);
      if (!pendingRow.outdated) {
        row.answers = answers;
        row.layaLatencyMs = latencyMs;
        row.timeout = timedOut;
      }
    })();
  }

  /** One sidecar call with its own deadline; rejects with LayaTimeoutError on abort. */
  private async ask(state: string, questions: Record<string, unknown>): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(`${this.options.baseUrl}/decide`, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ state, questions }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`laya sidecar responded ${response.status}`);
      const payload = (await response.json()) as { answers?: Record<string, unknown> };
      if (!payload || typeof payload !== "object" || !payload.answers) {
        throw new Error("laya sidecar response missing answers");
      }
      return payload.answers;
    } catch (error) {
      if (controller.signal.aborted) throw new LayaTimeoutError();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private reportMood(answers: Record<string, unknown>, hooks: LayaTurnHooks): void {
    if (!hooks.onMood) return;
    const mood = parseLayaMood(answers, this.now());
    if (!mood) return;
    try {
      hooks.onMood(mood);
    } catch {
      // A consumer failure never affects the shadow log.
    }
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
