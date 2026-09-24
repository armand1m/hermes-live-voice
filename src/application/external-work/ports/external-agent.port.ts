import type {
  ExternalAgentRuntimeStatus,
} from "../../../domain/external-work/index.js";
import type { DelegationHarness, DelegationHost } from "../../../domain/tasks/delegation.js";

/**
 * Observation window onto external harness agents (plan §B). One snapshot per
 * host covers discovery and inspection; recent terminal text is supporting
 * evidence read only when a state change or progress assessment needs it.
 * Implementations are observe-only: they never prompt, cancel, or restart an
 * agent, and never mutate harness state.
 */

export interface ExternalAgentSnapshot {
  host: DelegationHost;
  harness: DelegationHarness;
  /** Stable harness session identity (e.g. herdr's agent_session.value). */
  agentSessionValue: string;
  paneId: string;
  workspaceId?: string;
  /** Human-facing label when the harness assigned one. */
  name?: string;
  status: ExternalAgentRuntimeStatus;
  /** Harness revision cursor; bumps when the agent's terminal state changed. */
  revision: number;
  /** Harness global state-change cursor for cheap change detection. */
  stateChangeSeq: number;
  cwd: string;
  /** Stripped terminal title — a short hint of what the pane is doing. */
  title?: string;
}

export interface ExternalAgentListOptions {
  signal?: AbortSignal;
}

export interface ExternalAgentReadOptions {
  signal?: AbortSignal;
}

export interface ExternalAgentPort {
  /**
   * List every agent the harness reports on one host. This is the batched
   * discovery command: one call per host per poll cycle, shared by every
   * watch on that host.
   */
  listAgents(host: DelegationHost, options?: ExternalAgentListOptions): Promise<ExternalAgentSnapshot[]>;

  /**
   * Read bounded recent terminal output for one pane. Plain text, never ANSI.
   * Evidence for humans and summaries — never authoritative completion proof.
   */
  readRecentOutput(host: DelegationHost, paneId: string, maxLines: number, options?: ExternalAgentReadOptions): Promise<string>;
}
