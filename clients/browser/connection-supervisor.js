// Automatic reconnection for a HermesLiveClient with exponential backoff,
// full jitter, and a visible, pollable status surface.
//
// The client SDK already owns the hard parts: it guards against double
// connections (connectPromise + generation), reports abnormal closes as
// "connection_lost", and re-hydrates task state from the gateway's reconnect
// snapshots. This supervisor owns only the retry policy: when to try again,
// how to announce the attempt, and how to yield to a manual "Reconnect now".

export const DEFAULT_RECONNECT_OPTIONS = {
  // First retry after a lost connection is a deterministic 1s so a brief
  // gateway blip heals before the user notices. Later attempts draw from the
  // exponential envelope with full jitter and a half-base floor, capped.
  baseDelayMs: 1_000,
  factor: 2,
  maxDelayMs: 30_000,
  floorRatio: 0.5,
};

export const CONNECTION_ERROR_CODES = new Set([
  "connection_lost",
  "websocket_error",
  "websocket_create_failed",
  "connect_timeout",
  "url_resolution_failed",
]);

/**
 * Delay before attempt `attempt` (1-based). Attempt 1 is the deterministic
 * fast retry; every later attempt draws uniformly from
 * [base * floorRatio, min(maxDelay, base * factor^(attempt-1))).
 */
export function computeReconnectDelayMs(
  attempt,
  options = {},
  random = Math.random,
) {
  const baseDelayMs = positiveNumber(options.baseDelayMs, DEFAULT_RECONNECT_OPTIONS.baseDelayMs);
  const factor = positiveNumber(options.factor, DEFAULT_RECONNECT_OPTIONS.factor);
  const maxDelayMs = positiveNumber(options.maxDelayMs, DEFAULT_RECONNECT_OPTIONS.maxDelayMs);
  const floorRatio = Number.isFinite(options.floorRatio) && options.floorRatio >= 0 && options.floorRatio <= 1
    ? options.floorRatio
    : DEFAULT_RECONNECT_OPTIONS.floorRatio;
  const exponent = Math.max(0, Number(attempt) - 1);
  const envelope = Math.min(maxDelayMs, baseDelayMs * factor ** exponent);
  if (Number(attempt) <= 1) return Math.max(1, Math.round(baseDelayMs));
  const floor = Math.min(envelope, Math.round(baseDelayMs * floorRatio));
  const span = Math.max(0, envelope - floor);
  return Math.max(1, Math.round(floor + random() * span));
}

export function isConnectionErrorCode(code) {
  return CONNECTION_ERROR_CODES.has(String(code ?? ""));
}

const HISTORY_LIMIT = 40;

function toMessage(error) {
  if (!error) return "unknown error";
  return String(error.message || error);
}

function trimmedHistory(entry) {
  return {
    attempt: entry.attempt,
    trigger: entry.trigger,
    ok: entry.ok,
    durationMs: entry.durationMs,
    at: entry.at,
    ...(entry.error ? { error: entry.error } : {}),
  };
}

export class ConnectionSupervisor {
  /**
   * @param {import("./hermes-live-client.js").HermesLiveClient} client
   * @param {object} [options]
   * @param {number} [options.baseDelayMs] backoff base, default 1000
   * @param {number} [options.factor] backoff factor, default 2
   * @param {number} [options.maxDelayMs] backoff cap, default 30000
   * @param {{ mode: string, sessionId?: string }} [options.conversation]
   * @param {() => number} [options.now] injectable clock
   * @param {(fn: () => void, ms: number) => any} [options.schedule] injectable timer
   * @param {(handle: any) => void} [options.cancel] injectable timer cancel
   * @param {() => number} [options.random] injectable jitter source
   * @param {() => Promise<object | null>} [options.fetchStatus]
   *   Probes the gateway's /status.json; resolves null when unreachable.
   */
  constructor(client, options = {}) {
    if (!client || typeof client.connect !== "function") {
      throw new TypeError("ConnectionSupervisor requires a HermesLiveClient-compatible instance.");
    }
    this.client = client;
    this.options = {
      baseDelayMs: positiveNumber(options.baseDelayMs, DEFAULT_RECONNECT_OPTIONS.baseDelayMs),
      factor: positiveNumber(options.factor, DEFAULT_RECONNECT_OPTIONS.factor),
      maxDelayMs: positiveNumber(options.maxDelayMs, DEFAULT_RECONNECT_OPTIONS.maxDelayMs),
    };
    this.conversation = options.conversation;
    this.now = options.now ?? (() => Date.now());
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle));
    this.random = options.random ?? Math.random;
    this.fetchStatus = options.fetchStatus;

    this.listeners = new Map();
    // idle → connecting → connected ⇄ reconnecting; stopped is terminal.
    this.state = "idle";
    this.attempt = 0;
    this.nextAttemptAt = null;
    this.everConnected = false;
    this.lastError = null;
    this.gateway = null;
    this.history = [];
    this.connecting = false;
    this.stopped = false;
    this.timer = undefined;
    this.intentionalClose = false;

    client.on("close", () => this.handleClose());
  }

  on(type, listener) {
    if (typeof listener !== "function") throw new TypeError("ConnectionSupervisor listeners must be functions.");
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(type);
    };
  }

  /** Current observable status; safe to poll from a frame loop. */
  get status() {
    const nextAttemptInMs = this.state === "reconnecting" && this.nextAttemptAt !== null
      ? Math.max(0, this.nextAttemptAt - this.now())
      : null;
    return {
      state: this.state,
      attempt: this.connecting || this.state === "reconnecting" ? Math.max(1, this.attempt) : 0,
      nextAttemptInMs,
      everConnected: this.everConnected,
      lastError: this.lastError,
      gateway: this.gateway,
      history: this.history.map(trimmedHistory),
    };
  }

  /** Begin the initial connection and arm the automatic retry policy. */
  start() {
    if (this.stopped || this.state !== "idle") return;
    this.attempt = 1;
    void this.runAttempt("initial");
  }

  /**
   * Manual "Reconnect now": resets the backoff clock, tears down any
   * half-open socket, and reconnects immediately. Never opens a second
   * socket: an in-flight attempt is already immediate, so it is kept.
   */
  async forceReconnect(reason = "manual") {
    if (this.stopped) return;
    this.clearTimer();
    this.attempt = 0;
    if (this.connecting) {
      this.emit({
        status: this.status,
        level: "info",
        message: "Reconnect already in progress — attempting now.",
      });
      return;
    }
    if (this.client.socket || this.client.connected) {
      this.intentionalClose = true;
      // A dead peer may never confirm the protocol close; bound the wait so
      // the forced attempt is still immediate.
      let fallback;
      const bounded = Promise.race([
        this.client.disconnect().catch(() => undefined),
        new Promise((resolve) => { fallback = this.schedule(resolve, 2_000); }),
      ]);
      await bounded;
      if (fallback !== undefined) this.cancel(fallback);
      // If the gateway never confirmed, drop the half-open socket locally so
      // the forced attempt is the only live connection.
      const stale = this.client.socket;
      if (stale) {
        try { stale.close(4000, "forced reconnect"); } catch { /* already closing */ }
      }
    }
    this.attempt = 1;
    await this.runAttempt(reason);
  }

  /** Stop retrying permanently (pagehide). The client itself is the caller's. */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimer();
    this.state = "stopped";
    this.emit({ status: this.status, level: "info", message: "Automatic reconnection stopped." });
  }

  async runAttempt(trigger) {
    if (this.stopped) return;
    // No double connection: exactly one attempt may be in flight, and a
    // connected client needs no attempt at all.
    if (this.connecting || this.client.connected) return;
    this.clearTimer();
    this.connecting = true;
    if (this.attempt < 1) this.attempt = 1;
    const attempt = this.attempt;
    const beganAt = this.now();
    this.state = "connecting";
    this.emit({ status: this.status, level: "info", message: this.describeAttempt(attempt, trigger) });
    try {
      await this.client.connect(this.conversation ? { conversation: this.conversation } : undefined);
      this.connecting = false;
      this.handleAttemptSucceeded(attempt, trigger, beganAt);
    } catch (error) {
      this.connecting = false;
      this.lastError = { message: toMessage(error), at: this.now() };
      this.handleAttemptFailed(attempt, trigger, beganAt, error);
    }
  }

  handleAttemptSucceeded(attempt, trigger, beganAt) {
    const recovered = this.everConnected;
    this.everConnected = true;
    this.attempt = 0;
    this.state = "connected";
    this.gateway = null;
    this.recordHistory({ attempt, trigger, ok: true, durationMs: this.now() - beganAt, at: beganAt });
    this.emit({
      status: this.status,
      level: "info",
      message: recovered ? "Reconnected. In-flight audio was lost." : "Connected.",
    });
  }

  handleAttemptFailed(attempt, trigger, beganAt, error) {
    this.recordHistory({
      attempt,
      trigger,
      ok: false,
      durationMs: this.now() - beganAt,
      at: beganAt,
      error: toMessage(error),
    });
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.stopped) return;
    if (this.timer !== undefined) return; // One clock: never stack retries.
    // attempt is 0 right after a lost live session (fast deterministic retry)
    // and N right after attempt N failed (long-tail backoff).
    const nextAttempt = this.attempt + 1;
    const delay = computeReconnectDelayMs(nextAttempt, this.options, this.random);
    this.attempt = nextAttempt;
    this.nextAttemptAt = this.now() + delay;
    this.state = "reconnecting";
    this.emit({
      status: this.status,
      level: "warn",
      message: `Connection lost — reconnecting (attempt ${nextAttempt}, next in ${formatSeconds(delay)}).`,
    });
    this.timer = this.schedule(() => {
      this.timer = undefined;
      void this.runAttempt("retry");
    }, delay);
    void this.probeGateway();
  }

  handleClose() {
    if (this.stopped) return;
    if (this.intentionalClose) {
      this.intentionalClose = false;
      return;
    }
    // A closed attempt rejects client.connect() and is retried there; only a
    // lost live session starts a fresh reconnect cycle here.
    if (this.state !== "connected") return;
    this.scheduleReconnect();
  }

  async probeGateway() {
    if (!this.fetchStatus) return;
    try {
      this.gateway = await this.fetchStatus();
    } catch {
      this.gateway = null;
    }
    this.emit({ status: this.status, level: "info", message: null });
  }

  describeAttempt(attempt, trigger) {
    if (attempt <= 1 && trigger === "initial") return "Connecting to the voice gateway…";
    return `Reconnect attempt ${attempt} (${trigger}) in progress…`;
  }

  recordHistory(entry) {
    this.history.push(entry);
    if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
  }

  clearTimer() {
    if (this.timer !== undefined) {
      this.cancel(this.timer);
      this.timer = undefined;
    }
    this.nextAttemptAt = null;
  }

  emit(event) {
    for (const listener of [...(this.listeners.get("change") ?? [])]) {
      try {
        listener(event);
      } catch {
        // Supervisor UI feedback must never break the retry loop.
      }
    }
  }
}

function positiveNumber(value, fallback) {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
}

export function formatSeconds(ms) {
  const seconds = Math.max(0, Math.round(ms / 100) / 10);
  return `${seconds}s`;
}
