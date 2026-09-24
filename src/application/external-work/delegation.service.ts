import { createHash } from "node:crypto";
import type { ExternalAgentMonitor } from "./external-agent-monitor.js";
import type { ExternalLaunchPort } from "./ports/external-launch.port.js";
import type { AgentWatchRecord } from "../../domain/external-work/index.js";
import type { DelegationHarness, DelegationHost } from "../../domain/tasks/delegation.js";

/**
 * Delegation handoff orchestration (plan §C). The caller supplies an
 * idempotency key; the agent's herdr name is derived from it, so a retry
 * after an ambiguous launch reconciles against the host and can never
 * duplicate agents. A completed delegation is answered from its existing
 * watch without touching the host at all.
 */

export interface DelegateWorkInput {
  ownerIdentity: string;
  idempotencyKey: string;
  host: DelegationHost;
  harness: DelegationHarness;
  agentKind: string;
  repository: string;
  objective: string;
  acceptanceCriteria: readonly string[];
  linkedTaskId?: string;
  originConversationId?: string;
}

export interface DelegateWorkResult {
  watch: AgentWatchRecord;
  /** True when an existing agent was attached instead of launching. */
  reconciled: boolean;
}

export interface DelegationServiceOptions {
  launches: ExternalLaunchPort;
  monitor: ExternalAgentMonitor;
  onError?: (error: unknown) => void;
}

const MAX_INFLIGHT = 32;

export class DelegationService {
  private readonly launches: ExternalLaunchPort;
  private readonly monitor: ExternalAgentMonitor;
  private readonly onError?: (error: unknown) => void;
  private readonly inflight = new Map<string, Promise<DelegateWorkResult>>();

  constructor(options: DelegationServiceOptions) {
    this.launches = options.launches;
    this.monitor = options.monitor;
    this.onError = options.onError;
  }

  async delegate(input: DelegateWorkInput): Promise<DelegateWorkResult> {
    const label = delegationLabel(input.idempotencyKey);
    const existing = await this.existingWatchFor(input, label);
    if (existing) return { watch: existing, reconciled: true };

    const pending = this.inflight.get(label);
    if (pending) return pending;
    if (this.inflight.size >= MAX_INFLIGHT) {
      throw new Error("Too many concurrent delegations; retry shortly.");
    }

    const run = this.performDelegation(input, label)
      .finally(() => this.inflight.delete(label));
    this.inflight.set(label, run);
    return run;
  }

  private async performDelegation(input: DelegateWorkInput, label: string): Promise<DelegateWorkResult> {
    // Reconcile first: an agent already named for this delegation is the
    // outcome of an earlier (possibly ambiguous) launch — never relaunch.
    const receipt = await this.launches.launch({
      host: input.host,
      harness: input.harness,
      agentKind: input.agentKind,
      repository: input.repository,
      objective: input.objective,
      label,
    });
    const watch = await this.monitor.registerWatch({
      ownerIdentity: input.ownerIdentity,
      host: input.host,
      harness: input.harness,
      agentSessionValue: receipt.snapshot.agentSessionValue,
      paneId: receipt.snapshot.paneId,
      objective: input.objective,
      acceptanceCriteria: input.acceptanceCriteria,
      ...(receipt.snapshot.workspaceId !== undefined ? { workspaceId: receipt.snapshot.workspaceId } : {}),
      ...(input.linkedTaskId !== undefined ? { linkedTaskId: input.linkedTaskId } : {}),
      ...(input.originConversationId !== undefined ? { originConversationId: input.originConversationId } : {}),
    });
    return { watch, reconciled: receipt.reconciled };
  }

  /**
   * A completed delegation answers from the watch registry without touching
   * the host: linked-task watches match directly; unlinked ones reconcile
   * through the delegation label on the host.
   */
  private async existingWatchFor(input: DelegateWorkInput, label: string): Promise<AgentWatchRecord | undefined> {
    try {
      const watches = await this.monitor.listWatches(input.ownerIdentity);
      if (input.linkedTaskId !== undefined) {
        const byTask = watches.find((watch) =>
          watch.status !== "stopped"
          && watch.host === input.host
          && watch.linkedTaskId === input.linkedTaskId);
        if (byTask) return byTask;
        return undefined;
      }
      const agents = await this.launches.findAgentsForDelegation(input.host, label);
      const agent = agents[0];
      if (!agent) return undefined;
      return watches.find((watch) =>
        watch.status !== "stopped"
        && watch.host === input.host
        && watch.agentSessionValue === agent.agentSessionValue);
    } catch (error) {
      this.onError?.(error);
      return undefined;
    }
  }
}

/** Stable herdr agent name for one idempotency key. */
export function delegationLabel(idempotencyKey: string): string {
  const digest = createHash("sha256").update(idempotencyKey, "utf8").digest("hex").slice(0, 12);
  return `hld-${digest}`;
}
