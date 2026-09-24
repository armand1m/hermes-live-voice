import type { DelegationHost } from "../../../domain/tasks/delegation.js";
import type {
  ExternalAgentSnapshot,
} from "../../../application/external-work/ports/external-agent.port.js";
import type {
  ExternalLaunchPort,
  ExternalLaunchReceipt,
  ExternalLaunchRequest,
} from "../../../application/external-work/ports/external-launch.port.js";
import { HerdrExternalAgentAdapter } from "./herdr-external-agent.adapter.js";

/**
 * herdr launch bridge (plan §C). The full sequence is: create a labeled
 * workspace in the repository, resolve its first pane, start the named agent
 * kind in that pane (which waits for interactive readiness), and submit the
 * objective. The agent's NAME is the delegation label, so an uncertain
 * launch reconciles by finding that name on the host — a retry can never
 * duplicate agents.
 *
 * Launching happens once per delegation through this adapter; monitoring
 * afterwards is observe-only through the external-agent port.
 */

export interface HerdrExternalLaunchOptions {
  agentAdapter: HerdrExternalAgentAdapter;
  /** Total wall-clock budget for one launch sequence. */
  launchTimeoutMs?: number;
}

export class HerdrExternalLaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HerdrExternalLaunchError";
  }
}

export class HerdrExternalLaunchAdapter implements ExternalLaunchPort {
  private readonly agentAdapter: HerdrExternalAgentAdapter;
  private readonly launchTimeoutMs: number;

  constructor(options: HerdrExternalLaunchOptions) {
    this.agentAdapter = options.agentAdapter;
    this.launchTimeoutMs = options.launchTimeoutMs ?? 120_000;
  }

  async findAgentsForDelegation(
    host: DelegationHost,
    label: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ExternalAgentSnapshot[]> {
    const agents = await this.agentAdapter.listAgents(host, options);
    return agents.filter((agent) => agent.name === label);
  }

  async launch(request: ExternalLaunchRequest, options: { signal?: AbortSignal } = {}): Promise<ExternalLaunchReceipt> {
    const signal = options.signal
      ?? AbortSignal.timeout(this.launchTimeoutMs);
    const host = request.host;
    const reconciled = await this.findAgentsForDelegation(host, request.label, { signal });
    if (reconciled.length > 0) {
      return { snapshot: reconciled[0]!, reconciled: true };
    }

    // 1. A labeled workspace keeps the delegation identifiable on the host.
    const workspaceId = await this.runJson(host, [
      "workspace", "create", "--cwd", request.repository, "--label", request.label, "--no-focus",
    ], signal, (result) => {
      const id = (result as { workspace_id?: unknown }).workspace_id
        ?? (result as { id?: unknown }).id;
      return typeof id === "string" ? id : undefined;
    });

    // 2. Resolve the workspace's first interactive pane.
    const paneId = await this.resolveWorkspacePane(host, workspaceId, signal);

    // 3. Start the named agent kind and wait for it to be ready for input.
    await this.runJson(host, [
      "agent", "start", request.label, "--kind", request.agentKind, "--pane", paneId,
    ], signal, () => "ok");

    // 4. Submit the complete objective. No --wait: readiness was confirmed by
    // agent start, and the prompt is the agent's own work to schedule.
    await this.runJson(host, [
      "agent", "prompt", paneId, request.objective,
    ], signal, () => "ok");

    // 5. Verify the launched identity from a fresh host snapshot.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const agents = await this.agentAdapter.listAgents(host, { signal });
      const launched = agents.find((agent) => agent.name === request.label);
      if (launched) return { snapshot: launched, reconciled: false };
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new HerdrExternalLaunchError(
      `herdr accepted the launch of ${request.label} on ${host}, but the agent has not appeared in a host snapshot yet. Reconcile before retrying.`,
    );
  }

  private async resolveWorkspacePane(host: DelegationHost, workspaceId: string, signal: AbortSignal): Promise<string> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const pane = await this.runJson(host, ["pane", "list", "--workspace", workspaceId], signal, (result) => {
        const panes = (result as { panes?: unknown }).panes;
        if (!Array.isArray(panes) || panes.length === 0) return undefined;
        const first = panes[0] as { pane_id?: unknown };
        return typeof first?.pane_id === "string" ? first.pane_id : undefined;
      }).catch(() => undefined);
      if (pane) return pane;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new HerdrExternalLaunchError(
      `Created workspace ${workspaceId} on ${host}, but no pane was available to start the agent in. Reconcile before retrying.`,
    );
  }

  private async runJson(
    host: DelegationHost,
    args: readonly string[],
    signal: AbortSignal,
    extract: (result: unknown) => string | undefined,
  ): Promise<string> {
    const stdout = await this.agentAdapter.runCommand(host, args, { signal });
    const value = extract(parseEnvelope(stdout));
    if (value === undefined) {
      throw new HerdrExternalLaunchError(
        `herdr ${args[0]} on ${host} succeeded but returned no usable identity. Reconcile before retrying.`,
      );
    }
    return value;
  }
}

function parseEnvelope(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as { result?: unknown };
    return parsed.result ?? parsed;
  } catch {
    return undefined;
  }
}
