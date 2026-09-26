"""Tool schemas exposed by the hermes-live Hermes plugin."""

HERMES_LIVE_STATUS = {
    "name": "hermes_live_status",
    "description": (
        "Inspect the configured hermes-live realtime voice gateway. Use this "
        "when the user asks whether realtime voice is installed, where the "
        "gateway is listening, or whether the gateway is ready."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "probe": {
                "type": "boolean",
                "description": "Whether to make HTTP requests to the gateway. Defaults to true.",
            },
            "include_readiness": {
                "type": "boolean",
                "description": "Whether to call /ready in addition to /health and /v1/capabilities.",
            },
            "timeout_ms": {
                "type": "integer",
                "minimum": 100,
                "maximum": 10000,
                "description": "HTTP probe timeout in milliseconds. Defaults to 2000.",
            },
        },
    },
}


HERMES_DELEGATE_WORK = {
    "name": "hermes_delegate_work",
    "description": (
        "Hand a piece of work to a coding agent (herdr) on exodia or the Mac mini "
        "through the hermes-live gateway, which launches the agent unattended, "
        "verifies it started, and monitors it. Use this as the orchestrator of a "
        "voice background task instead of doing the work yourself. Pass the task "
        "id you were given as both task_id and idempotency_key so a retry never "
        "starts a second agent."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "task_id": {"type": "string", "description": "The background task this agent works on (task_...)."},
            "idempotency_key": {"type": "string", "description": "Stable key for this handoff; use the task id."},
            "host": {"type": "string", "enum": ["exodia", "mac-mini"], "description": "Machine the agent runs on."},
            "repository": {"type": "string", "description": "Absolute path of the repository or working directory on that host."},
            "objective": {"type": "string", "description": "The complete, self-contained brief for the agent."},
            "acceptance_criteria": {
                "type": "array",
                "items": {"type": "string"},
                "maxItems": 8,
                "description": "2-5 checkable conditions that mean the work is done.",
            },
            "agent_kind": {
                "type": "string",
                "enum": ["claude", "claude-glm", "codex"],
                "description": "Omit for the host default (claude-glm on exodia, claude on mac-mini). claude-glm runs only on exodia.",
            },
        },
        "required": ["idempotency_key", "host", "repository", "objective"],
    },
}

