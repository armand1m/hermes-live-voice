import { describe, expect, it } from "vitest";
import { HerdrExternalAgentAdapter, type CommandRunner } from "../src/adapters/outbound/external-work/herdr-external-agent.adapter.js";
import { HerdrExternalLaunchAdapter } from "../src/adapters/outbound/external-work/herdr-external-launch.adapter.js";
import { parseHostAgentDefaults } from "../src/domain/external-work/agent-profiles.js";

const SESSION = "4432988d-611f-437a-8b3a-9937984a86e2";

/** A fake herdr: workspace create → pane w9:p1; the agent appears after start. */
function fakeHerdr() {
  const commands: string[][] = [];
  let started = false;
  const runner: CommandRunner = {
    async run(command) {
      commands.push([...command]);
      const text = command.join(" ");
      if (text.includes("workspace create")) {
        return { stdout: JSON.stringify({ result: { workspace: { workspace_id: "w9" }, root_pane: { pane_id: "w9:p1" } } }), stderr: "" };
      }
      if (text.includes("agent start")) started = true;
      if (text.includes("agent list")) {
        const agents = started ? [{
          name: "hld-abc", pane_id: "w9:p1", agent: "claude", agent_status: "working", revision: 1, state_change_seq: 1,
          agent_session: { source: "herdr", value: SESSION }, cwd: "/repo",
        }] : [];
        return { stdout: JSON.stringify({ result: { agents } }), stderr: "" };
      }
      return { stdout: JSON.stringify({ result: { ok: true } }), stderr: "" };
    },
  };
  const launcher = new HerdrExternalLaunchAdapter({
    localHost: "exodia",
    agentAdapter: new HerdrExternalAgentAdapter({
      herdrExecutable: "/home/me/.local/bin/herdr", msshExecutable: "mssh", localHost: "exodia", remoteHost: "mac-mini", runner,
    }),
  });
  return { launcher, commands };
}

const request = (host: "exodia" | "mac-mini", agentKind: string) => ({
  host, harness: "herdr" as const, agentKind, repository: "/repo", objective: "Fix the upload bug.", label: "hld-abc",
});

describe("HerdrExternalLaunchAdapter agent profiles", () => {
  it("starts claude unattended with the kind-specific bypass flag", async () => {
    const { launcher, commands } = fakeHerdr();
    await launcher.launch(request("mac-mini", "claude"));
    const start = commands.find((command) => command.join(" ").includes("agent start"))!;
    expect(start.join(" ")).toContain("agent start hld-abc --kind claude --pane w9:p1 -- --dangerously-skip-permissions");
  });

  it("loads the GLM provider env in the pane before starting claude-glm, without exposing it", async () => {
    const { launcher, commands } = fakeHerdr();
    await launcher.launch(request("exodia", "claude-glm"));
    const texts = commands.map((command) => command.slice(1).join(" "));
    const setup = texts.findIndex((text) => text.startsWith("pane run w9:p1"));
    const start = texts.findIndex((text) => text.startsWith("agent start"));
    expect(setup).toBeGreaterThan(-1);
    expect(setup).toBeLessThan(start);
    // Only the wrapper's export lines are sourced; no credential is on the command line.
    expect(commands[setup]!.at(-1)).toBe(`source <(grep '^export ' "$HOME/.local/bin/claude-glm")`);
    expect(texts[start]).toContain("--kind claude --pane w9:p1 -- --dangerously-skip-permissions");
  });

  it("starts codex with its own bypass flag", async () => {
    const { launcher, commands } = fakeHerdr();
    await launcher.launch(request("exodia", "codex"));
    expect(commands.map((command) => command.join(" ")).find((text) => text.includes("agent start")))
      .toContain("--kind codex --pane w9:p1 -- --dangerously-bypass-approvals-and-sandbox");
  });

  it("refuses claude-glm on the remote host and unknown agents before touching herdr", async () => {
    const { launcher, commands } = fakeHerdr();
    await expect(launcher.launch(request("mac-mini", "claude-glm"))).rejects.toThrow(/only available on exodia/);
    await expect(launcher.launch(request("exodia", "gpt-pilot"))).rejects.toThrow(/Unknown agent/);
    expect(commands.some((command) => command.join(" ").includes("workspace create"))).toBe(false);
  });
});

describe("parseHostAgentDefaults", () => {
  it("defaults to claude-glm on exodia and claude on the Mac mini, with overrides", () => {
    expect(parseHostAgentDefaults(undefined)).toEqual({ exodia: "claude-glm", "mac-mini": "claude" });
    expect(parseHostAgentDefaults("mac-mini=codex")).toEqual({ exodia: "claude-glm", "mac-mini": "codex" });
    expect(() => parseHostAgentDefaults("exodia=gpt")).toThrow(/Invalid delegation agent default/);
  });
});
