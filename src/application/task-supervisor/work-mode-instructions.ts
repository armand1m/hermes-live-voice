import type { TaskRecord } from "../../domain/tasks/index.js";
import { DEFAULT_HOST_AGENTS, type HostAgentDefaults } from "../../domain/external-work/agent-profiles.js";

// Per-task Hermes run instructions for the work mode the voice brain chose.
// Orchestration keeps Hermes a planner: it turns the request into a complete
// brief for a herdr coding agent on the right machine and hands it off
// through the gateway's supervised delegation (hermes_delegate_work), which
// launches, verifies, and monitors the agent. The run then ends in seconds.

export function workModeInstructions(record: TaskRecord, agents: HostAgentDefaults = DEFAULT_HOST_AGENTS): string | undefined {
  if (record.workMode === "quick") {
    return [
      "This is a quick, read-only check requested by voice.",
      "Answer it directly with read-only commands or lookups. Do not modify files, systems, or repositories, and do not start or delegate to other agents.",
      "Keep the result to a few plain sentences the voice assistant can read out.",
    ].join("\n");
  }
  if (record.workMode !== "orchestrate") return undefined;
  return [
    `You are the orchestrator for background task ${record.taskId}. Do not do the work yourself.`,
    "1. Decide where it runs: host (exodia or mac-mini) and the absolute repository path on that host. Use your memory, skills, and past sessions to resolve which project the user means.",
    `2. Choose the coding agent: ${agents.exodia} on exodia and ${agents["mac-mini"]} on mac-mini by default; honor any agent the user asked for (claude, claude-glm, codex). claude-glm only runs on exodia.`,
    "3. Write a complete, self-contained brief: the goal, the relevant context and constraints, what done looks like, and how to verify it. The agent sees nothing else.",
    `4. Call hermes_delegate_work exactly once with task_id "${record.taskId}", idempotency_key "${record.taskId}", host, repository, objective (the brief), acceptance_criteria (2-5 checkable items), and agent_kind only if not the default.`,
    "5. Finish with one line: `DELEGATED: <host> / <agent> — <one sentence on what the agent will do>`.",
    "If you cannot determine the repository or the request is too ambiguous to brief, do not delegate; finish with `NEEDS_INPUT: <the one question to ask the user>`.",
    "If the request is only a quick read-only question, answer it directly instead of delegating.",
  ].join("\n");
}
