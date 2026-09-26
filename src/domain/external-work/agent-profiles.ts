import type { DelegationHost } from "../tasks/delegation.js";

/**
 * Coding-agent profiles a delegation can launch through herdr. A profile maps
 * to a herdr agent kind (the canonical executable herdr types into the pane)
 * plus the flags that make it run unattended, and optionally a pane setup
 * command run before the agent starts.
 *
 * `claude-glm` is Claude Code pointed at GLM through z.ai: the same `claude`
 * executable with the provider environment loaded from the operator's
 * `~/.local/bin/claude-glm` wrapper. The setup sources only the wrapper's
 * `export` lines inside the pane's shell, so the credential never appears in
 * a command line or the pane scrollback. It needs shell syntax, which the
 * remote (mssh) transport deliberately never carries, so it is local-only.
 */
export interface AgentProfile {
  /** herdr `--kind`. */
  herdrKind: string;
  /** Arguments after `--`: unattended mode for this kind. */
  args: readonly string[];
  /** Shell command run in the pane before the agent starts (local host only). */
  paneSetup?: string;
  localOnly?: boolean;
}

export const AGENT_PROFILES = {
  claude: { herdrKind: "claude", args: ["--dangerously-skip-permissions"] },
  "claude-glm": {
    herdrKind: "claude",
    args: ["--dangerously-skip-permissions"],
    paneSetup: `source <(grep '^export ' "$HOME/.local/bin/claude-glm")`,
    localOnly: true,
  },
  codex: { herdrKind: "codex", args: ["--dangerously-bypass-approvals-and-sandbox"] },
} as const satisfies Record<string, AgentProfile>;

export type AgentProfileName = keyof typeof AGENT_PROFILES;
export const AGENT_PROFILE_NAMES = Object.keys(AGENT_PROFILES) as AgentProfileName[];

export function isAgentProfileName(value: unknown): value is AgentProfileName {
  return typeof value === "string" && Object.hasOwn(AGENT_PROFILES, value);
}

/** Default agent per host when a delegation names none. */
export type HostAgentDefaults = Record<DelegationHost, AgentProfileName>;
export const DEFAULT_HOST_AGENTS: HostAgentDefaults = { exodia: "claude-glm", "mac-mini": "claude" };

/** Parse "exodia=claude-glm,mac-mini=claude" (unknown pairs are rejected). */
export function parseHostAgentDefaults(value: string | undefined): HostAgentDefaults {
  const defaults: HostAgentDefaults = { ...DEFAULT_HOST_AGENTS };
  if (!value?.trim()) return defaults;
  for (const pair of value.split(",")) {
    const [host, profile] = pair.split("=").map((part) => part.trim());
    if ((host !== "exodia" && host !== "mac-mini") || !isAgentProfileName(profile)) {
      throw new Error(`Invalid delegation agent default "${pair.trim()}": expected host=${AGENT_PROFILE_NAMES.join("|")}.`);
    }
    defaults[host] = profile;
  }
  return defaults;
}

/** The profile to launch, or an error message when it cannot run on that host. */
export function resolveAgentProfile(
  requested: string | undefined,
  host: DelegationHost,
  localHost: DelegationHost,
  defaults: HostAgentDefaults = DEFAULT_HOST_AGENTS,
): { name: AgentProfileName; profile: AgentProfile } | { error: string } {
  const name = requested ?? defaults[host];
  if (!isAgentProfileName(name)) {
    return { error: `Unknown agent "${name}"; use one of ${AGENT_PROFILE_NAMES.join(", ")}.` };
  }
  const profile: AgentProfile = AGENT_PROFILES[name];
  if (profile.localOnly && host !== localHost) {
    return { error: `The ${name} agent is only available on ${localHost}.` };
  }
  return { name, profile };
}
