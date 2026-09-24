import { describe, expect, it } from "vitest";
import {
  HerdrExternalAgentAdapter,
  HerdrExternalAgentError,
  type CommandRunner,
} from "../src/adapters/outbound/external-work/herdr-external-agent.adapter.js";

function agentFixture(overrides: Record<string, unknown> = {}) {
  return {
    agent: "claude",
    agent_session: { agent: "claude", kind: "id", source: "herdr:claude", value: "4432988d-611f-437a-8b3a-9937984a86e2" },
    agent_status: "working",
    cwd: "/home/armand1m/Projects/mine/hermes-live-voice",
    focused: false,
    pane_id: "w4:p1",
    revision: 23,
    state_change_seq: 360,
    tab_id: "w4:t1",
    terminal_id: "term_x",
    terminal_title: "✳ diamond fix",
    terminal_title_stripped: "diamond fix",
    workspace_id: "w4",
    ...overrides,
  };
}

function adapterWith(runner: CommandRunner) {
  return new HerdrExternalAgentAdapter({
    herdrExecutable: "herdr",
    msshExecutable: "mssh",
    localHost: "exodia",
    remoteHost: "mac-mini",
    runner,
  });
}

describe("HerdrExternalAgentAdapter", () => {
  it("lists local agents from the herdr JSON envelope", async () => {
    const commands: string[][] = [];
    const adapter = adapterWith({
      async run(command) {
        commands.push([...command]);
        return {
          stdout: JSON.stringify({ id: "cli:agent:list", result: { agents: [
            agentFixture(),
            agentFixture({ pane_id: "wC:p1", agent_status: "done", name: "brain-failover" }),
            // Unknown status and a pane that fails the pattern degrade or drop.
            agentFixture({ pane_id: "weird|pane", agent_status: "idle" }),
            agentFixture({ pane_id: "w9:p2", agent_status: "thinking-hard" }),
          ] } }),
          stderr: "",
        };
      },
    });
    const agents = await adapter.listAgents("exodia");
    expect(commands).toEqual([["herdr", "agent", "list"]]);
    // Uppercase hex pane ids are valid herdr identities; only pattern
    // violations and missing session identities drop out.
    expect(agents).toHaveLength(3);
    expect(agents[0]).toMatchObject({
      host: "exodia",
      harness: "herdr",
      paneId: "w4:p1",
      agentSessionValue: "4432988d-611f-437a-8b3a-9937984a86e2",
      status: "working",
      revision: 23,
      stateChangeSeq: 360,
      title: "diamond fix",
      workspaceId: "w4",
    });
    expect(agents[1]).toMatchObject({ status: "done", name: "brain-failover" });
    // An unrecognized harness status is honest about not knowing.
    expect(agents.find((agent) => agent.paneId === "w9:p2")?.status).toBe("unknown");
  });

  it("runs the same commands through mssh for the remote host, with validated panes", async () => {
    const commands: string[][] = [];
    const adapter = adapterWith({
      async run(command) {
        commands.push([...command]);
        return { stdout: "❯ all checks passed\n", stderr: "" };
      },
    });
    const output = await adapter.readRecentOutput("mac-mini", "w6:p1", 80);
    expect(output).toContain("all checks passed");
    expect(commands).toEqual([
      ["mssh", "herdr agent read w6:p1 --lines 80 --format text"],
    ]);
    // A pane id that could smuggle shell syntax never reaches the transport.
    await expect(adapter.readRecentOutput("mac-mini", "w6:p1; touch pwned", 10)).rejects.toThrow();
    await expect(adapter.listAgents("laptop" as never)).rejects.toThrow(/No transport/);
  });

  it("clamps line budgets and surfaces stderr and timeouts as bounded errors", async () => {
    const commands: string[][] = [];
    const adapter = adapterWith({
      async run(command, options) {
        commands.push([...command]);
        if (command.includes("read")) {
          expect(options.timeoutMs).toBeLessThanOrEqual(20_000);
          return { stdout: "line\n", stderr: "" };
        }
        return { stdout: "", stderr: "ssh: connect to host timed out" };
      },
    });
    await adapter.readRecentOutput("exodia", "w4:p1", 5_000);
    // The 5,000-line request is clamped to the 80-line observation budget.
    expect(commands[0]).toEqual(["herdr", "agent", "read", "w4:p1", "--lines", "80", "--format", "text"]);
    await expect(adapter.listAgents("mac-mini")).rejects.toThrow(/ssh: connect to host timed out/);

    const timing: CommandRunner = {
      async run() {
        throw new HerdrExternalAgentError("herdr command timed out after 20000ms.");
      },
    };
    await expect(adapterWith(timing).listAgents("exodia")).rejects.toThrow(/timed out/);
  });

  it("unwraps a JSON envelope from agent read if one appears", async () => {
    const adapter = adapterWith({
      async run() {
        return { stdout: JSON.stringify({ id: "cli:agent:read", result: { text: "plain evidence\n" } }), stderr: "" };
      },
    });
    await expect(adapter.readRecentOutput("exodia", "w4:p1", 10)).resolves.toBe("plain evidence\n");
  });

  it("falls back to the visible screen when scrollback is unavailable on a working agent", async () => {
    const commands: string[][] = [];
    const adapter = adapterWith({
      async run(command) {
        commands.push([...command]);
        if (!command.includes("visible")) {
          // Live error observed 2026-09-24: alternate-screen agents cannot
          // serve --source recent while working.
          return {
            stdout: "",
            stderr: JSON.stringify({ error: { code: "agent_not_idle", message: "cannot read 80 lines while w4:p1 is working" } }),
          };
        }
        return { stdout: "visible screen evidence\n", stderr: "" };
      },
    });
    await expect(adapter.readRecentOutput("exodia", "w4:p1", 80)).resolves.toBe("visible screen evidence\n");
    expect(commands).toHaveLength(2);
    expect(commands[1]).toContain("visible");
    // Unrelated failures still propagate.
    const strict = adapterWith({
      async run() {
        return { stdout: "", stderr: JSON.stringify({ error: { code: "pane_gone", message: "no such pane" } }) };
      },
    });
    await expect(strict.readRecentOutput("exodia", "w4:p1", 80)).rejects.toThrow(/pane_gone/);
  });
});
