import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileAgentWatchStore } from "../src/adapters/outbound/external-work/file-agent-watch-store.js";
import {
  ExternalAgentMonitor,
  type ExternalMonitorEvent,
  type ExternalMonitorScheduler,
} from "../src/application/external-work/external-agent-monitor.js";
import type {
  ExternalAgentPort,
  ExternalAgentSnapshot,
} from "../src/application/external-work/ports/external-agent.port.js";

const SESSION_A = "4432988d-611f-437a-8b3a-9937984a86e2";
const SESSION_B = "b60be214-1a63-44df-814b-fda301cdbbc7";

class ManualScheduler implements ExternalMonitorScheduler {
  now = 0;
  private nextId = 1;
  private readonly jobs = new Map<number, { due: number; callback: () => void }>();

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++;
    this.jobs.set(id, { due: this.now + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.jobs.delete(handle as number);
  }

  advanceBy(milliseconds: number): void {
    this.now += milliseconds;
    for (;;) {
      const due = [...this.jobs.entries()].filter(([, job]) => job.due <= this.now)
        .sort((left, right) => left[1].due - right[1].due || left[0] - right[0]);
      if (due.length === 0) return;
      const [id, job] = due[0]!;
      this.jobs.delete(id);
      job.callback();
    }
  }

  async settle(): Promise<void> {
    // Store writes are real files: fsync needs the event loop's poll phase,
    // not just microtask drain. Interleave immediate ticks with timer turns.
    for (let round = 0; round < 12; round += 1) {
      for (let index = 0; index < 10; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
}

class FakeAgents implements ExternalAgentPort {
  listCalls: string[] = [];
  readCalls: Array<{ host: string; paneId: string; lines: number }> = [];
  output = "building…\n❯ tests passed";
  snapshots: ExternalAgentSnapshot[] = [];
  failListing: Error | null = null;
  failReading: Error | null = null;

  async listAgents(host: string): Promise<ExternalAgentSnapshot[]> {
    this.listCalls.push(host);
    if (this.failListing) throw this.failListing;
    return structuredClone(this.snapshots);
  }

  async readRecentOutput(host: string, paneId: string, maxLines: number): Promise<string> {
    this.readCalls.push({ host, paneId, lines: maxLines });
    if (this.failReading) throw this.failReading;
    return this.output;
  }
}

class MemoryWatchStore {
  private readonly records = new Map<string, any>();
  async load(watchId: string) { return this.records.get(watchId) ? structuredClone(this.records.get(watchId)) : undefined; }
  async list(options: any = {}) {
    return [...this.records.values()]
      .filter((record: any) =>
        (options.ownerId === undefined || record.ownerId === options.ownerId)
        && (options.statuses === undefined || options.statuses.includes(record.status))
        && (options.host === undefined || record.host === options.host))
      .map((record: any) => structuredClone(record));
  }
  async put(record: any) { this.records.set(record.watchId, structuredClone(record)); return structuredClone(record); }
  async update(watchId: string, updater: (current: any) => any, options: any = {}) {
    const current = this.records.get(watchId);
    if (!current) throw new Error(`Agent watch not found: ${watchId}`);
    if (options.expectedRevision !== undefined && current.revision !== options.expectedRevision) {
      throw Object.assign(new Error("conflict"), { name: "AgentWatchStoreConflictError" });
    }
    const updated = updater(structuredClone(current));
    this.records.set(watchId, structuredClone(updated));
    return structuredClone(updated);
  }
  async delete(watchId: string) { return this.records.delete(watchId); }
  async prune() { return { deleted: 0, watchIds: [] }; }
}

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function snapshotFixture(overrides: Partial<ExternalAgentSnapshot> = {}): ExternalAgentSnapshot {
  return {
    host: "exodia",
    harness: "herdr",
    agentSessionValue: SESSION_A,
    paneId: "w4:p1",
    status: "working",
    revision: 23,
    stateChangeSeq: 360,
    cwd: "/home/armand1m/Projects/mine/hermes-live-voice",
    ...overrides,
  };
}

async function newMonitor(options: { pollIntervalMs?: number } = {}) {
  const scheduler = new ManualScheduler();
  const store: any = new MemoryWatchStore();
  const agents = new FakeAgents();
  const events: ExternalMonitorEvent[] = [];
  const errors: unknown[] = [];
  const monitor = new ExternalAgentMonitor({
    store,
    agents,
    scheduler,
    now: () => scheduler.now,
    pollIntervalMs: options.pollIntervalMs ?? 5_000,
    onError: (error) => errors.push(error),
  });
  monitor.subscribe((event) => events.push(event));
  await monitor.initialize();
  return { monitor, store, agents, scheduler, events, errors };
}

describe("ExternalAgentMonitor", () => {
  it("verifies identity at registration and refuses pane reuse", async () => {
    const { monitor, agents } = await newMonitor();
    agents.snapshots = [snapshotFixture()];
    const watch = await monitor.registerWatch({
      ownerIdentity: "alice",
      host: "exodia",
      harness: "herdr",
      agentSessionValue: SESSION_A,
      paneId: "w4:p1",
      objective: "Fix the diamond indicator.",
      acceptanceCriteria: ["Plot renders"],
    });
    expect(watch.status).toBe("watching");

    // Same pane, different session: refuse to attach to different work.
    await expect(monitor.registerWatch({
      ownerIdentity: "alice",
      host: "exodia",
      harness: "herdr",
      agentSessionValue: SESSION_B,
      paneId: "w4:p1",
      objective: "Different work.",
      acceptanceCriteria: ["x"],
    })).rejects.toThrow(/different session/);
    // Missing entirely: an honest refusal, not a queued guess.
    await expect(monitor.registerWatch({
      ownerIdentity: "alice",
      host: "exodia",
      harness: "herdr",
      agentSessionValue: SESSION_A,
      paneId: "w9:p9",
      objective: "Ghost.",
      acceptanceCriteria: ["x"],
    })).rejects.toThrow(/No herdr agent/);
    await monitor.close();
  });

  it("batches one host list per tick, reads output only when evidence is due", async () => {
    const { monitor, agents, scheduler, events } = await newMonitor();
    agents.snapshots = [
      snapshotFixture({ paneId: "w4:p1" }),
      snapshotFixture({ paneId: "wC:p1", agentSessionValue: SESSION_B, status: "working" }),
    ];
    await monitor.registerWatch({ ownerIdentity: "alice", host: "exodia", harness: "herdr", agentSessionValue: SESSION_A, paneId: "w4:p1", objective: "A", acceptanceCriteria: ["x"] });
    await monitor.registerWatch({ ownerIdentity: "alice", host: "exodia", harness: "herdr", agentSessionValue: SESSION_B, paneId: "wC:p1", objective: "B", acceptanceCriteria: ["x"] });
    const listings = agents.listCalls.length;

    scheduler.advanceBy(0);
    await scheduler.settle();
    // One batched list served both watches; one output read per changed watch.
    expect(agents.listCalls.length - listings).toBe(1);
    expect(agents.readCalls).toHaveLength(2);
    expect(agents.readCalls.find((call) => call.paneId === "w4:p1")).toMatchObject({ host: "exodia", lines: 80 });
    const registered = events.filter((event) => event.kind === "registered");
    expect(registered).toHaveLength(2);
    const stateEvents = events.filter((event) => event.kind === "state-change");
    expect(stateEvents).toHaveLength(2);
    const diamondWatch = stateEvents.find((event) => event.watch.paneId === "w4:p1")!;
    expect(diamondWatch.watch.lastObserved).toMatchObject({ state: "working", excerpt: "❯ tests passed" });

    // Quiet tick: same statuses, no cursor movement — no reads, no events.
    const readsBefore = agents.readCalls.length;
    scheduler.advanceBy(5_000);
    await scheduler.settle();
    expect(agents.listCalls.length - listings).toBe(2);
    expect(agents.readCalls.length).toBe(readsBefore);

    // A working agent's cursor advancing triggers an evidence read.
    agents.snapshots = agents.snapshots.map((snapshot) =>
      snapshot.paneId === "w4:p1" ? { ...snapshot, stateChangeSeq: 361, revision: 24 } : snapshot);
    scheduler.advanceBy(5_000);
    await scheduler.settle();
    expect(agents.readCalls.length).toBe(readsBefore + 1);
    expect(events.filter((event) => event.kind === "output-evidence")).toHaveLength(1);
    await monitor.close();
  });

  it("interprets idle as needing inspection and missing as missing", async () => {
    const { monitor, agents, scheduler, events } = await newMonitor();
    agents.snapshots = [snapshotFixture()];
    const watch = await monitor.registerWatch({ ownerIdentity: "alice", host: "exodia", harness: "herdr", agentSessionValue: SESSION_A, paneId: "w4:p1", objective: "A", acceptanceCriteria: ["x"] });
    scheduler.advanceBy(0);
    await scheduler.settle();

    agents.snapshots = [snapshotFixture({ status: "idle" })];
    scheduler.advanceBy(5_000);
    await scheduler.settle();
    const idleWatch = events.filter((event) => event.kind === "state-change").at(-1)!.watch;
    expect(idleWatch.lastObserved?.state).toBe("idle");
    expect(idleWatch.events.at(-1)?.summary).toContain("needs inspection");
    expect(idleWatch.status).toBe("watching"); // idle never completes anything

    // The pane vanishing is missing, not done.
    agents.snapshots = [];
    scheduler.advanceBy(5_000);
    await scheduler.settle();
    const missingWatch = events.filter((event) => event.kind === "state-change").at(-1)!.watch;
    expect(missingWatch.lastObserved?.state).toBe("missing");
    expect(missingWatch.events.at(-1)?.summary).toContain("no longer appears");
    expect(watch.status).toBe("watching");
    await monitor.close();
  });

  it("marks pane reuse as a mismatch and stops following it", async () => {
    const { monitor, agents, scheduler, events } = await newMonitor();
    agents.snapshots = [snapshotFixture()];
    await monitor.registerWatch({ ownerIdentity: "alice", host: "exodia", harness: "herdr", agentSessionValue: SESSION_A, paneId: "w4:p1", objective: "A", acceptanceCriteria: ["x"] });
    scheduler.advanceBy(0);
    await scheduler.settle();

    agents.snapshots = [snapshotFixture({ agentSessionValue: SESSION_B })];
    scheduler.advanceBy(5_000);
    await scheduler.settle();
    const mismatch = events.find((event) => event.kind === "mismatched");
    expect(mismatch?.watch.status).toBe("mismatched");
    expect(mismatch?.watch.events.at(-1)?.summary).toContain("different session");
    // A mismatched watch is never polled again silently.
    const listCalls = agents.listCalls.length;
    agents.snapshots = [snapshotFixture({ agentSessionValue: SESSION_B, status: "idle" })];
    scheduler.advanceBy(20_000);
    await scheduler.settle();
    expect(agents.listCalls.length).toBe(listCalls); // no watching watches left on the host
    await monitor.close();
  });

  it("backs off host failures, goes offline after three, and recovers", async () => {
    const { monitor, agents, scheduler, events } = await newMonitor({ pollIntervalMs: 5_000 });
    agents.snapshots = [snapshotFixture()];
    await monitor.registerWatch({ ownerIdentity: "alice", host: "exodia", harness: "herdr", agentSessionValue: SESSION_A, paneId: "w4:p1", objective: "A", acceptanceCriteria: ["x"] });
    scheduler.advanceBy(0);
    await scheduler.settle();

    agents.failListing = new Error("ssh: connect timed out");
    const listings = agents.listCalls.length;
    scheduler.advanceBy(5_000); // failure 1 → next at +10s (backoff doubling)
    await scheduler.settle();
    scheduler.advanceBy(10_000); // failure 2 → next at +20s
    await scheduler.settle();
    let watches = await monitor.listWatches("alice");
    expect(watches[0]?.lastObserved?.state).toBe("working"); // not yet degraded
    scheduler.advanceBy(20_000); // failure 3 → offline, next at +40s
    await scheduler.settle();
    watches = await monitor.listWatches("alice");
    expect(watches[0]?.lastObserved?.state).toBe("offline");
    expect(watches[0]?.monitoring.consecutiveFailures).toBe(3);
    expect(events.filter((event) => event.kind === "offline")).toHaveLength(1);
    expect(agents.listCalls.length - listings).toBe(3); // one command per backoff slot

    // Recovery: one success restores the agent state and health.
    agents.failListing = null;
    scheduler.advanceBy(40_000);
    await scheduler.settle();
    watches = await monitor.listWatches("alice");
    expect(watches[0]?.lastObserved?.state).toBe("working");
    expect(watches[0]?.monitoring.consecutiveFailures).toBe(0);
    expect(events.filter((event) => event.kind === "recovered")).toHaveLength(1);
    await monitor.close();
  });

  it("survives restarts: persisted watches resume polling", async () => {
    const directory = mkdtempSync(join(tmpdir(), "monitor-restart-"));
    directories.push(directory);
    const scheduler = new ManualScheduler();
    const store = new FileAgentWatchStore({ directory, now: () => scheduler.now });
    const agents = new FakeAgents();
    agents.snapshots = [snapshotFixture()];
    const first = new ExternalAgentMonitor({ store, agents, scheduler, now: () => scheduler.now });
    await first.initialize();
    await first.registerWatch({ ownerIdentity: "alice", host: "exodia", harness: "herdr", agentSessionValue: SESSION_A, paneId: "w4:p1", objective: "A", acceptanceCriteria: ["x"] });
    await first.close();

    // A fresh monitor (gateway restart) picks the watch back up and observes.
    const restartedStore = new FileAgentWatchStore({ directory, now: () => scheduler.now });
    const events: ExternalMonitorEvent[] = [];
    const second = new ExternalAgentMonitor({
      store: restartedStore,
      agents,
      scheduler,
      now: () => scheduler.now,
      pollIntervalMs: 5_000,
    });
    second.subscribe((event) => events.push(event));
    await second.initialize();
    scheduler.advanceBy(0);
    await scheduler.settle();
    const watches = await second.listWatches("alice");
    expect(watches).toHaveLength(1);
    expect(watches[0]?.lastObserved?.state).toBe("working");
    expect(events.filter((event) => event.kind === "state-change")).toHaveLength(1);
    await second.close();
  });

  it("stops watches by owner scope and never sends agent input", async () => {
    const { monitor, agents, events } = await newMonitor();
    agents.snapshots = [snapshotFixture()];
    await monitor.registerWatch({ ownerIdentity: "alice", host: "exodia", harness: "herdr", agentSessionValue: SESSION_A, paneId: "w4:p1", objective: "A", acceptanceCriteria: ["x"] });
    await expect(monitor.stopWatch("bob", "watch_00000000000000000000000000000000")).rejects.toThrow(/not found/);
    const stopped = await monitor.stopWatch("alice", (await monitor.listWatches("alice"))[0]!.watchId, "Owner released it.");
    expect(stopped.status).toBe("stopped");
    expect(events.filter((event) => event.kind === "stopped")).toHaveLength(1);
    // Observe-only: the port surface has no input path at all.
    expect(Object.keys(agents).sort()).not.toContain("sendKeys");
    await monitor.close();
  });

  it("leases announcements in memory and records them only on completion", async () => {
    const { monitor, agents, store } = await newMonitor();
    agents.snapshots = [snapshotFixture()];
    const watch = await monitor.registerWatch({ ownerIdentity: "alice", host: "exodia", harness: "herdr", agentSessionValue: SESSION_A, paneId: "w4:p1", objective: "A", acceptanceCriteria: ["x"] });
    const key = `${watch.watchId}:state:done:361`;

    // Claiming reserves the speaker but writes nothing durable.
    expect(await monitor.claimAnnouncement(watch.watchId, key, "session_1")).toBe(true);
    expect((await store.load(watch.watchId)).lastAnnouncedKey).toBeUndefined();
    // A second session cannot speak the same update while the lease is held…
    expect(await monitor.claimAnnouncement(watch.watchId, key, "session_2")).toBe(false);
    // …but the holder can re-claim after a retry.
    expect(await monitor.claimAnnouncement(watch.watchId, key, "session_1")).toBe(true);

    // Failed delivery: releasing keeps the update eligible for anyone.
    monitor.releaseAnnouncement(watch.watchId, key, "session_1");
    expect(await monitor.claimAnnouncement(watch.watchId, key, "session_2")).toBe(true);

    // Delivered: recorded durably, never claimable again.
    await monitor.completeAnnouncement(watch.watchId, key, "session_2");
    expect((await store.load(watch.watchId)).lastAnnouncedKey).toBe(key);
    expect(await monitor.claimAnnouncement(watch.watchId, key, "session_1")).toBe(false);
    await monitor.close();
  });

  it("never repeats an older announcement after a newer one was spoken", async () => {
    const { monitor, agents } = await newMonitor();
    agents.snapshots = [snapshotFixture()];
    const watch = await monitor.registerWatch({ ownerIdentity: "alice", host: "exodia", harness: "herdr", agentSessionValue: SESSION_A, paneId: "w4:p1", objective: "A", acceptanceCriteria: ["x"] });
    const older = `${watch.watchId}:state:working:360`;
    const newer = `${watch.watchId}:state:idle:361`;
    await monitor.claimAnnouncement(watch.watchId, older, "s");
    await monitor.completeAnnouncement(watch.watchId, older, "s");
    await monitor.claimAnnouncement(watch.watchId, newer, "s");
    await monitor.completeAnnouncement(watch.watchId, newer, "s");
    // Regression: only the last key used to be remembered.
    expect(await monitor.claimAnnouncement(watch.watchId, older, "s")).toBe(false);
    await monitor.close();
  });

  it("drops every lease a closing session holds", async () => {
    const { monitor, agents } = await newMonitor();
    agents.snapshots = [snapshotFixture()];
    const watch = await monitor.registerWatch({ ownerIdentity: "alice", host: "exodia", harness: "herdr", agentSessionValue: SESSION_A, paneId: "w4:p1", objective: "A", acceptanceCriteria: ["x"] });
    const key = `${watch.watchId}:registered`;
    expect(await monitor.claimAnnouncement(watch.watchId, key, "closing")).toBe(true);
    monitor.releaseAnnouncementsFor("closing");
    expect(await monitor.claimAnnouncement(watch.watchId, key, "other")).toBe(true);
    await monitor.close();
  });
});
