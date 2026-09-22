import { describe, expect, it, vi } from "vitest";
import { HermesLiveClient, HERMES_LIVE_PROTOCOL_VERSION } from "../clients/browser/hermes-live-client.js";
import {
  ConnectionSupervisor,
  computeReconnectDelayMs,
  isConnectionErrorCode,
} from "../clients/browser/connection-supervisor.js";

/** Deterministic virtual clock: the supervisor's timers only advance on demand. */
class ManualClock {
  now = 0;
  private seq = 0;
  private readonly timers = new Map<number, { fn: () => void; at: number }>();
  readonly scheduledDelays: number[] = [];

  readonly schedule = (fn: () => void, ms: number): number => {
    const id = ++this.seq;
    this.scheduledDelays.push(ms);
    this.timers.set(id, { fn, at: this.now + ms });
    return id;
  };

  readonly cancel = (id: number): void => {
    this.timers.delete(id);
  };

  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let dueId: number | undefined;
      let dueAt = Infinity;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < dueAt) {
          dueId = id;
          dueAt = timer.at;
        }
      }
      if (dueId === undefined) break;
      const timer = this.timers.get(dueId)!;
      this.timers.delete(dueId);
      this.now = Math.max(this.now, timer.at);
      timer.fn();
    }
    this.now = target;
  }

  pending(): number {
    return this.timers.size;
  }
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly listeners = new Map<string, Set<(event: any) => void>>();
  readonly sent: Array<Record<string, any>> = [];
  readonly closeCalls: Array<{ code: number; reason: string }> = [];
  readyState = 0;
  bufferedAmount = 0;

  constructor(readonly url: URL) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  message(value: unknown): void {
    this.emit("message", { data: JSON.stringify(value) });
  }

  send(payload: string): void {
    if (this.readyState !== 1) throw new Error("socket is not open");
    this.sent.push(JSON.parse(payload));
  }

  close(code = 1000, reason = ""): void {
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
    this.emit("close", { code, reason, wasClean: code === 1000 });
  }

  /** The network or gateway died underneath us: abrupt, unclean close. */
  drop(): void {
    this.readyState = 3;
    this.emit("close", { code: 1006, reason: "", wasClean: false });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

function readyMessage(sessionId: string) {
  return {
    type: "session.ready",
    protocolVersion: HERMES_LIVE_PROTOCOL_VERSION,
    sessionId,
    model: "mock-live",
    hermes: {},
    realtime: {
      provider: "mock",
      model: "mock-live",
      audio: { input: { enabled: false }, output: { enabled: false }, turnDetection: "none" },
    },
    tasks: {
      scope: "owner",
      sequence: "per_task",
      reconnect: "snapshot",
      durable: true,
      parallel: true,
      maxConcurrent: 4,
      maxRetained: 256,
      supports: { list: true, get: true, stop: true, followUp: true, resume: false, notificationAck: true },
    },
    conversation: { mode: "new", sessionId: "hermes_session" },
  };
}

function createHarness(overrides: Record<string, unknown> = {}) {
  FakeWebSocket.instances = [];
  const clock = new ManualClock();
  let request = 0;
  const client = new HermesLiveClient({
    url: "ws://127.0.0.1:4611/v1/live",
    profileId: "demo",
    requestIdFactory: () => `req_${++request}`,
    webSocketFactory: (url: any) => new FakeWebSocket(url) as unknown as WebSocket,
  });
  const supervisor = new ConnectionSupervisor(client, {
    now: () => clock.now,
    schedule: clock.schedule as unknown as (fn: () => void, ms: number) => any,
    cancel: clock.cancel as unknown as (handle: any) => void,
    random: () => 0.99,
    ...overrides,
  });
  return { client, supervisor, clock };
}

/** Wait for the Nth socket (1-based) so a retry cannot be mistaken for the dead one. */
async function nextSocket(count: number): Promise<FakeWebSocket> {
  await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(count));
  const socket = FakeWebSocket.instances[count - 1];
  if (!socket) throw new Error("Expected a fake WebSocket.");
  return socket;
}

async function flushMessages(): Promise<void> {
  for (let index = 0; index < 32; index += 1) await Promise.resolve();
}

/** Complete one successful connection cycle on the Nth (1-based) socket. */
async function completeConnection(sessionId: string, count: number): Promise<FakeWebSocket> {
  const socket = await nextSocket(count);
  socket.open();
  socket.message(readyMessage(sessionId));
  await flushMessages();
  return socket;
}

/** Make the Nth (1-based) socket fail before session readiness (gateway down). */
async function failConnection(count: number): Promise<void> {
  const socket = await nextSocket(count);
  socket.drop();
  await flushMessages();
}

describe("computeReconnectDelayMs", () => {
  it("makes the first retry a deterministic base delay", () => {
    expect(computeReconnectDelayMs(1)).toBe(1_000);
    expect(computeReconnectDelayMs(1, {}, () => 0.123)).toBe(1_000);
  });

  it("applies full jitter inside the exponential envelope with a half-base floor", () => {
    expect(computeReconnectDelayMs(2, {}, () => 0)).toBe(500);
    expect(computeReconnectDelayMs(2, {}, () => 0.999)).toBeLessThan(2_000);
    expect(computeReconnectDelayMs(3, {}, () => 0)).toBe(500);
    expect(computeReconnectDelayMs(3, {}, () => 0.999)).toBeLessThan(4_000);
    expect(computeReconnectDelayMs(3, {}, () => 0.5)).toBeGreaterThanOrEqual(500);
  });

  it("caps the long tail at the configured maximum", () => {
    expect(computeReconnectDelayMs(7, {}, () => 0.999)).toBeLessThanOrEqual(30_000);
    expect(computeReconnectDelayMs(50, {}, () => 0.999)).toBeLessThanOrEqual(30_000);
    expect(computeReconnectDelayMs(50, {}, () => 0.999)).toBeGreaterThan(29_000);
  });

  it("honors custom base, factor and cap", () => {
    const options = { baseDelayMs: 250, factor: 3, maxDelayMs: 5_000 };
    expect(computeReconnectDelayMs(1, options)).toBe(250);
    expect(computeReconnectDelayMs(2, options, () => 0)).toBe(125);
    expect(computeReconnectDelayMs(3, options, () => 0.999)).toBeLessThan(2_250);
    expect(computeReconnectDelayMs(6, options, () => 0.999)).toBeLessThanOrEqual(5_000);
  });
});

describe("ConnectionSupervisor", () => {
  it("reconnects automatically after an abnormal close with the fast first retry", async () => {
    const { client, supervisor, clock } = createHarness();
    const states: string[] = [];
    supervisor.on("change", ({ status }: any) => states.push(status.state));

    supervisor.start();
    const first = await completeConnection("live_1", 1);
    expect(client.connected).toBe(true);
    expect(supervisor.status.state).toBe("connected");

    first.drop();
    await flushMessages();
    expect(supervisor.status.state).toBe("reconnecting");
    expect(supervisor.status.attempt).toBe(1);
    expect(supervisor.status.nextAttemptInMs).toBe(1_000);

    // One millisecond short: nothing yet.
    clock.advance(999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    // The deterministic first retry fires exactly at the base delay.
    clock.advance(1);
    await completeConnection("live_2", 2);
    expect(client.connected).toBe(true);
    expect(supervisor.status.attempt).toBe(0);
    // Backoff reset: a second loss again waits exactly the base delay.
    FakeWebSocket.instances.at(-1)!.drop();
    await flushMessages();
    expect(supervisor.status.nextAttemptInMs).toBe(1_000);
    expect(states).toEqual(["connecting", "connected", "reconnecting", "connecting", "connected", "reconnecting"]);
  });

  it("grows the delay exponentially across failed attempts and caps it", async () => {
    const { supervisor, clock } = createHarness();
    supervisor.start();
    await failConnection(1); // attempt 1 fails; retry 2 scheduled
    for (let index = 0; index < 7; index += 1) {
      clock.advance(60_000); // fires the scheduled retry → a new attempt starts
      await flushMessages();
      await failConnection(index + 2);
    }
    // rng() = 0.99 ⇒ every retry sits just under its envelope:
    // ~2s, ~4s, ~8s, ~16s, then the 30s cap for every later attempt.
    const delays = clock.scheduledDelays;
    expect(delays[0]).toBeGreaterThanOrEqual(500);
    expect(delays[0]).toBeLessThanOrEqual(2_000);
    expect(delays[1]).toBeLessThanOrEqual(4_000);
    expect(delays[2]).toBeLessThanOrEqual(8_000);
    expect(delays[3]).toBeLessThanOrEqual(16_000);
    for (const delay of delays.slice(4)) expect(delay).toBeLessThanOrEqual(30_000);
    expect(Math.max(...delays)).toBeGreaterThan(20_000);
    expect(supervisor.status.attempt).toBeGreaterThanOrEqual(8);
    expect(supervisor.status.history.filter((entry: any) => !entry.ok).length).toBeGreaterThanOrEqual(8);
  });

  it("never opens a second socket while a connection attempt is in flight", async () => {
    const { supervisor, clock } = createHarness();
    supervisor.start();
    const socket = await nextSocket(1);
    expect(FakeWebSocket.instances).toHaveLength(1);

    // Force while the first attempt is still connecting: it is kept, not raced.
    await supervisor.forceReconnect();
    expect(FakeWebSocket.instances).toHaveLength(1);

    // A scheduled auto-retry cannot stack onto the in-flight attempt either.
    clock.advance(120_000);
    await flushMessages();
    expect(FakeWebSocket.instances).toHaveLength(1);

    socket.drop(); // the in-flight attempt fails…
    await flushMessages();
    clock.advance(60_000);
    await flushMessages();
    await completeConnection("live_raced", 2);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("force-reconnect during a backoff wait attempts immediately and resets the counter", async () => {
    const { supervisor, clock } = createHarness();
    supervisor.start();
    await failConnection(1);
    clock.advance(2_000); // first retry (deterministic 1s) fires and…
    await flushMessages();
    await failConnection(2); // …fails; attempt-3 backoff (envelope 4s) is armed.
    expect(supervisor.status.state).toBe("reconnecting");
    expect(supervisor.status.attempt).toBe(3);

    // The forced attempt is immediate: the backoff timer is gone, a socket is
    // opened without advancing the clock, and the counter restarts at 1.
    const forced = supervisor.forceReconnect("button");
    const third = await nextSocket(3);
    expect(clock.pending()).toBe(0);
    expect(supervisor.status.attempt).toBe(1);
    third.open();
    third.message(readyMessage("live_forced"));
    await flushMessages();
    await forced;
    expect(supervisor.status.state).toBe("connected");
  });

  it("force-reconnect tears down a half-open socket before reconnecting", async () => {
    const { client, supervisor, clock } = createHarness();
    supervisor.start();
    const first = await completeConnection("live_halfopen", 1);
    expect(client.connected).toBe(true);

    // The dead peer never confirms the protocol close, so the bounded
    // fallback timer (on the manual clock) is what lets the force proceed.
    const forced = supervisor.forceReconnect("button");
    await flushMessages();
    clock.advance(2_000);
    await flushMessages();
    expect(first.closeCalls.length).toBeGreaterThan(0);
    const second = await nextSocket(2);
    second.open();
    second.message(readyMessage("live_after_force"));
    await flushMessages();
    await forced;
    expect(second).not.toBe(first);
    expect(client.connected).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("does not retry after stop()", async () => {
    const { supervisor, clock } = createHarness();
    supervisor.start();
    await completeConnection("live_stop", 1);
    supervisor.stop();
    FakeWebSocket.instances.at(-1)!.drop();
    await flushMessages();
    clock.advance(120_000);
    await flushMessages();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(supervisor.status.state).toBe("stopped");
  });

  it("re-hydrates task state through the reconnect snapshot after a drop", async () => {
    const { client, supervisor, clock } = createHarness();
    supervisor.start();
    const first = await completeConnection("live_tasks", 1);
    first.message({
      type: "task.snapshot",
      reason: "initial",
      tasks: [],
      truncated: false,
    });
    first.message({
      type: "task.accepted",
      taskId: "task_one",
      sequence: 1,
      occurredAt: 100,
      state: "accepted",
      title: "Inspect the repo",
    });
    await flushMessages();
    expect(client.activeTasks).toHaveLength(1);

    first.drop();
    await flushMessages();
    clock.advance(1_000);
    const second = await completeConnection("live_tasks_2", 2);
    second.message({
      type: "task.snapshot",
      reason: "reconnect",
      tasks: [{
        taskId: "task_one",
        sequence: 3,
        state: "running",
        title: "Inspect the repo",
        createdAt: 100,
        updatedAt: 300,
      }],
      truncated: false,
    });
    await flushMessages();
    expect(client.connected).toBe(true);
    expect(client.activeTasks).toHaveLength(1);
    expect(client.activeTasks[0]).toMatchObject({ taskId: "task_one", state: "running" });
  });

  it("probes gateway status while reconnecting and surfaces it on the snapshot", async () => {
    const { supervisor, clock } = createHarness({
      fetchStatus: async () => ({ reachable: true, providerReachable: false }),
    });
    supervisor.start();
    await failConnection(1);
    await vi.waitFor(() => expect(supervisor.status.gateway).not.toBeNull());
    expect(supervisor.status.gateway).toMatchObject({ reachable: true, providerReachable: false });
    expect(supervisor.status.state).toBe("reconnecting");
    expect(clock.pending()).toBe(1);
  });

  it("treats a thrown probe as an unreachable gateway", async () => {
    const { supervisor } = createHarness({
      fetchStatus: async () => {
        throw new Error("network down");
      },
    });
    supervisor.start();
    await failConnection(1);
    await vi.waitFor(() => expect(supervisor.status.gateway).toBeNull());
  });

  it("announces recovery with the in-flight-audio caveat", async () => {
    const { supervisor, clock } = createHarness();
    const messages: string[] = [];
    supervisor.on("change", ({ message }: any) => {
      if (message) messages.push(message);
    });
    supervisor.start();
    await completeConnection("live_caveat_1", 1);
    FakeWebSocket.instances.at(-1)!.drop();
    await flushMessages();
    clock.advance(1_000);
    await completeConnection("live_caveat_2", 2);
    expect(messages).toContain("Reconnected. In-flight audio was lost.");
  });
});

describe("isConnectionErrorCode", () => {
  it("classifies transport-level client error codes", () => {
    expect(isConnectionErrorCode("connection_lost")).toBe(true);
    expect(isConnectionErrorCode("websocket_error")).toBe(true);
    expect(isConnectionErrorCode("connect_timeout")).toBe(true);
    expect(isConnectionErrorCode("session_start_failed")).toBe(false);
    expect(isConnectionErrorCode(undefined)).toBe(false);
  });
});
