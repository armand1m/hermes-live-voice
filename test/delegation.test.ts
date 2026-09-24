import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DelegationService, delegationLabel } from "../src/application/external-work/delegation.service.js";
import { ExternalAgentMonitor } from "../src/application/external-work/external-agent-monitor.js";
import type {
  ExternalAgentPort,
  ExternalAgentSnapshot,
} from "../src/application/external-work/ports/external-agent.port.js";
import type {
  ExternalLaunchPort,
  ExternalLaunchReceipt,
  ExternalLaunchRequest,
} from "../src/application/external-work/ports/external-launch.port.js";
import { FileAgentWatchStore } from "../src/adapters/outbound/external-work/file-agent-watch-store.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/**
 * A fake host that mimics herdr closely enough to prove idempotence:
 * launch() reconciles by agent name before running any step, and the
 * "ambiguous launch" mode throws after the agent exists — exactly the crash
 * window the gateway must survive without duplicating agents.
 */
class FakeLaunches implements ExternalLaunchPort {
  launches = 0;
  agents: ExternalAgentSnapshot[] = [];
  failNextLaunch = false;

  async findAgentsForDelegation(host: string, label: string): Promise<ExternalAgentSnapshot[]> {
    return this.agents.filter((agent) => agent.host === host && agent.name === label);
  }

  async launch(request: ExternalLaunchRequest): Promise<ExternalLaunchReceipt> {
    const existing = await this.findAgentsForDelegation(request.host, request.label);
    if (existing.length > 0) return { snapshot: existing[0]!, reconciled: true };
    this.launches += 1;
    if (this.failNextLaunch) {
      // The transport died after the agent started: the agent is on the host,
      // but the caller never got a receipt.
      this.failNextLaunch = false;
      this.agents.push(snapshotFor(request));
      throw new Error("herdr transport died after the agent started");
    }
    const snapshot = snapshotFor(request);
    this.agents.push(snapshot);
    return { snapshot, reconciled: false };
  }
}

function snapshotFor(request: ExternalLaunchRequest): ExternalAgentSnapshot {
  return {
    host: request.host,
    harness: "herdr",
    agentSessionValue: `session-${request.label}`,
    paneId: "wN:p1",
    status: "working",
    revision: 1,
    stateChangeSeq: 1,
    cwd: request.repository,
    name: request.label,
  };
}

async function newService() {
  const directory = mkdtempSync(join(tmpdir(), "delegation-"));
  directories.push(directory);
  const launches = new FakeLaunches();
  const agents: ExternalAgentPort = {
    async listAgents() { return structuredClone(launches.agents); },
    async readRecentOutput() { return "❯ started"; },
  };
  const monitor = new ExternalAgentMonitor({
    store: new FileAgentWatchStore({ directory }),
    agents,
    pollIntervalMs: 60_000,
  });
  const service = new DelegationService({ launches, monitor });
  return { service, launches, monitor };
}

const REQUEST = {
  ownerIdentity: "agent:main:hermes-live:profile:default:user:voice",
  idempotencyKey: "diamond-fix-2026-09-24",
  host: "exodia" as const,
  harness: "herdr" as const,
  agentKind: "claude",
  repository: "/repositories/diamond",
  objective: "Fix the diamond indicator and verify on the plot.",
  acceptanceCriteria: ["Plot renders", "Tests pass"],
};

describe("DelegationService", () => {
  it("launches once, registers the watch, and answers retries from the registry", async () => {
    const { service, launches, monitor } = await newService();
    const first = await service.delegate(REQUEST);
    expect(first.reconciled).toBe(false);
    expect(first.watch).toMatchObject({ host: "exodia", status: "watching", paneId: "wN:p1" });
    expect(first.watch.objective).toContain("diamond indicator");
    expect(launches.launches).toBe(1);
    // The agent's herdr name is derived from the idempotency key: stable
    // across retries, unique per delegation.
    expect(launches.agents[0]!.name).toBe(delegationLabel(REQUEST.idempotencyKey));

    // Same key: answered from the existing watch, host untouched.
    const second = await service.delegate(REQUEST);
    expect(second.reconciled).toBe(true);
    expect(second.watch.watchId).toBe(first.watch.watchId);
    expect(launches.launches).toBe(1);
    await monitor.close();
  });

  it("reconciles an ambiguous launch instead of duplicating the agent", async () => {
    const { service, launches, monitor } = await newService();
    launches.failNextLaunch = true;
    await expect(service.delegate(REQUEST)).rejects.toThrow(/died after the agent started/);
    expect(launches.launches).toBe(1);

    // The retry finds the already-started agent by name; no second launch.
    const retried = await service.delegate(REQUEST);
    expect(retried.reconciled).toBe(true);
    expect(retried.watch.agentSessionValue).toBe(`session-${delegationLabel(REQUEST.idempotencyKey)}`);
    expect(launches.launches).toBe(1);
    expect(launches.agents).toHaveLength(1);
    await monitor.close();
  });

  it("derives distinct labels for distinct keys", () => {
    expect(delegationLabel("key-one")).not.toBe(delegationLabel("key-two"));
    expect(delegationLabel("key-one")).toMatch(/^hld-[0-9a-f]{12}$/u);
  });
});
