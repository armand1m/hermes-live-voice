import type { HermesLiveClient, HermesLiveConversationSelection } from "./hermes-live-client.js";

export interface ReconnectOptions {
  /** Backoff base in milliseconds; the first retry after a loss is exactly this. */
  baseDelayMs?: number;
  /** Exponential factor between consecutive failed attempts. */
  factor?: number;
  /** Upper bound of the jittered backoff envelope. */
  maxDelayMs?: number;
  conversation?: HermesLiveConversationSelection;
  /** Injectable clock (default Date.now). */
  now?: () => number;
  /** Injectable timer scheduling (default setTimeout). */
  schedule?: (fn: () => void, ms: number) => unknown;
  /** Injectable timer cancellation (default clearTimeout). */
  cancel?: (handle: unknown) => void;
  /** Injectable jitter source (default Math.random). */
  random?: () => number;
  /** Probes the gateway's /status.json; resolves null when unreachable. */
  fetchStatus?: () => Promise<Record<string, unknown> | null>;
}

export interface ReconnectAttemptHistoryEntry {
  attempt: number;
  trigger: string;
  ok: boolean;
  durationMs: number;
  at: number;
  error?: string;
}

export interface ConnectionSupervisorStatus {
  state: "idle" | "connecting" | "connected" | "reconnecting" | "stopped";
  attempt: number;
  nextAttemptInMs: number | null;
  everConnected: boolean;
  lastError: { message: string; at: number } | null;
  gateway: Record<string, unknown> | null;
  history: ReconnectAttemptHistoryEntry[];
}

export interface ConnectionSupervisorChangeEvent {
  status: ConnectionSupervisorStatus;
  level: "info" | "warn";
  message: string | null;
}

/**
 * Delay before attempt `attempt` (1-based). Attempt 1 is the deterministic
 * base delay; later attempts draw uniformly from
 * [base * floorRatio, min(maxDelay, base * factor^(attempt-1))).
 */
export function computeReconnectDelayMs(
  attempt: number,
  options?: ReconnectOptions,
  random?: () => number,
): number;

/** Whether a HermesLiveClient error code is connection-class (retry outcome). */
export function isConnectionErrorCode(code: unknown): boolean;

/** "4.2s"-style human remainder used by status headlines. */
export function formatSeconds(ms: number): string;

/**
 * Automatic reconnection for a HermesLiveClient: exponential backoff with
 * full jitter, a visible attempt status, and a manual force path that can
 * never open a second socket.
 */
export class ConnectionSupervisor {
  constructor(client: HermesLiveClient, options?: ReconnectOptions);
  on(type: "change", listener: (event: ConnectionSupervisorChangeEvent) => void): () => void;
  get status(): ConnectionSupervisorStatus;
  get state(): ConnectionSupervisorStatus["state"];
  get attempt(): number;
  /** Begin the initial connection and arm the automatic retry policy. */
  start(): void;
  /** Manual "Reconnect now": reset the backoff clock and reconnect immediately. */
  forceReconnect(reason?: string): Promise<void>;
  /** Stop retrying permanently (pagehide). */
  stop(): void;
}
