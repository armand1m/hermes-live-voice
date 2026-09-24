import {
  createAgentWatchRecord,
  hashWatchOwnerId,
  markWatchMismatched,
  hasWatchAnnounced,
  noteWatchAnnounced,
  recordWatchHostFailure,
  recordWatchObservation,
  stopWatch,
  type AgentWatchRecord,
  type ExternalObservationState,
} from "../../domain/external-work/index.js";
import type { DelegationHarness, DelegationHost } from "../../domain/tasks/delegation.js";
import type { AgentWatchStorePort } from "./ports/agent-watch-store.port.js";
import type {
  ExternalAgentPort,
  ExternalAgentSnapshot,
} from "./ports/external-agent.port.js";

/**
 * Durable external-work monitor (plan §B). Owns the watch registry and one
 * poll loop per host: a single batched agent list per host per tick serves
 * every watch on that host, one observation command runs per host at a time,
 * and recent output is read only when a state changed or a working agent's
 * state cursor advanced. Hosts back off on failure to a ceiling; three
 * consecutive failures mark their watches offline; any success recovers.
 *
 * The monitor is observe-only: it never prompts, cancels, or restarts an
 * agent. It runs independently of the Hermes implementation queue — a status
 * request never waits behind code-changing work. Watches survive browser
 * disconnects and gateway restarts because the registry is the store.
 */

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_FAILURE_BACKOFF_MAX_MS = 60_000;
/** Lines of recent terminal text read when evidence is due (plan §B). */
const RECENT_OUTPUT_LINES = 80;

export interface ExternalMonitorScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ExternalAgentMonitorOptions {
  store: AgentWatchStorePort;
  agents: ExternalAgentPort;
  pollIntervalMs?: number;
  failureBackoffMaxMs?: number;
  now?: () => number;
  scheduler?: ExternalMonitorScheduler;
  onError?: (error: unknown) => void;
}

export type ExternalMonitorEventKind =
  | "registered"
  | "state-change"
  | "output-evidence"
  | "offline"
  | "recovered"
  | "mismatched"
  | "stopped";

export interface ExternalMonitorEvent {
  kind: ExternalMonitorEventKind;
  watch: AgentWatchRecord;
  previousState: ExternalObservationState | undefined;
}

export interface RegisterWatchInput {
  ownerIdentity: string;
  host: DelegationHost;
  harness: DelegationHarness;
  agentSessionValue: string;
  paneId: string;
  objective: string;
  acceptanceCriteria: readonly string[];
  workspaceId?: string;
  linkedTaskId?: string;
  originConversationId?: string;
}

const defaultScheduler: ExternalMonitorScheduler = {
  setTimeout(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    handle.unref?.();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

interface HostState {
  failures: number;
  inFlight: boolean;
  timer?: unknown;
}

export class ExternalAgentMonitor {
  private readonly store: AgentWatchStorePort;
  private readonly agents: ExternalAgentPort;
  private readonly pollIntervalMs: number;
  private readonly failureBackoffMaxMs: number;
  private readonly now: () => number;
  private readonly scheduler: ExternalMonitorScheduler;
  private readonly onError?: (error: unknown) => void;
  private readonly listeners = new Set<(event: ExternalMonitorEvent) => void>();
  private readonly hosts = new Map<DelegationHost, HostState>();
  private readonly watchers = new Map<string, () => void>();
  /** In-memory speaker leases: `${watchId}\n${key}` → claimant session id. */
  private readonly announcementLeases = new Map<string, string>();
  private closed = false;
  private initialized = false;

  constructor(options: ExternalAgentMonitorOptions) {
    this.store = options.store;
    this.agents = options.agents;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.failureBackoffMaxMs = options.failureBackoffMaxMs ?? DEFAULT_FAILURE_BACKOFF_MAX_MS;
    this.now = options.now ?? Date.now;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.onError = options.onError;
  }

  /** Resume polling every persisted watch; safe to call once per process. */
  async initialize(): Promise<void> {
    if (this.closed || this.initialized) return;
    this.initialized = true;
    const watches = await this.store.list({ statuses: ["watching"] });
    for (const watch of watches) this.scheduleHost(watch.host, 0);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const state of this.hosts.values()) {
      if (state.timer !== undefined) this.scheduler.clearTimeout(state.timer);
    }
    this.hosts.clear();
    this.listeners.clear();
    await this.store.close?.();
  }

  subscribe(listener: (event: ExternalMonitorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Register a watch after verifying the agent exists on its host with the
   * given session identity. The receipt is verified state, never a guess.
   */
  async registerWatch(input: RegisterWatchInput): Promise<AgentWatchRecord> {
    if (this.closed) throw new Error("The external-work monitor is closed.");
    const discovery = await this.discover(input.host);
    const match = discovery.find((agent) =>
      agent.paneId === input.paneId && agent.agentSessionValue === input.agentSessionValue);
    if (!match) {
      const paneTaken = discovery.find((agent) => agent.paneId === input.paneId);
      throw new Error(
        paneTaken
          ? `Pane ${input.paneId} on ${input.host} currently runs a different session (${paneTaken.agentSessionValue}); refusing to attach to different work.`
          : `No ${input.harness} agent with session ${input.agentSessionValue} found on ${input.host} at pane ${input.paneId}.`,
      );
    }
    const watch = createAgentWatchRecord({
      ownerId: hashWatchOwnerId(input.ownerIdentity),
      host: input.host,
      harness: input.harness,
      agentSessionValue: input.agentSessionValue,
      paneId: input.paneId,
      objective: input.objective,
      acceptanceCriteria: input.acceptanceCriteria,
      ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
      ...(match.workspaceId !== undefined ? { workspaceId: match.workspaceId } : {}),
      ...(input.linkedTaskId !== undefined ? { linkedTaskId: input.linkedTaskId } : {}),
      ...(input.originConversationId !== undefined ? { originConversationId: input.originConversationId } : {}),
      now: this.now(),
    });
    const persisted = await this.store.put(watch);
    this.emit({ kind: "registered", watch: persisted, previousState: undefined });
    this.scheduleHost(input.host, 0);
    return persisted;
  }

  async stopWatch(ownerIdentity: string, watchId: string, reason?: string): Promise<AgentWatchRecord> {
    const ownerId = hashWatchOwnerId(ownerIdentity);
    const current = await this.store.load(watchId);
    if (!current || current.ownerId !== ownerId) throw new Error(`Agent watch not found: ${watchId}`);
    const stopped = await this.updateWatch(current, (watch) => stopWatch(watch, { now: this.now(), reason }));
    this.emit({ kind: "stopped", watch: stopped, previousState: stopped.lastObserved?.state });
    this.watchers.delete(watchId);
    return stopped;
  }

  async listWatches(ownerIdentity: string): Promise<AgentWatchRecord[]> {
    return this.store.list({ ownerId: hashWatchOwnerId(ownerIdentity) });
  }

  /** On-request discovery: one host snapshot, serialized with polling. */
  async discover(host: DelegationHost): Promise<ExternalAgentSnapshot[]> {
    const state = this.hostState(host);
    while (state.inFlight) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    state.inFlight = true;
    try {
      return await this.agents.listAgents(host);
    } finally {
      state.inFlight = false;
    }
  }

  /**
   * Single-speaker claim for an announcement derived from a watch: an
   * in-memory lease makes sure two open voice sessions cannot both say the
   * same update (plan §D). Nothing durable is written here — the claimant
   * calls completeAnnouncement only after the speech was actually delivered,
   * or releaseAnnouncement so the update stays eligible after a failure.
   */
  async claimAnnouncement(watchId: string, key: string, claimant: string): Promise<boolean> {
    const current = await this.store.load(watchId);
    if (!current || current.status === "stopped") return false;
    if (hasWatchAnnounced(current, key)) return false;
    const lease = announcementLeaseKey(watchId, key);
    const holder = this.announcementLeases.get(lease);
    if (holder !== undefined && holder !== claimant) return false;
    this.announcementLeases.set(lease, claimant);
    return true;
  }

  /** Durably record a delivered announcement and drop the claimant's lease. */
  async completeAnnouncement(watchId: string, key: string, claimant: string): Promise<void> {
    this.releaseAnnouncement(watchId, key, claimant);
    const current = await this.store.load(watchId);
    if (!current || hasWatchAnnounced(current, key)) return;
    await this.updateWatch(current, (watch) => noteWatchAnnounced(watch, key, this.now()));
  }

  /** Give up a lease without recording delivery: the update stays eligible. */
  releaseAnnouncement(watchId: string, key: string, claimant: string): void {
    const lease = announcementLeaseKey(watchId, key);
    if (this.announcementLeases.get(lease) === claimant) this.announcementLeases.delete(lease);
  }

  /** Drop every lease a closing voice session still holds. */
  releaseAnnouncementsFor(claimant: string): void {
    for (const [lease, holder] of this.announcementLeases) {
      if (holder === claimant) this.announcementLeases.delete(lease);
    }
  }

  private hostState(host: DelegationHost): HostState {
    let state = this.hosts.get(host);
    if (!state) {
      state = { failures: 0, inFlight: false };
      this.hosts.set(host, state);
    }
    return state;
  }

  private scheduleHost(host: DelegationHost, delayMs: number): void {
    if (this.closed) return;
    const state = this.hostState(host);
    if (state.timer !== undefined) return;
    state.timer = this.scheduler.setTimeout(() => {
      state.timer = undefined;
      void this.pollHost(host);
    }, Math.max(0, delayMs));
  }

  private nextDelayMs(state: HostState): number {
    if (state.failures === 0) return this.pollIntervalMs;
    return Math.min(this.pollIntervalMs * 2 ** Math.min(state.failures, 10), this.failureBackoffMaxMs);
  }

  private async pollHost(host: DelegationHost): Promise<void> {
    if (this.closed) return;
    const state = this.hostState(host);
    if (state.inFlight) return;
    state.inFlight = true;
    let succeeded = false;
    try {
      const snapshots = await this.agents.listAgents(host);
      succeeded = true;
      const watches = await this.store.list({ statuses: ["watching"], host });
      for (const watch of watches) {
        await this.observeWatch(watch, snapshots);
      }
    } catch (error) {
      this.reportError(error);
      await this.recordHostFailure(host, error);
    } finally {
      state.inFlight = false;
      state.failures = succeeded ? 0 : state.failures + 1;
      const watching = await this.store.list({ statuses: ["watching"], host });
      if (watching.length > 0 && !this.closed) {
        this.scheduleHost(host, this.nextDelayMs(state));
      }
    }
  }

  private async observeWatch(watch: AgentWatchRecord, snapshots: readonly ExternalAgentSnapshot[]): Promise<void> {
    const byPane = snapshots.find((agent) => agent.paneId === watch.paneId);
    if (!byPane) {
      // The pane is gone from the host snapshot: the work is missing, not done.
      await this.applyObservation(watch, {
        state: "missing",
        at: this.now(),
      }, undefined, "state-change", watch.lastObserved?.state);
      return;
    }
    if (byPane.agentSessionValue !== watch.agentSessionValue) {
      // Pane reuse: never silently follow whatever now runs there.
      const mismatched = await this.updateWatch(watch, (current) =>
        markWatchMismatched(current, { expectedSessionValue: watch.agentSessionValue, now: this.now() }));
      this.emit({ kind: "mismatched", watch: mismatched, previousState: watch.lastObserved?.state });
      return;
    }
    const previous = watch.lastObserved;
    const stateChanged = previous?.agentStatus !== byPane.status || previous?.state !== byPane.status;
    const cursorAdvanced = previous?.stateChangeSeq !== undefined && byPane.stateChangeSeq > previous.stateChangeSeq;
    const observation: AgentWatchRecord["lastObserved"] = {
      state: byPane.status,
      agentStatus: byPane.status,
      agentRevision: byPane.revision,
      stateChangeSeq: byPane.stateChangeSeq,
      at: this.now(),
    };
    // Read bounded recent output only when the evidence is due: a state
    // change, or a working agent whose terminal cursor moved (plan §B).
    if ((stateChanged || (byPane.status === "working" && cursorAdvanced)) && byPane.status !== "unknown") {
      try {
        const output = await this.agents.readRecentOutput(watch.host, watch.paneId, RECENT_OUTPUT_LINES);
        const excerpt = lastNonEmptyLine(output);
        if (excerpt) observation.excerpt = excerpt.slice(0, 600);
        await this.applyObservation(watch, observation, excerpt, stateChanged ? "state-change" : "output-evidence", previous?.state);
        return;
      } catch (error) {
        this.reportError(error);
        // The status observation still stands; the excerpt is best-effort.
      }
    }
    await this.applyObservation(watch, observation, undefined, stateChanged ? "state-change" : undefined, previous?.state);
  }

  private async applyObservation(
    watch: AgentWatchRecord,
    observation: AgentWatchRecord["lastObserved"],
    _excerpt: string | undefined,
    kind: "state-change" | "output-evidence" | undefined,
    previousState: ExternalObservationState | undefined,
  ): Promise<void> {
    const wasOffline = watch.lastObserved?.state === "offline";
    const updated = await this.updateWatch(watch, (current) =>
      recordWatchObservation(current, {
        observation: observation!,
        now: this.now(),
        ...(kind === "state-change" ? { summary: observationSummary(observation!) } : {}),
      }));
    if (kind === undefined) return;
    if (wasOffline && observation && observation.state !== "offline") {
      this.emit({ kind: "recovered", watch: updated, previousState });
      return;
    }
    this.emit({ kind, watch: updated, previousState });
  }

  private async recordHostFailure(host: DelegationHost, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const watches = await this.store.list({ statuses: ["watching"], host });
    for (const watch of watches) {
      const wasOffline = watch.lastObserved?.state === "offline";
      const updated = await this.updateWatch(watch, (current) =>
        recordWatchHostFailure(current, { error: message, now: this.now() }));
      if (!wasOffline && updated.lastObserved?.state === "offline") {
        this.emit({ kind: "offline", watch: updated, previousState: watch.lastObserved?.state });
      }
    }
  }

  private async updateWatch(
    watch: AgentWatchRecord,
    updater: (current: AgentWatchRecord) => AgentWatchRecord,
  ): Promise<AgentWatchRecord> {
    try {
      return await this.store.update(watch.watchId, updater, { expectedRevision: watch.revision });
    } catch {
      // Another writer moved the record (single monitor expected; restarts
      // race briefly). Reload and apply once against the latest revision.
      const current = await this.store.load(watch.watchId);
      if (!current) throw new Error(`Agent watch disappeared: ${watch.watchId}`);
      return this.store.update(current.watchId, updater, { expectedRevision: current.revision });
    }
  }

  private emit(event: ExternalMonitorEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.reportError(error);
      }
    }
  }

  private reportError(error: unknown): void {
    try {
      this.onError?.(error);
    } catch {
      // Error observers cannot destabilize the monitor.
    }
  }
}

function lastNonEmptyLine(output: string): string | undefined {
  const lines = output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  return lines.at(-1);
}

/** Idle is reported as needing inspection, never as completion (plan §B). */
function observationSummary(observation: NonNullable<AgentWatchRecord["lastObserved"]>): string {
  switch (observation.state) {
    case "working":
      return `Agent working${observation.excerpt ? `: ${observation.excerpt.slice(0, 200)}` : "."}`;
    case "idle":
      return "Agent idle; the outcome needs inspection.";
    case "blocked":
      return "Agent is blocked and waiting for input.";
    case "done":
      return "Agent reported done; verify the outcome before treating it as complete.";
    case "missing":
      return "Agent no longer appears on its host.";
    case "offline":
      return "Host could not be reached; observations are stale.";
    default:
      return "Agent status is unknown.";
  }
}

function announcementLeaseKey(watchId: string, key: string): string {
  return `${watchId}\n${key}`;
}
