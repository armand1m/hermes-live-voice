import type { RealtimeResponseTruncation } from "../../../domain/protocol/client-protocol.js";

export interface LiveToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export type LiveToolName =
  | "continue_hermes_conversation"
  | "search_past_chats"
  | "remember"
  | "start_background_task"
  | "list_background_tasks"
  | "get_background_task"
  | "follow_up_background_task"
  | "stop_background_task"
  | "pause_voice_input"
  | "set_client_audio";

export interface LiveModelAudio {
  data: string;
  mimeType: string;
  itemId?: string;
  contentIndex?: number;
}

export interface LiveTaskNotification {
  notificationId?: string;
  /** Gateway-built marker with only generic safe copy. Never include a raw task title, output, or error. */
  context: string;
  /** Short, already-sanitized generic sentence that may be spoken to the user. */
  announcement: string;
  /** Exact speech override (deferred Hermes answers): spoken verbatim instead of the announcement. */
  speech?: string;
}

export const MAX_LIVE_TASK_NOTIFICATION_CONTEXT_CHARS = 1_000;
export const MAX_LIVE_TASK_NOTIFICATION_ANNOUNCEMENT_CHARS = 500;

export function requireLiveTaskNotification(value: unknown): LiveTaskNotification {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Task notification is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  const speech = candidate.speech === undefined
    ? undefined
    : requireTaskNotificationText(
        candidate.speech,
        MAX_LIVE_TASK_NOTIFICATION_ANNOUNCEMENT_CHARS,
        "speech",
      );
  return {
    context: requireTaskNotificationText(
      candidate.context,
      MAX_LIVE_TASK_NOTIFICATION_CONTEXT_CHARS,
      "context",
    ),
    announcement: requireTaskNotificationText(
      candidate.announcement,
      MAX_LIVE_TASK_NOTIFICATION_ANNOUNCEMENT_CHARS,
      "announcement",
    ),
    ...(speech !== undefined ? { speech } : {}),
  };
}

function requireTaskNotificationText(value: unknown, maximumChars: number, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumChars ||
    value.trim().length === 0 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new Error(`Task notification ${field} is invalid.`);
  }
  return value;
}

export type LiveModelEvent =
  | { type: "audio"; audio: LiveModelAudio }
  | { type: "text"; text: string; speaker?: "user" | "assistant" | "system"; final?: boolean }
  | {
      type: "response";
      status: "started" | "completed" | "cancelled" | "failed";
      responseId?: string;
      notificationId?: string;
      scope?: "conversation" | "task_notification";
      error?: string;
    }
  | { type: "tool_call"; call: LiveToolCall }
  | { type: "tool_call_cancelled"; callIds: string[] }
  | { type: "input_speech_started"; provider: "openai" | "local"; itemId?: string; audioStartMs?: number }
  | { type: "input_speech_stopped"; provider: "openai" | "local"; itemId?: string; audioEndMs?: number };

export interface LiveModelCallbacks {
  onEvent(event: LiveModelEvent): void;
  onOpen?(): void;
  onClose?(event?: unknown): void;
  onError?(error: unknown): void;
  /** A finalized user turn the adapter dropped before it became a response (e.g. mic echo). */
  onDroppedTurn?(drop: { kind: "echo"; text: string }): void;
}

export interface LiveModelSession {
  sendRealtimeAudio(audio: LiveModelAudio): Promise<void>;
  sendText(text: string): Promise<void>;
  /** Returns true when this call starts or schedules a provider response. */
  sendAudioStreamEnd(): Promise<boolean>;
  cancelResponse(reason?: string, truncate?: RealtimeResponseTruncation): Promise<boolean>;
  /**
   * Deliver a tool result. `suppressSpeech` asks adapters that would speak the
   * response's spoken_response as a provider exact-speech receipt to skip it
   * (the gateway sidecar is speaking it instead); the tool output itself is
   * always delivered.
   */
  sendToolResponse(
    call: LiveToolCall,
    response: Record<string, unknown>,
    options?: { suppressSpeech?: boolean },
  ): Promise<void>;
  sendTaskNotification?(notification: LiveTaskNotification): Promise<void>;
  close(): Promise<void>;
}

export interface LiveModelConnectParams {
  sessionId: string;
  systemInstruction: string;
  /** Only tools that can succeed for this negotiated client/session. */
  availableTools?: readonly LiveToolName[];
  safetyIdentifier?: string;
  callbacks: LiveModelCallbacks;
}

export interface LiveModelAdapter {
  connect(params: LiveModelConnectParams): Promise<LiveModelSession>;
}
