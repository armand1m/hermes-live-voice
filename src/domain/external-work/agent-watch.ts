import { createHash, randomUUID } from "node:crypto";
import { z } from "zod/v3";
import { DELEGATION_HARNESSES, DELEGATION_HOSTS, type DelegationHarness, type DelegationHost } from "../tasks/delegation.js";

/**
 * Durable watch over external delegated work (plan §B). One watch tracks one
 * harness agent on one host, identified by host + harness session identity +
 * pane. Pane reuse must never silently re-attach a watch to different work:
 * when the pane's session identity changes, the watch is marked mismatched and
 * needs human attention instead of following whatever now runs there.
 *
 * Watches are observation-only. Idle means "agent idle; outcome needs
 * inspection", never "task completed"; recent terminal text is supporting
 * evidence, never authoritative completion proof.
 */

export const AGENT_WATCH_SCHEMA_VERSION = 1 as const;
export const MAX_WATCH_OBJECTIVE_CHARS = 4_000;
export const MAX_WATCH_ACCEPTANCE_ITEMS = 8;
export const MAX_WATCH_ACCEPTANCE_CHARS = 500;
export const MAX_WATCH_EVENTS = 64;
export const MAX_RECENT_ANNOUNCED_KEYS = 16;
export const MAX_WATCH_EVENT_SUMMARY_CHARS = 2_000;
export const MAX_WATCH_OUTPUT_EXCERPT_CHARS = 600;

const UNSAFE_SINGLE_LINE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const UNSAFE_SINGLE_LINE_GLOBAL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/gu;

/** herdr's own agent status values (verified against the live API schema). */
export const ExternalAgentRuntimeStatusSchema = z.enum(["idle", "working", "blocked", "done", "unknown"]);
export type ExternalAgentRuntimeStatus = z.infer<typeof ExternalAgentRuntimeStatusSchema>;

/**
 * Monitor-level observation state. The three values beyond the runtime status
 * say something about the *watch*, not the agent: the agent disappeared from
 * the host snapshot (missing), or the host could not be reached (offline).
 */
export const ExternalObservationStateSchema = z.enum([
  "working",
  "idle",
  "blocked",
  "done",
  "unknown",
  "missing",
  "offline",
]);
export type ExternalObservationState = z.infer<typeof ExternalObservationStateSchema>;

/** A watch ends when its owner releases it; a mismatch is attention, not an end. */
export const AgentWatchStatusSchema = z.enum(["watching", "mismatched", "stopped"]);
export type AgentWatchStatus = z.infer<typeof AgentWatchStatusSchema>;

export const WatchIdSchema = z.string().regex(
  /^watch_[0-9a-f]{32}$/u,
  "Watch ID must use the watch_<32 lowercase hex> format.",
);
/** herdr pane identifiers look like w4:p1 or wC:p1 — tightly patterned, never free text. */
export const PaneIdSchema = z.string().regex(/^w[0-9a-zA-Z]{1,8}:p[0-9]{1,4}$/u, "Pane ID must look like w4:p1.");
export const AgentSessionValueSchema = z.string().min(1).max(256).refine(
  isSafeSingleLine,
  "Agent session identity contains unsafe characters.",
);
const WatchObjectiveSchema = z.string().min(1).max(MAX_WATCH_OBJECTIVE_CHARS);
const WatchAcceptanceSchema = z.array(z.string().min(1).max(MAX_WATCH_ACCEPTANCE_CHARS))
  .min(1)
  .max(MAX_WATCH_ACCEPTANCE_ITEMS);
const WatchTimestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const WatchCounterSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const WatchEventSchema = z.object({
  sequence: WatchCounterSchema,
  type: z.enum([
    "watch.started",
    "observation.changed",
    "observation.fresh",
    "monitoring.degraded",
    "monitoring.recovered",
    "identity.mismatched",
    "watch.stopped",
  ]),
  timestamp: WatchTimestampSchema,
  summary: z.string().min(1).max(MAX_WATCH_EVENT_SUMMARY_CHARS).refine(
    isSafeSingleLine,
    "Watch event summary contains unsafe characters.",
  ).optional(),
}).strict();
export type WatchEvent = z.infer<typeof WatchEventSchema>;

export const WatchObservationSchema = z.object({
  state: ExternalObservationStateSchema,
  /** Raw harness status when the agent was seen; absent for missing/offline. */
  agentStatus: ExternalAgentRuntimeStatusSchema.optional(),
  /** Harness revision and state-change cursor, for cheap change detection. */
  agentRevision: z.number().int().nonnegative().optional(),
  stateChangeSeq: z.number().int().nonnegative().optional(),
  /** Bounded last-line excerpt of recent terminal output. Evidence, not proof. */
  excerpt: z.string().max(MAX_WATCH_OUTPUT_EXCERPT_CHARS).optional(),
  at: WatchTimestampSchema,
}).strict();
export type WatchObservation = z.infer<typeof WatchObservationSchema>;

export const WatchMonitoringHealthSchema = z.object({
  consecutiveFailures: z.number().int().nonnegative().max(1_000),
  lastError: z.string().max(500).optional(),
  lastErrorAt: WatchTimestampSchema.optional(),
  lastSuccessAt: WatchTimestampSchema.optional(),
}).strict();
export type WatchMonitoringHealth = z.infer<typeof WatchMonitoringHealthSchema>;

export const AgentWatchRecordSchema = z.object({
  schemaVersion: z.literal(AGENT_WATCH_SCHEMA_VERSION),
  watchId: WatchIdSchema,
  ownerId: z.string().regex(/^owner_[0-9a-f]{64}$/u, "Watch owner ID must be a SHA-256 hash."),
  originConversationId: z.string().min(1).max(256).optional(),
  linkedTaskId: z.string().regex(/^task_[0-9a-f]{32}$/u).optional(),
  host: z.enum(DELEGATION_HOSTS),
  harness: z.enum(DELEGATION_HARNESSES),
  agentSessionValue: AgentSessionValueSchema,
  paneId: PaneIdSchema,
  workspaceId: z.string().min(1).max(64).optional(),
  objective: WatchObjectiveSchema,
  acceptanceCriteria: WatchAcceptanceSchema,
  status: AgentWatchStatusSchema,
  createdAt: WatchTimestampSchema,
  updatedAt: WatchTimestampSchema,
  revision: WatchCounterSchema,
  sequence: WatchCounterSchema,
  events: z.array(WatchEventSchema).min(1).max(MAX_WATCH_EVENTS),
  lastObserved: WatchObservationSchema.optional(),
  monitoring: WatchMonitoringHealthSchema,
  /** Dedupe key of the last announcement derived from this watch. */
  lastAnnouncedKey: z.string().min(1).max(200).optional(),
  lastAnnouncedAt: WatchTimestampSchema.optional(),
  /** Bounded history of spoken keys, so an older key never repeats after a newer one. */
  recentAnnouncedKeys: z.array(z.string().min(1).max(200)).max(MAX_RECENT_ANNOUNCED_KEYS).optional(),
}).strict().superRefine((record, context) => {
  if (record.updatedAt < record.createdAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Watch updatedAt precedes createdAt." });
  }
  let previousSequence = 0;
  for (const event of record.events) {
    if (event.sequence <= previousSequence || event.sequence > record.sequence) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Watch event sequences must be ordered and bounded." });
      break;
    }
    previousSequence = event.sequence;
  }
  if (record.events.at(-1)?.sequence !== record.sequence) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Watch sequence must match the latest retained event." });
  }
  if (record.status === "stopped" && !record.events.some((event) => event.type === "watch.stopped")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A stopped watch requires its stop event." });
  }
  if (record.status === "mismatched" && !record.events.some((event) => event.type === "identity.mismatched")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A mismatched watch requires its mismatch event." });
  }
  if (record.lastAnnouncedAt !== undefined && record.lastAnnouncedAt < record.createdAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Watch announcement cannot precede watch creation." });
  }
});
export type AgentWatchRecord = z.infer<typeof AgentWatchRecordSchema>;

export interface CreateAgentWatchInput {
  ownerId: string;
  host: DelegationHost;
  harness: DelegationHarness;
  agentSessionValue: string;
  paneId: string;
  objective: string;
  acceptanceCriteria: readonly string[];
  workspaceId?: string;
  linkedTaskId?: string;
  originConversationId?: string;
  now?: number;
  watchId?: string;
}

export function createWatchId(): string {
  return `watch_${randomUUID().replaceAll("-", "")}`;
}

export function hashWatchOwnerId(ownerIdentity: string): string {
  const normalized = ownerIdentity.trim();
  if (!normalized || normalized.length > 1_024 || !isSafeSingleLine(normalized)) {
    throw new Error("Watch owner identity must be a safe non-empty value of at most 1024 characters.");
  }
  return `owner_${createHash("sha256").update(normalized, "utf8").digest("hex")}`;
}

export function createAgentWatchRecord(input: CreateAgentWatchInput): AgentWatchRecord {
  const now = parseWatchTimestamp(input.now ?? Date.now(), "Watch creation timestamp");
  const objective = sanitizeMultiline(input.objective).slice(0, MAX_WATCH_OBJECTIVE_CHARS).trim();
  const acceptance = [...input.acceptanceCriteria]
    .map((item) => sanitizeSingleLine(item).slice(0, MAX_WATCH_ACCEPTANCE_CHARS).trim())
    .filter(Boolean)
    .slice(0, MAX_WATCH_ACCEPTANCE_ITEMS);
  const event: WatchEvent = {
    sequence: 1,
    type: "watch.started",
    timestamp: now,
    summary: `Watching ${input.harness} on ${input.host}: ${objective.slice(0, 180)}`,
  };
  return AgentWatchRecordSchema.parse({
    schemaVersion: AGENT_WATCH_SCHEMA_VERSION,
    watchId: WatchIdSchema.parse(input.watchId ?? createWatchId()),
    ownerId: input.ownerId,
    ...(input.originConversationId ? { originConversationId: sanitizeSingleLine(input.originConversationId).slice(0, 256) } : {}),
    ...(input.linkedTaskId ? { linkedTaskId: input.linkedTaskId } : {}),
    host: input.host,
    harness: input.harness,
    agentSessionValue: AgentSessionValueSchema.parse(sanitizeSingleLine(input.agentSessionValue)),
    paneId: PaneIdSchema.parse(input.paneId),
    ...(input.workspaceId ? { workspaceId: sanitizeSingleLine(input.workspaceId).slice(0, 64) } : {}),
    objective: WatchObjectiveSchema.parse(objective || "External delegated work"),
    acceptanceCriteria: WatchAcceptanceSchema.parse(acceptance.length > 0 ? acceptance : ["Outcome inspected by the owner."]),
    status: "watching",
    createdAt: now,
    updatedAt: now,
    revision: 1,
    sequence: 1,
    events: [event],
    monitoring: { consecutiveFailures: 0 },
  });
}

export interface RecordObservationInput {
  observation: WatchObservation;
  now?: number;
  /** Bounded note when the observation changes state, for the retained log. */
  summary?: string;
}

/**
 * Fold one observation into a watch. A pure domain transition: state changes
 * append an event, unchanged observations only refresh (coalesced by the
 * monitor), and a pane whose session identity changed is marked mismatched by
 * the monitor beforehand — this function never rewrites identity.
 */
export function recordWatchObservation(value: AgentWatchRecord, input: RecordObservationInput): AgentWatchRecord {
  const record = AgentWatchRecordSchema.parse(value);
  if (record.status !== "watching") return record;
  const now = Math.max(record.updatedAt, parseWatchTimestamp(input.now ?? Date.now(), "Watch observation timestamp"));
  const previous = record.lastObserved;
  const stateChanged = previous?.state !== input.observation.state
    || previous?.agentStatus !== input.observation.agentStatus;
  const next: AgentWatchRecord = {
    ...record,
    updatedAt: now,
    revision: record.revision + 1,
    monitoring: { ...record.monitoring, consecutiveFailures: 0, lastSuccessAt: now },
    ...(stateChanged || previous === undefined
      ? {
          lastObserved: input.observation,
          sequence: record.sequence + 1,
          events: appendWatchEvent(record.events, {
            sequence: record.sequence + 1,
            type: "observation.changed",
            timestamp: now,
            summary: sanitizeSingleLine(input.summary ?? `Agent ${input.observation.state}.`).slice(0, MAX_WATCH_EVENT_SUMMARY_CHARS),
          }),
        }
      : {
          lastObserved: input.observation,
        }),
  };
  return AgentWatchRecordSchema.parse(next);
}

export function recordWatchHostFailure(value: AgentWatchRecord, input: { error: string; now?: number }): AgentWatchRecord {
  const record = AgentWatchRecordSchema.parse(value);
  if (record.status !== "watching") return record;
  const now = Math.max(record.updatedAt, parseWatchTimestamp(input.now ?? Date.now(), "Watch failure timestamp"));
  const failures = record.monitoring.consecutiveFailures + 1;
  const wasDegraded = record.monitoring.consecutiveFailures >= 3;
  const nowDegraded = failures >= 3;
  const next: AgentWatchRecord = {
    ...record,
    updatedAt: now,
    revision: record.revision + 1,
    monitoring: {
      ...record.monitoring,
      consecutiveFailures: failures,
      lastError: sanitizeSingleLine(input.error).slice(0, 500) || "Observation failed.",
      lastErrorAt: now,
    },
    // Three consecutive failures flip the effective observation to offline
    // until a successful poll proves otherwise.
    ...(!wasDegraded && nowDegraded
      ? {
          lastObserved: record.lastObserved
            ? { ...record.lastObserved, state: "offline" as const, at: now }
            : undefined,
          sequence: record.sequence + 1,
          events: appendWatchEvent(record.events, {
            sequence: record.sequence + 1,
            type: "monitoring.degraded",
            timestamp: now,
            summary: sanitizeSingleLine(`Host unreachable: ${input.error}`).slice(0, MAX_WATCH_EVENT_SUMMARY_CHARS),
          }),
        }
      : {}),
  };
  return AgentWatchRecordSchema.parse(next);
}

export function markWatchMismatched(value: AgentWatchRecord, input: { expectedSessionValue: string; now?: number }): AgentWatchRecord {
  const record = AgentWatchRecordSchema.parse(value);
  if (record.status !== "watching") return record;
  const now = Math.max(record.updatedAt, parseWatchTimestamp(input.now ?? Date.now(), "Watch mismatch timestamp"));
  const event = {
    sequence: record.sequence + 1,
    type: "identity.mismatched" as const,
    timestamp: now,
    summary: sanitizeSingleLine(
      `Pane ${record.paneId} on ${record.host} now runs a different session; the watch no longer follows it.`,
    ).slice(0, MAX_WATCH_EVENT_SUMMARY_CHARS),
  };
  return AgentWatchRecordSchema.parse({
    ...record,
    status: "mismatched",
    updatedAt: now,
    revision: record.revision + 1,
    sequence: event.sequence,
    events: appendWatchEvent(record.events, event),
  });
}

export function stopWatch(value: AgentWatchRecord, input: { now?: number; reason?: string } = {}): AgentWatchRecord {
  const record = AgentWatchRecordSchema.parse(value);
  if (record.status === "stopped") return record;
  const now = Math.max(record.updatedAt, parseWatchTimestamp(input.now ?? Date.now(), "Watch stop timestamp"));
  const event = {
    sequence: record.sequence + 1,
    type: "watch.stopped" as const,
    timestamp: now,
    summary: sanitizeSingleLine(input.reason ?? "Watch released by its owner.").slice(0, MAX_WATCH_EVENT_SUMMARY_CHARS),
  };
  return AgentWatchRecordSchema.parse({
    ...record,
    status: "stopped",
    updatedAt: now,
    revision: record.revision + 1,
    sequence: event.sequence,
    events: appendWatchEvent(record.events, event),
  });
}

/** True when this exact announcement key was already spoken for the watch. */
export function hasWatchAnnounced(record: AgentWatchRecord, key: string): boolean {
  const bounded = key.slice(0, 200);
  return record.lastAnnouncedKey === bounded || (record.recentAnnouncedKeys?.includes(bounded) ?? false);
}

export function noteWatchAnnounced(value: AgentWatchRecord, key: string, now = Date.now()): AgentWatchRecord {
  const record = AgentWatchRecordSchema.parse(value);
  const timestamp = Math.max(record.updatedAt, parseWatchTimestamp(now, "Watch announcement timestamp"));
  if (record.lastAnnouncedKey === key && record.lastAnnouncedAt === timestamp) return record;
  const bounded = key.slice(0, 200);
  const recent = [...(record.recentAnnouncedKeys ?? []).filter((existing) => existing !== bounded), bounded]
    .slice(-MAX_RECENT_ANNOUNCED_KEYS);
  return AgentWatchRecordSchema.parse({
    ...record,
    updatedAt: timestamp,
    revision: record.revision + 1,
    lastAnnouncedKey: bounded,
    lastAnnouncedAt: timestamp,
    recentAnnouncedKeys: recent,
  });
}

export function parseAgentWatchRecord(value: unknown): AgentWatchRecord {
  return AgentWatchRecordSchema.parse(value);
}

function appendWatchEvent(events: readonly WatchEvent[], event: WatchEvent): WatchEvent[] {
  return [...events, event].slice(-MAX_WATCH_EVENTS);
}

function parseWatchTimestamp(value: number, label: string): number {
  const parsed = WatchTimestampSchema.safeParse(value);
  if (!parsed.success) throw new Error(`${label} must be a non-negative safe integer.`);
  return parsed.data;
}

function sanitizeSingleLine(value: string): string {
  return String(value)
    .replace(UNSAFE_SINGLE_LINE_GLOBAL, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function sanitizeMultiline(value: string): string {
  return String(value).replace(/\r\n?/gu, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "");
}

function isSafeSingleLine(value: string): boolean {
  return value === value.trim() && !UNSAFE_SINGLE_LINE.test(value);
}
