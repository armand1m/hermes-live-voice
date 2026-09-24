import type { DelegationHarness, DelegationHost } from "../../../domain/tasks/delegation.js";
import type { ExternalAgentSnapshot } from "./external-agent.port.js";

/**
 * Launch bridge for delegated external work (plan §C). Launching is a
 * one-time action performed only through this port; everything after the
 * launch is observe-only monitoring.
 */

export interface ExternalLaunchRequest {
  host: DelegationHost;
  harness: DelegationHarness;
  /** Agent kind within the harness (herdr's --kind, e.g. "claude"). */
  agentKind: string;
  /** Repository (cwd) the agent should work in. */
  repository: string;
  /** The complete objective prompt submitted to the agent. */
  objective: string;
  /** Human-facing label derived from the idempotency key. */
  label: string;
}

export interface ExternalLaunchReceipt {
  snapshot: ExternalAgentSnapshot;
  /** True when an existing agent was reconciled instead of launching. */
  reconciled: boolean;
}

export interface ExternalLaunchPort {
  /**
   * Launch a harness agent for one delegation and return its verified
   * snapshot. Throws on any step that cannot be confirmed — an ambiguous
   * launch must be reconciled by the caller (findAgentsForDelegation) before
   * any retry, never blindly repeated.
   */
  launch(request: ExternalLaunchRequest, options?: { signal?: AbortSignal }): Promise<ExternalLaunchReceipt>;

  /**
   * Find agents already serving a delegation label — the reconcile path for
   * launches whose outcome is uncertain.
   */
  findAgentsForDelegation(
    host: DelegationHost,
    label: string,
    options?: { signal?: AbortSignal },
  ): Promise<ExternalAgentSnapshot[]>;
}
