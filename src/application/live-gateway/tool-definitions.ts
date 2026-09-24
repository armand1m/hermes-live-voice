import type { LiveToolName } from "./ports/realtime-model.port.js";

const TASK_ID_SCHEMA = {
  type: "string",
  pattern: "^task_[a-f0-9]{32}$",
  description: "The stable Hermes Live task id returned by start_background_task or list_background_tasks.",
} as const;

const HERMES_LIVE_TOOL_DEFINITIONS = [
  {
    name: "continue_hermes_conversation",
    description:
      "Send one conversational turn to the Hermes session selected by the user. Use it for answers, memory, and follow-ups that must remain in that persisted chat; use a background task for long independent work.",
    parametersJsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        message: {
          type: "string",
          description: "The complete user request to append to the selected Hermes conversation.",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "search_past_chats",
    description:
      "Search the user's past Hermes conversations and memory for older context (previous chats, earlier decisions, forgotten details). Slower than answering directly: reserve it for history the current conversation does not contain.",
    parametersJsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "Short search phrase naming what to find, for example 'cats names' or 'server migration decision'.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "remember",
    description:
      "Persist one durable fact about the user for future sessions. Only use it when the user explicitly asks to remember, keep in mind, or note something. Hermes stores it and may stage it for approval.",
    parametersJsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fact: {
          type: "string",
          description: "The single self-contained fact to persist, phrased so it stays true later.",
        },
      },
      required: ["fact"],
    },
  },
  {
    name: "start_background_task",
    description:
      "Delegate meaningful work to Hermes Agent as a durable background task. Returns quickly; the user may keep talking or disconnect while the task continues.",
    parametersJsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        message: { type: "string", description: "The complete, concise task Hermes should perform." },
        title: { type: "string", description: "A short user-facing title for the task inbox." },
        recent_voice_context: {
          type: "string",
          description: "Only the minimum recent voice context required to resolve references in the task.",
        },
        execution_mode: {
          type: "string",
          enum: ["exclusive", "parallel_read_only"],
          description:
            "Use exclusive unless the task is provably read-only. Read-only tasks overlap only when their resource_keys are disjoint; mutating tasks are serialized.",
        },
        resource_keys: {
          type: "array",
          maxItems: 8,
          items: { type: "string" },
          description:
            "Stable resources read or touched by the task, such as an absolute repository path or deployment target. Tasks sharing a key never overlap.",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "list_background_tasks",
    description: "List this user's active and recent Hermes background tasks from the durable task inbox.",
    parametersJsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        include_completed: {
          type: "boolean",
          description: "Include recent terminal tasks. Defaults to true.",
        },
        summary_only: {
          type: "boolean",
          description: "Return a short safe spoken count instead of task details when the user asks only what is running.",
        },
      },
    },
  },
  {
    name: "get_background_task",
    description: "Read the exact status or retained result of one Hermes background task.",
    parametersJsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        task_id: TASK_ID_SCHEMA,
        include_output: {
          type: "boolean",
          description: "Include the bounded final output when it is available and the user asked for details.",
        },
      },
      required: ["task_id"],
    },
  },
  {
    name: "follow_up_background_task",
    description:
      "Start durable follow-up work from a finished task and its retained result. Use the exact task_id returned by the gateway. The follow-up is a new independently stoppable task in the same lineage.",
    parametersJsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        task_id: TASK_ID_SCHEMA,
        message: { type: "string", description: "The user's complete follow-up request." },
        title: { type: "string", description: "Optional short title for the follow-up task." },
      },
      required: ["task_id", "message"],
    },
  },
  {
    name: "stop_background_task",
    description: "Request cooperative cancellation of one exact Hermes background task.",
    parametersJsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        task_id: TASK_ID_SCHEMA,
        reason: { type: "string", description: "A short reason for the cancellation request." },
      },
      required: ["task_id"],
    },
  },
  {
    name: "archive_background_task",
    description:
      "Clear finished background tasks out of the inbox once the user knows their outcome. Only completed, failed, or cancelled tasks are eligible; queued or running work is never touched. Archiving (the default) moves the task to the private archive file and it disappears from lists; it stays recoverable offline by an operator. Use it when the user asks to clean up, clear, or tidy the task list, or after summarizing results they do not need anymore.",
    parametersJsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        task_id: TASK_ID_SCHEMA,
        all_finished: {
          type: "boolean",
          description:
            "Archive every finished task in this inbox instead of one. Tasks whose outcome has not been announced yet are kept and reported as skipped.",
        },
        delete: {
          type: "boolean",
          description:
            "Permanently erase the one named task instead of archiving it. Irreversible; requires clear user intent, and is never available together with all_finished.",
        },
      },
    },
  },
  {
    name: "pause_voice_input",
    description:
      "Pause microphone listening only when the user explicitly asks to pause, mute, or stop listening. This keeps Live Voice connected and leaves every background task running; the user resumes from the client control.",
    parametersJsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "set_client_audio",
    description:
      "Change the user's browser audio settings when they explicitly ask: resume or pause the microphone after a pause ('unmute me', 'listen again'), or turn the interface sound effects on/off and set their volume (0 to 1). Only change what the user asked for; the client applies the request and stays in charge of its own hardware.",
    parametersJsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        microphone: {
          type: "string",
          enum: ["active", "paused"],
          description: "Resume ('active') or pause ('paused') microphone listening on the client.",
        },
        effects: {
          type: "boolean",
          description: "Enable or disable the interface sound effects.",
        },
        effects_volume: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "Interface sound effects volume from 0 (silent) to 1 (loudest).",
        },
      },
    },
  },
  {
    name: "watch_external_agent",
    description:
      "Start durable observation of one external harness agent (herdr) on a fixed host when the user asks to watch, follow, or monitor an agent. Observation only: the gateway reports state changes and never prompts, cancels, or restarts the agent. Optionally link the task that delegated the work; the verified registration moves that task into the delegated phase.",
    parametersJsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        host: {
          type: "string",
          enum: ["exodia", "mac-mini"],
          description: "The fixed host the agent runs on.",
        },
        pane_id: {
          type: "string",
          pattern: "^w[0-9a-zA-Z]{1,8}:p[0-9]{1,4}$",
          description: "The agent's pane id, for example w4:p1 (from list_external_agents).",
        },
        agent_session_value: {
          type: "string",
          description: "The agent's session identity. Optional: resolved from the pane when omitted, and verified when provided.",
        },
        objective: {
          type: "string",
          description: "What the watched agent is working on, in one or two sentences.",
        },
        acceptance_criteria: {
          type: "array",
          maxItems: 8,
          items: { type: "string" },
          description: "How the user will judge the outcome. Optional.",
        },
        task_id: TASK_ID_SCHEMA,
      },
      required: ["host", "pane_id", "objective"],
    },
  },
  {
    name: "list_external_agents",
    description:
      "Discover the harness agents currently running on one host (herdr on exodia or mac-mini), with pane ids, status, and what each pane appears to be doing. Use before watch_external_agent to find the exact pane.",
    parametersJsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        host: {
          type: "string",
          enum: ["exodia", "mac-mini"],
          description: "The host to inspect.",
        },
      },
      required: ["host"],
    },
  },
  {
    name: "list_external_watches",
    description:
      "Summarize the external agents this user is currently watching: agent state per host, how long since the last verified observation, and which linked tasks are delegated. Idle means the outcome needs inspection, not that the work finished.",
    parametersJsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "stop_watching_agent",
    description:
      "Stop observing one external agent by its watch id. This only ends the watch; the agent itself is never touched.",
    parametersJsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        watch_id: {
          type: "string",
          pattern: "^watch_[a-f0-9]{32}$",
          description: "The watch id returned by watch_external_agent or list_external_watches.",
        },
      },
      required: ["watch_id"],
    },
  },
] as const satisfies ReadonlyArray<{
  name: LiveToolName;
  description: string;
  parametersJsonSchema: Readonly<Record<string, unknown>>;
}>;

export const HERMES_LIVE_TOOL_DECLARATIONS = HERMES_LIVE_TOOL_DEFINITIONS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  parametersJsonSchema: tool.parametersJsonSchema,
}));

export const OPENAI_HERMES_LIVE_TOOLS = HERMES_LIVE_TOOL_DEFINITIONS.map((tool) => ({
  type: "function" as const,
  name: tool.name,
  description: tool.description,
  parameters: tool.parametersJsonSchema,
}));

const COMPACT_TOOL_DESCRIPTIONS: Record<LiveToolName, string> = {
  continue_hermes_conversation: "Continue the selected saved Hermes chat for one short turn.",
  search_past_chats: "Search past Hermes chats and memory for older context.",
  remember: "Store a durable user fact in Hermes memory.",
  start_background_task: "Start durable Hermes work while the user keeps talking or disconnects.",
  list_background_tasks: "List active and recent tasks with their exact ids.",
  get_background_task: "Get one task's exact status or retained result.",
  follow_up_background_task: "Start new durable work from one finished task.",
  stop_background_task: "Request cancellation of one exact task.",
  archive_background_task: "Archive or permanently delete finished tasks to clear the inbox.",
  pause_voice_input: "Pause microphone input without stopping tasks or disconnecting.",
  set_client_audio: "Resume or pause the mic, or change interface sound effects, on explicit request.",
  watch_external_agent: "Watch one external herdr agent by host and pane; observation only.",
  list_external_agents: "Discover herdr agents on one host with pane ids and status.",
  list_external_watches: "Summarize watched external agents and their linked delegated tasks.",
  stop_watching_agent: "Stop observing one external agent by watch id.",
};

export function selectHermesLiveToolDeclarations(names?: readonly LiveToolName[]) {
  if (names === undefined) return HERMES_LIVE_TOOL_DECLARATIONS;
  const allowed = new Set(names);
  return HERMES_LIVE_TOOL_DECLARATIONS.filter((tool) => allowed.has(tool.name));
}

export function selectOpenAIHermesLiveTools(names?: readonly LiveToolName[]) {
  if (names === undefined) return OPENAI_HERMES_LIVE_TOOLS;
  const allowed = new Set(names);
  return OPENAI_HERMES_LIVE_TOOLS.filter((tool) => allowed.has(tool.name));
}

/** Keep local-model prefill small without changing names, validation, or capabilities. */
export function selectCompactOpenAIHermesLiveTools(names?: readonly LiveToolName[]) {
  return selectOpenAIHermesLiveTools(names).map((tool) => ({
    ...tool,
    description: COMPACT_TOOL_DESCRIPTIONS[tool.name],
    parameters: withoutJsonSchemaDescriptions(tool.parameters),
  }));
}

function withoutJsonSchemaDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutJsonSchemaDescriptions);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "description")
      .map(([key, child]) => [key, withoutJsonSchemaDescriptions(child)]),
  );
}
