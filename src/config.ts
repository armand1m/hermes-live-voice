import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod/v3";

export const MAX_COMPATIBLE_AUDIO_FRAME_BYTES = 5_900_000;
export const MAX_COMPATIBLE_TEXT_CHARS = 1_000_000;
export const DEFAULT_HERMES_STREAM_IDLE_TIMEOUT_MS = 120_000;
export const DEFAULT_HERMES_CHAT_TIMEOUT_MS = 120_000;
const MAX_OUTBOUND_BASE_URL_CHARS = 2_048;
const MAX_STATE_FILE_PATH_CHARS = 4_096;

const HermesBaseUrlSchema = z.string().url().refine(isSafeHermesBaseUrl, {
  message: "HERMES_BASE_URL must be a credential-free HTTP(S) root origin.",
});
const OpenAIRealtimeBaseUrlSchema = z.string().url().refine(isSafeOpenAIRealtimeBaseUrl, {
  message: "OPENAI_REALTIME_BASE_URL must be a credential-free WS(S) URL without a fragment.",
});
const LocalRealtimeUrlSchema = z.string().url().refine(isSafeRealtimeWebSocketUrl, {
  message: "HERMES_LIVE_LOCAL_URL must be a credential-free WS(S) URL without a fragment.",
});
const RivaRealtimeUrlSchema = z.string().url().refine(isSafeRealtimeWebSocketUrl, {
  message: "Riva endpoints must be credential-free WS(S) URLs without a fragment.",
});
const RivaBrainUrlSchema = z.string().url().refine(isSafeHttpLocalUrl, {
  message: "HERMES_LIVE_RIVA_BRAIN_URL must be a credential-free local HTTP(S) URL.",
});
const GoogleCloudProjectSchema = z.preprocess(
  (value) => value === "" ? undefined : value,
  z.string().min(6).max(30).refine(isSafeGoogleCloudProject, {
    message: "GOOGLE_CLOUD_PROJECT must be a canonical Google Cloud project id.",
  }).optional(),
);
const GoogleCloudLocationSchema = z.string().min(1).max(63).refine(isSafeGoogleCloudLocation, {
  message: "GOOGLE_CLOUD_LOCATION must be a canonical Google Cloud location.",
});
const GoogleGenAiApiVersionSchema = z.preprocess(
  (value) => value === "" ? undefined : value,
  z.string().min(2).max(32).refine(isSafeGoogleGenAiApiVersion, {
    message: "GOOGLE_GENAI_API_VERSION must be a bounded v1/v1beta/v1alpha-style token.",
  }).optional(),
);
const TaskStateFileSchema = z.string().min(1).max(MAX_STATE_FILE_PATH_CHARS).refine(
  (value) => isAbsolute(value) && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value),
  { message: "HERMES_LIVE_TASK_STATE_FILE must be a bounded absolute path." },
);
const OpenAITranscriptionModelSchema = z.string().trim().min(1).max(128).refine(
  (value) => value === "disabled" || /^[a-z0-9][a-z0-9._-]*$/u.test(value),
  { message: "OPENAI_REALTIME_INPUT_TRANSCRIPTION_MODEL must be a model id or disabled." },
);
const OpenAITranscriptionLanguageSchema = z.preprocess(
  (value) => value === "" ? undefined : value,
  z.string().regex(/^[a-z]{2}$/u, {
    message: "OPENAI_REALTIME_INPUT_TRANSCRIPTION_LANGUAGE must be a lowercase ISO-639-1 code.",
  }).optional(),
);
const HermesHomePathSchema = z.string().min(1).max(MAX_STATE_FILE_PATH_CHARS).refine(
  (value) => isAbsolute(value) && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value),
  { message: "HERMES_LIVE_HERMES_HOME must be a bounded absolute path to the Hermes home directory." },
);
const VadModelPathSchema = z.string().min(1).max(MAX_STATE_FILE_PATH_CHARS).refine(
  (value) => isAbsolute(value) && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value),
  { message: "HERMES_LIVE_VAD_MODEL must be a bounded absolute path to a Silero VAD ONNX model." },
);

const FillerDirectoryPathSchema = z.string().min(1).max(MAX_STATE_FILE_PATH_CHARS).refine(
  (value) => isAbsolute(value) && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value),
  { message: "HERMES_LIVE_FILLER_DIR must be a bounded absolute path to a filler clip directory." },
);

const EnvSchema = z.object({
  NODE_ENV: z.string().optional(),
  HERMES_LIVE_HOST: z.string().default("127.0.0.1"),
  HERMES_LIVE_PORT: z.coerce.number().int().min(1).max(65535).default(8788),
  PORT: z.coerce.number().int().min(1).max(65535).optional(),
  HERMES_LIVE_AUTH_TOKEN: z.string().optional(),
  HERMES_LIVE_ALLOW_UNAUTHENTICATED: z.string().optional(),
  HERMES_LIVE_ALLOW_ORIGIN: z.string().optional(),
  HERMES_LIVE_SESSION_PREFIX: z.string().default("agent:main:hermes-live"),
  HERMES_LIVE_PROFILE_ID: z.string().default("default"),
  HERMES_LIVE_USER_LABEL: z.string().default("voice"),
  HERMES_LIVE_TRUST_CLIENT_IDENTITY: z.string().optional(),
  HERMES_LIVE_MAX_SESSIONS: z.coerce.number().int().positive().optional(),
  HERMES_LIVE_MAX_AUDIO_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_COMPATIBLE_AUDIO_FRAME_BYTES)
    .default(2_000_000),
  HERMES_LIVE_MAX_TEXT_CHARS: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_COMPATIBLE_TEXT_CHARS)
    .default(20_000),
  HERMES_LIVE_PROVIDER_READY_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  /** WebSocket keepalive ping interval for live sessions; 0 disables the reaper. */
  HERMES_LIVE_WS_KEEPALIVE_MS: z.coerce.number().int().min(0).max(600_000).default(15_000),
  HERMES_LIVE_TASK_STATE_FILE: TaskStateFileSchema.default(
    join(homedir(), ".hermes", "hermes-live", "tasks-v1.json"),
  ),
  HERMES_LIVE_MAX_CONCURRENT_TASKS: z.coerce.number().int().min(1).max(16).default(3),
  HERMES_LIVE_TRUST_DECLARED_READ_ONLY: z.string().optional(),
  HERMES_LIVE_MAX_QUEUED_TASKS: z.coerce.number().int().min(0).max(512).default(32),
  HERMES_LIVE_TASK_HISTORY_LIMIT: z.coerce.number().int().min(10).max(1_000).default(200),
  HERMES_LIVE_TASK_RETENTION_HOURS: z.coerce.number().int().min(1).max(8_760).default(168),
  HERMES_LIVE_TASK_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(2_000),

  HERMES_BASE_URL: HermesBaseUrlSchema.default("http://127.0.0.1:8642"),
  HERMES_AGENT_API_SERVER_KEY: z.string().optional(),
  HERMES_API_KEY: z.string().optional(),
  HERMES_MODEL: z.string().trim().min(1).max(512).optional(),
  HERMES_LIVE_RUN_INSTRUCTIONS: z.string().optional(),
  HERMES_LIVE_HERMES_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  HERMES_LIVE_HERMES_CHAT_TIMEOUT_MS: z.coerce.number().int().positive().max(2_147_483_647).optional(),
  HERMES_LIVE_ASYNC_TOOLS_ENABLED: z.enum(["1", "true", "yes", "on", "0", "false", "no", "off"]).optional(),
  /** Hard deadline before pending speech is forced into the next inter-turn gap. */
  HERMES_LIVE_ANNOUNCE_MAX_DELAY_MS: z.coerce.number().int().min(5_000).max(600_000).default(90_000),
  HERMES_LIVE_DEFERRED_ANSWER_MAX_DELAY_MS: z.coerce.number().int().min(1_000).max(90_000).default(15_000),
  HERMES_LIVE_HERMES_STREAM_IDLE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(2_147_483_647)
    .default(DEFAULT_HERMES_STREAM_IDLE_TIMEOUT_MS),

  HERMES_LIVE_PROVIDER: z.enum(["local", "riva", "gemini", "openai", "mock"]).default("local"),
  HERMES_LIVE_LOCAL_URL: LocalRealtimeUrlSchema.default("ws://127.0.0.1:8765/v1/realtime"),
  HERMES_LIVE_RIVA_ASR_URL: RivaRealtimeUrlSchema.default("ws://127.0.0.1:19000/v1/realtime?intent=transcription"),
  HERMES_LIVE_RIVA_TTS_URL: RivaRealtimeUrlSchema.default("ws://127.0.0.1:19001/v1/realtime?intent=synthesize"),
  HERMES_LIVE_RIVA_BRAIN_URL: RivaBrainUrlSchema.default("http://127.0.0.1:30000/v1/chat/completions"),
  HERMES_LIVE_RIVA_BRAIN_MODEL: z.string().trim().min(1).max(128).default("qwen3.8-27b"),
  HERMES_LIVE_RIVA_BRAIN_API_KEY: z.string().optional(),
  HERMES_LIVE_RIVA_MINT_API_KEY: z.string().optional(),
  HERMES_LIVE_RIVA_ASR_WORD_BOOST: z.string().default("Hermes,herdr,exodia,Mac mini"),
  // Riva recommends 20-100 for CTC models (the live Parakeet 1.1b CTC NIM)
  // and 0.5-2.0 for RNNT/TDT; 0 disables boosting.
  HERMES_LIVE_RIVA_ASR_WORD_BOOST_SCORE: z.coerce.number().min(0).max(100).default(30),
  HERMES_LIVE_EXTERNAL_WORK_ENABLED: z.string().optional(),
  HERMES_LIVE_PROGRESS_ANNOUNCEMENTS: z.string().optional(),
  HERMES_LIVE_HERDR_EXECUTABLE: z.string().min(1).default("herdr"),
  HERMES_LIVE_MSSH_EXECUTABLE: z.string().min(1).default("mssh"),
  HERMES_LIVE_RIVA_VOICE: z.string().trim().min(1).max(128).default("Magpie-Multilingual.EN-US.Jason"),
  HERMES_LIVE_RIVA_WS_KEEPALIVE_MS: z.coerce.number().int().min(0).max(120_000).default(25_000),
  HERMES_LIVE_RIVA_BRAIN_MAX_TOKENS: z.coerce.number().int().min(128).max(8_192).default(2_048),
  HERMES_LIVE_RIVA_BRAIN_REASONING_EFFORT: z.enum(["off", "minimal", "low", "medium", "high"]).default("low"),
  HERMES_LIVE_RIVA_ECHO_GUARD: z.enum(["1", "true", "yes", "on", "0", "false", "no", "off"]).optional(),
  HERMES_LIVE_RIVA_BRAIN_STREAMING: z.enum(["1", "true", "yes", "on", "0", "false", "no", "off"]).optional(),
  HERMES_LIVE_RIVA_BRAIN_THINKING: z.enum(["1", "true", "yes", "on", "0", "false", "no", "off"]).optional(),
  HERMES_LIVE_RIVA_BRAIN_PREWARM: z.enum(["1", "true", "yes", "on", "0", "false", "no", "off"]).optional(),
  HERMES_LIVE_KNOWLEDGE_INDEX: z.enum(["1", "true", "yes", "on", "0", "false", "no", "off"]).optional(),
  HERMES_LIVE_KNOWLEDGE_TURN_CONTEXT: z.enum(["1", "true", "yes", "on", "0", "false", "no", "off"]).optional(),
  HERMES_LIVE_KNOWLEDGE_REFLECTION: z.enum(["1", "true", "yes", "on", "0", "false", "no", "off"]).optional(),
  HERMES_LIVE_TTS_URL: z.string().url().refine(isSafeHttpLocalUrl, {
    message: "HERMES_LIVE_TTS_URL must be a credential-free local HTTP(S) URL (tts sidecar).",
  }).optional(),
  HERMES_LIVE_TTS_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
  HERMES_LIVE_TTS_MAX_CHARS: z.coerce.number().int().min(100).max(4_000).default(1_000),
  HERMES_LIVE_NARRATOR_URL: z.string().url().refine(isSafeHttpLocalUrl, {
    message: "HERMES_LIVE_NARRATOR_URL must be a credential-free local HTTP(S) URL (OpenAI-compatible LLM for task narration).",
  }).optional(),
  HERMES_LIVE_NARRATOR_MODEL: z.string().trim().min(1).max(128).default("qwen3.8-27b"),
  HERMES_LIVE_NARRATOR_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  HERMES_LIVE_LOCAL_VOICE: z.string().trim().min(1).max(128).default("Aiden"),
  HERMES_LIVE_LAYA_URL: z.string().url().refine(isSafeHttpLocalUrl, {
    message: "HERMES_LIVE_LAYA_URL must be a credential-free local HTTP(S) URL (laya sidecar).",
  }).optional(),
  /** Shadow-mode logging only while piloting; unset URL disables it entirely. */
  HERMES_LIVE_LAYA_SHADOW_ENABLED: z.enum(["1", "true", "yes", "on", "0", "false", "no", "off"]).optional(),
  HERMES_LIVE_LAYA_TIMEOUT_MS: z.coerce.number().int().min(250).max(10_000).default(1_500),
  HERMES_LIVE_LOCAL_ALLOW_REMOTE: z.string().optional(),
  HERMES_LIVE_LOCAL_OWNS_TURN_ROUTING: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-3.1-flash-live-preview"),
  GOOGLE_GENAI_USE_ENTERPRISE: z.string().optional(),
  GOOGLE_CLOUD_PROJECT: GoogleCloudProjectSchema,
  GOOGLE_CLOUD_LOCATION: GoogleCloudLocationSchema.default("us-central1"),
  GOOGLE_GENAI_API_VERSION: GoogleGenAiApiVersionSchema,

  OPENAI_API_KEY: z.string().optional(),
  OPENAI_REALTIME_BASE_URL: OpenAIRealtimeBaseUrlSchema.default("wss://api.openai.com/v1/realtime"),
  OPENAI_REALTIME_MODEL: z.string().default("gpt-realtime-2"),
  OPENAI_REALTIME_VOICE: z.string().default("marin"),
  OPENAI_REALTIME_REASONING_EFFORT: z.enum(["minimal", "low", "medium", "high", "xhigh"]).default("low"),
  OPENAI_REALTIME_TURN_DETECTION: z.enum(["disabled", "semantic_vad", "server_vad"]).default("server_vad"),
  OPENAI_REALTIME_INPUT_AUDIO_FORMAT: z.enum(["pcm16", "g711_ulaw", "g711_alaw"]).default("pcm16"),
  OPENAI_REALTIME_OUTPUT_AUDIO_FORMAT: z.enum(["pcm16", "g711_ulaw", "g711_alaw"]).default("pcm16"),
  OPENAI_REALTIME_INPUT_TRANSCRIPTION_MODEL: OpenAITranscriptionModelSchema.default("gpt-4o-mini-transcribe"),
  OPENAI_REALTIME_INPUT_TRANSCRIPTION_LANGUAGE: OpenAITranscriptionLanguageSchema,

  HERMES_LIVE_HERMES_HOME: HermesHomePathSchema.optional(),
  HERMES_LIVE_CONTEXT_DIGEST: z.string().optional(),
  HERMES_LIVE_VOICE_THREAD_TITLE: z.string().trim().min(1).max(100).default("Hermes Live Voice"),
  HERMES_LIVE_RECALL_SESSION_TITLE: z.string().trim().min(1).max(100).default("Hermes Live Voice Recall"),
  HERMES_LIVE_RECALL_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(120_000).default(30_000),

  HERMES_LIVE_VAD: z.enum(["smart", "energy", "disabled"]).default("smart"),
  HERMES_LIVE_VAD_MODEL: VadModelPathSchema.optional(),
  HERMES_LIVE_VAD_START_PROBABILITY: z.coerce.number().min(0.05).max(0.95).default(0.5),
  HERMES_LIVE_VAD_STOP_PROBABILITY: z.coerce.number().min(0.05).max(0.95).default(0.25),
  HERMES_LIVE_VAD_START_SUSTAIN_MS: z.coerce.number().int().min(32).max(1_000).default(100),
  HERMES_LIVE_VAD_STOP_SUSTAIN_MS: z.coerce.number().int().min(100).max(2_000).default(500),
  HERMES_LIVE_VAD_ECHO_START_PROBABILITY: z.coerce.number().min(0.1).max(0.99).default(0.7),
  HERMES_LIVE_VAD_ECHO_START_SUSTAIN_MS: z.coerce.number().int().min(32).max(1_000).default(200),
  HERMES_LIVE_VAD_PREROLL_MS: z.coerce.number().int().min(0).max(1_000).default(250),
  HERMES_LIVE_VAD_TAIL_MS: z.coerce.number().int().min(0).max(2_000).default(400),
  HERMES_LIVE_VAD_RECORDING: z.enum(["1", "true", "yes", "on", "0", "false", "no", "off"]).optional(),
  HERMES_LIVE_VAD_RECORDING_MAX_MB: z.coerce.number().int().min(10).max(20_000).default(500),
  HERMES_LIVE_VAD_RECORDING_RETENTION_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  HERMES_LIVE_HALF_DUPLEX: z.enum(["1", "true", "yes", "on", "0", "false", "no", "off"]).optional(),
  HERMES_LIVE_TURN_TAIL_MS: z.coerce.number().int().min(0).max(5_000).default(1_000),

  HERMES_LIVE_FILLER_ENABLED: z.enum(["1", "true", "yes", "on", "0", "false", "no", "off"]).optional(),
  HERMES_LIVE_FILLER_DELAY_MS: z.coerce.number().int().min(500).max(60_000).default(2_500),
  HERMES_LIVE_FILLER_INTERVAL_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
  HERMES_LIVE_FILLER_MAX_PER_TOOL: z.coerce.number().int().min(1).max(10).default(3),
  HERMES_LIVE_FILLER_DIR: FillerDirectoryPathSchema.optional(),
});

export type RealtimeProvider = "local" | "riva" | "gemini" | "openai" | "mock";

export interface ContextConfig {
  hermesHome: string;
  digestEnabled: boolean;
  voiceThreadTitle: string;
  recallSessionTitle: string;
  recallTimeoutMs: number;
}

export interface KnowledgeConfig {
  /** Build and use the local index for fast recall (default on). */
  enabled: boolean;
  /** Add strong matches as reference context to each voice brain turn (default off). */
  turnContext: boolean;
  /** Index file; a derived cache that is safe to delete. */
  path: string;
  /** After substantial voice sessions, let Hermes update memory/skills from the transcript (default off). */
  reflection?: boolean;
}

export interface VadRecordingConfig {
  enabled: boolean;
  /** Owner-only directory next to the task state. */
  directory: string;
  maxTotalBytes: number;
  retentionMs: number;
}

export interface VadConfig {
  engine: "smart" | "energy" | "disabled";
  modelPath?: string;
  startProbability: number;
  stopProbability: number;
  startSustainMs: number;
  stopSustainMs: number;
  echoStartProbability: number;
  echoStartSustainMs: number;
  prerollMs: number;
  tailMs: number;
  /** Half-duplex turn policy: never confirm speech while assistant audio drains. */
  halfDuplex: boolean;
  /** Extra margin after the last downlink frame before speech may start a turn. */
  turnTailMs: number;
}

export interface FillerConfig {
  enabled: boolean;
  delayMs: number;
  intervalMs: number;
  maxPerTool: number;
  /** Override the bundled assets/filler clip directory (tests, alt voices). */
  directory?: string;
}

export interface AppConfig {
  server: {
    host: string;
    port: number;
    authToken?: string;
    allowUnauthenticated: boolean;
    allowOrigin?: string;
    sessionPrefix: string;
    defaultProfileId: string;
    defaultUserLabel: string;
    trustClientIdentity: boolean;
    maxSessions: number;
    maxAudioBytes: number;
    maxTextChars: number;
    providerReadyTimeoutMs: number;
    /** Client WebSocket ping interval; 0 disables the zombie reaper. */
    wsKeepaliveMs?: number;
  };
  hermes: {
    baseUrl: string;
    apiKey?: string;
    model?: string;
    instructions?: string;
    timeoutMs: number;
    chatTimeoutMs?: number;
    streamIdleTimeoutMs?: number;
    /** Slow chat/recall tools return spoken receipts; answers arrive later. */
    asyncTools?: boolean;
    /** Pending answer/announcement speech older than this forces delivery. */
    announceMaxDelayMs?: number;
    /** Force a ready-but-undelivered deferred answer at the first gap past this age. */
    deferredAnswerMaxDelayMs?: number;
  };
  tasks: {
    stateFile: string;
    maxConcurrent: number;
    trustDeclaredReadOnly: boolean;
    maxQueued: number;
    historyLimit: number;
    retentionMs: number;
    pollIntervalMs: number;
  };
  realtime: {
    provider: RealtimeProvider;
    model: string;
  };
  local: {
    url: string;
    voice: string;
    allowRemote: boolean;
    /** Managed runtime compatibility mode; external upstream endpoints leave this unset. */
    ownsTurnRouting?: boolean;
  };
  externalWork?: { enabled: boolean; progressAnnouncements: boolean; herdrExecutable: string; msshExecutable: string };
  riva: {
    asrWordBoost?: string[];
    asrWordBoostScore?: number;
    asrUrl: string;
    ttsUrl: string;
    brainUrl: string;
    brainModel: string;
    brainApiKey?: string;
    mintApiKey?: string;
    voice: string;
    /** ASR WebSocket ping interval; 0 disables (NIMs idle-close quiet sockets). */
    wsKeepaliveMs: number;
    brainMaxTokens: number;
    brainReasoningEffort: "off" | "minimal" | "low" | "medium" | "high";
    /** Drop user turns that match recently spoken assistant text (mic echo). */
    echoGuard: boolean;
    /** Stream the brain answer and synthesize it sentence by sentence (default off). */
    brainStreaming?: boolean;
    /** False sends enable_thinking=false: no reasoning before the answer (default on). */
    brainThinking?: boolean;
    /** Prefill the prompt cache once per session so the first turn skips it (default on). */
    brainPrewarm?: boolean;
  };
  tts: {
    /** Sidecar TTS base URL; unset routes all speech through the provider. */
    baseUrl?: string;
    requestTimeoutMs: number;
    maxChars: number;
  };
  narrator: {
    /** OpenAI-compatible LLM base URL for task-log narration; unset disables the endpoint. */
    baseUrl?: string;
    model: string;
    requestTimeoutMs: number;
  };
  laya: {
    /** LAYA System-1 sidecar base URL; unset keeps the shadow client fully inert. */
    baseUrl?: string;
    /** Shadow logging on/off (logs only; never gates behavior). */
    shadowEnabled: boolean;
    timeoutMs: number;
  };
  gemini: {
    apiKey?: string;
    model: string;
    enterprise: boolean;
    project?: string;
    location: string;
    apiVersion?: string;
  };
  openai: {
    apiKey?: string;
    baseUrl: string;
    model: string;
    voice: string;
    reasoningEffort: "minimal" | "low" | "medium" | "high" | "xhigh";
    turnDetection: "disabled" | "semantic_vad" | "server_vad";
    inputAudioFormat: "pcm16" | "g711_ulaw" | "g711_alaw";
    outputAudioFormat: "pcm16" | "g711_ulaw" | "g711_alaw";
    inputTranscriptionModel?: string;
    inputTranscriptionLanguage?: string;
  };
  vad: VadConfig;
  filler: FillerConfig;
  context: ContextConfig;
  /** Local knowledge index (node:sqlite FTS5); absent means disabled. */
  knowledge?: KnowledgeConfig;
  /** Opt-in local recording of what the speech gate heard, for endpointing tuning. */
  vadRecording?: VadRecordingConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);
  const geminiApiKey = parsed.GEMINI_API_KEY || parsed.GOOGLE_API_KEY;
  const hermesApiKey = parsed.HERMES_AGENT_API_SERVER_KEY || parsed.HERMES_API_KEY;
  const enterprise = parseBool(parsed.GOOGLE_GENAI_USE_ENTERPRISE);
  const realtimeModel = selectedRealtimeModel(parsed.HERMES_LIVE_PROVIDER, parsed.GEMINI_MODEL, parsed.OPENAI_REALTIME_MODEL);

  return {
    server: {
      host: parsed.HERMES_LIVE_HOST,
      port: parsed.PORT ?? parsed.HERMES_LIVE_PORT,
      ...(parsed.HERMES_LIVE_AUTH_TOKEN ? { authToken: parsed.HERMES_LIVE_AUTH_TOKEN } : {}),
      allowUnauthenticated: parseBool(parsed.HERMES_LIVE_ALLOW_UNAUTHENTICATED),
      ...(parsed.HERMES_LIVE_ALLOW_ORIGIN ? { allowOrigin: parsed.HERMES_LIVE_ALLOW_ORIGIN } : {}),
      sessionPrefix: parsed.HERMES_LIVE_SESSION_PREFIX,
      defaultProfileId: parsed.HERMES_LIVE_PROFILE_ID,
      defaultUserLabel: parsed.HERMES_LIVE_USER_LABEL,
      trustClientIdentity: parseBool(parsed.HERMES_LIVE_TRUST_CLIENT_IDENTITY),
      maxSessions: parsed.HERMES_LIVE_MAX_SESSIONS ?? (parsed.HERMES_LIVE_PROVIDER === "local" ? 1 : 8),
      maxAudioBytes: parsed.HERMES_LIVE_MAX_AUDIO_BYTES,
      maxTextChars: parsed.HERMES_LIVE_MAX_TEXT_CHARS,
      providerReadyTimeoutMs: parsed.HERMES_LIVE_PROVIDER_READY_TIMEOUT_MS,
      wsKeepaliveMs: parsed.HERMES_LIVE_WS_KEEPALIVE_MS,
    },
    hermes: {
      baseUrl: withoutTrailingSlash(parsed.HERMES_BASE_URL),
      ...(hermesApiKey ? { apiKey: hermesApiKey } : {}),
      ...(parsed.HERMES_MODEL ? { model: parsed.HERMES_MODEL } : {}),
      ...(parsed.HERMES_LIVE_RUN_INSTRUCTIONS ? { instructions: parsed.HERMES_LIVE_RUN_INSTRUCTIONS } : {}),
      timeoutMs: parsed.HERMES_LIVE_HERMES_TIMEOUT_MS,
      chatTimeoutMs: parsed.HERMES_LIVE_HERMES_CHAT_TIMEOUT_MS
        ?? Math.max(DEFAULT_HERMES_CHAT_TIMEOUT_MS, parsed.HERMES_LIVE_HERMES_TIMEOUT_MS),
      streamIdleTimeoutMs: parsed.HERMES_LIVE_HERMES_STREAM_IDLE_TIMEOUT_MS,
      asyncTools: parsed.HERMES_LIVE_ASYNC_TOOLS_ENABLED === undefined
        || ["1", "true", "yes", "on"].includes(parsed.HERMES_LIVE_ASYNC_TOOLS_ENABLED),
      announceMaxDelayMs: parsed.HERMES_LIVE_ANNOUNCE_MAX_DELAY_MS,
      deferredAnswerMaxDelayMs: parsed.HERMES_LIVE_DEFERRED_ANSWER_MAX_DELAY_MS,
    },
    tasks: {
      stateFile: parsed.HERMES_LIVE_TASK_STATE_FILE,
      maxConcurrent: parsed.HERMES_LIVE_MAX_CONCURRENT_TASKS,
      trustDeclaredReadOnly: parseBool(parsed.HERMES_LIVE_TRUST_DECLARED_READ_ONLY),
      maxQueued: parsed.HERMES_LIVE_MAX_QUEUED_TASKS,
      historyLimit: parsed.HERMES_LIVE_TASK_HISTORY_LIMIT,
      retentionMs: parsed.HERMES_LIVE_TASK_RETENTION_HOURS * 60 * 60 * 1_000,
      pollIntervalMs: parsed.HERMES_LIVE_TASK_POLL_INTERVAL_MS,
    },
    realtime: {
      provider: parsed.HERMES_LIVE_PROVIDER,
      model: realtimeModel,
    },
    local: {
      url: parsed.HERMES_LIVE_LOCAL_URL,
      voice: parsed.HERMES_LIVE_LOCAL_VOICE,
      allowRemote: parseBool(parsed.HERMES_LIVE_LOCAL_ALLOW_REMOTE),
      ownsTurnRouting: parseBool(parsed.HERMES_LIVE_LOCAL_OWNS_TURN_ROUTING),
    },
    externalWork: {
      enabled: parseBool(parsed.HERMES_LIVE_EXTERNAL_WORK_ENABLED),
      progressAnnouncements: parseBool(parsed.HERMES_LIVE_PROGRESS_ANNOUNCEMENTS),
      herdrExecutable: parsed.HERMES_LIVE_HERDR_EXECUTABLE,
      msshExecutable: parsed.HERMES_LIVE_MSSH_EXECUTABLE,
    },
    riva: {
      asrWordBoost: parsed.HERMES_LIVE_RIVA_ASR_WORD_BOOST.split(",").map((word) => word.trim()).filter(Boolean).slice(0, 100),
      asrWordBoostScore: parsed.HERMES_LIVE_RIVA_ASR_WORD_BOOST_SCORE,
      asrUrl: parsed.HERMES_LIVE_RIVA_ASR_URL,
      ttsUrl: parsed.HERMES_LIVE_RIVA_TTS_URL,
      brainUrl: parsed.HERMES_LIVE_RIVA_BRAIN_URL,
      brainModel: parsed.HERMES_LIVE_RIVA_BRAIN_MODEL,
      ...(parsed.HERMES_LIVE_RIVA_BRAIN_API_KEY ? { brainApiKey: parsed.HERMES_LIVE_RIVA_BRAIN_API_KEY } : {}),
      ...(parsed.HERMES_LIVE_RIVA_MINT_API_KEY ? { mintApiKey: parsed.HERMES_LIVE_RIVA_MINT_API_KEY } : {}),
      voice: parsed.HERMES_LIVE_RIVA_VOICE,
      wsKeepaliveMs: parsed.HERMES_LIVE_RIVA_WS_KEEPALIVE_MS,
      brainMaxTokens: parsed.HERMES_LIVE_RIVA_BRAIN_MAX_TOKENS,
      brainReasoningEffort: parsed.HERMES_LIVE_RIVA_BRAIN_REASONING_EFFORT,
      echoGuard: parsed.HERMES_LIVE_RIVA_ECHO_GUARD === undefined
        || ["1", "true", "yes", "on"].includes(parsed.HERMES_LIVE_RIVA_ECHO_GUARD),
      brainStreaming: parsed.HERMES_LIVE_RIVA_BRAIN_STREAMING !== undefined
        && ["1", "true", "yes", "on"].includes(parsed.HERMES_LIVE_RIVA_BRAIN_STREAMING),
      brainThinking: parsed.HERMES_LIVE_RIVA_BRAIN_THINKING === undefined
        || ["1", "true", "yes", "on"].includes(parsed.HERMES_LIVE_RIVA_BRAIN_THINKING),
      brainPrewarm: parsed.HERMES_LIVE_RIVA_BRAIN_PREWARM === undefined
        || ["1", "true", "yes", "on"].includes(parsed.HERMES_LIVE_RIVA_BRAIN_PREWARM),
    },
    tts: {
      ...(parsed.HERMES_LIVE_TTS_URL ? { baseUrl: parsed.HERMES_LIVE_TTS_URL } : {}),
      requestTimeoutMs: parsed.HERMES_LIVE_TTS_TIMEOUT_MS,
      maxChars: parsed.HERMES_LIVE_TTS_MAX_CHARS,
    },
    narrator: {
      ...(parsed.HERMES_LIVE_NARRATOR_URL ? { baseUrl: parsed.HERMES_LIVE_NARRATOR_URL } : {}),
      model: parsed.HERMES_LIVE_NARRATOR_MODEL,
      requestTimeoutMs: parsed.HERMES_LIVE_NARRATOR_TIMEOUT_MS,
    },
    laya: {
      ...(parsed.HERMES_LIVE_LAYA_URL ? { baseUrl: withoutTrailingSlash(parsed.HERMES_LIVE_LAYA_URL) } : {}),
      shadowEnabled: parsed.HERMES_LIVE_LAYA_SHADOW_ENABLED === undefined
        || ["1", "true", "yes", "on"].includes(parsed.HERMES_LIVE_LAYA_SHADOW_ENABLED),
      timeoutMs: parsed.HERMES_LIVE_LAYA_TIMEOUT_MS,
    },
    gemini: {
      ...(geminiApiKey ? { apiKey: geminiApiKey } : {}),
      model: parsed.GEMINI_MODEL,
      enterprise,
      ...(parsed.GOOGLE_CLOUD_PROJECT ? { project: parsed.GOOGLE_CLOUD_PROJECT } : {}),
      location: parsed.GOOGLE_CLOUD_LOCATION,
      ...(parsed.GOOGLE_GENAI_API_VERSION ? { apiVersion: parsed.GOOGLE_GENAI_API_VERSION } : {}),
    },
    openai: {
      ...(parsed.OPENAI_API_KEY ? { apiKey: parsed.OPENAI_API_KEY } : {}),
      baseUrl: parsed.OPENAI_REALTIME_BASE_URL,
      model: parsed.OPENAI_REALTIME_MODEL,
      voice: parsed.OPENAI_REALTIME_VOICE,
      reasoningEffort: parsed.OPENAI_REALTIME_REASONING_EFFORT,
      turnDetection: parsed.OPENAI_REALTIME_TURN_DETECTION,
      inputAudioFormat: parsed.OPENAI_REALTIME_INPUT_AUDIO_FORMAT,
      outputAudioFormat: parsed.OPENAI_REALTIME_OUTPUT_AUDIO_FORMAT,
      ...(parsed.OPENAI_REALTIME_INPUT_TRANSCRIPTION_MODEL === "disabled"
        ? {}
        : { inputTranscriptionModel: parsed.OPENAI_REALTIME_INPUT_TRANSCRIPTION_MODEL }),
      ...(parsed.OPENAI_REALTIME_INPUT_TRANSCRIPTION_LANGUAGE
        ? { inputTranscriptionLanguage: parsed.OPENAI_REALTIME_INPUT_TRANSCRIPTION_LANGUAGE }
        : {}),
    },
    vad: {
      engine: parsed.HERMES_LIVE_VAD,
      ...(parsed.HERMES_LIVE_VAD_MODEL ? { modelPath: parsed.HERMES_LIVE_VAD_MODEL } : {}),
      startProbability: parsed.HERMES_LIVE_VAD_START_PROBABILITY,
      stopProbability: parsed.HERMES_LIVE_VAD_STOP_PROBABILITY,
      startSustainMs: parsed.HERMES_LIVE_VAD_START_SUSTAIN_MS,
      stopSustainMs: parsed.HERMES_LIVE_VAD_STOP_SUSTAIN_MS,
      echoStartProbability: parsed.HERMES_LIVE_VAD_ECHO_START_PROBABILITY,
      echoStartSustainMs: parsed.HERMES_LIVE_VAD_ECHO_START_SUSTAIN_MS,
      prerollMs: parsed.HERMES_LIVE_VAD_PREROLL_MS,
      tailMs: parsed.HERMES_LIVE_VAD_TAIL_MS,
      halfDuplex: parsed.HERMES_LIVE_HALF_DUPLEX !== undefined
        && ["1", "true", "yes", "on"].includes(parsed.HERMES_LIVE_HALF_DUPLEX),
      turnTailMs: parsed.HERMES_LIVE_TURN_TAIL_MS,
    },
    filler: {
      enabled: parsed.HERMES_LIVE_FILLER_ENABLED === undefined
        || ["1", "true", "yes", "on"].includes(parsed.HERMES_LIVE_FILLER_ENABLED),
      delayMs: parsed.HERMES_LIVE_FILLER_DELAY_MS,
      intervalMs: parsed.HERMES_LIVE_FILLER_INTERVAL_MS,
      maxPerTool: parsed.HERMES_LIVE_FILLER_MAX_PER_TOOL,
      ...(parsed.HERMES_LIVE_FILLER_DIR ? { directory: parsed.HERMES_LIVE_FILLER_DIR } : {}),
    },
    context: {
      hermesHome: parsed.HERMES_LIVE_HERMES_HOME ?? join(homedir(), ".hermes"),
      digestEnabled: parseBool(parsed.HERMES_LIVE_CONTEXT_DIGEST ?? "true"),
      voiceThreadTitle: parsed.HERMES_LIVE_VOICE_THREAD_TITLE,
      recallSessionTitle: parsed.HERMES_LIVE_RECALL_SESSION_TITLE,
      recallTimeoutMs: parsed.HERMES_LIVE_RECALL_TIMEOUT_MS,
    },
    vadRecording: {
      enabled: parsed.HERMES_LIVE_VAD_RECORDING !== undefined
        && ["1", "true", "yes", "on"].includes(parsed.HERMES_LIVE_VAD_RECORDING),
      directory: join(dirname(parsed.HERMES_LIVE_TASK_STATE_FILE), "vad-recordings"),
      maxTotalBytes: parsed.HERMES_LIVE_VAD_RECORDING_MAX_MB * 1024 * 1024,
      retentionMs: parsed.HERMES_LIVE_VAD_RECORDING_RETENTION_DAYS * 86_400_000,
    },
    knowledge: {
      enabled: parsed.HERMES_LIVE_KNOWLEDGE_INDEX === undefined
        || ["1", "true", "yes", "on"].includes(parsed.HERMES_LIVE_KNOWLEDGE_INDEX),
      turnContext: parsed.HERMES_LIVE_KNOWLEDGE_TURN_CONTEXT !== undefined
        && ["1", "true", "yes", "on"].includes(parsed.HERMES_LIVE_KNOWLEDGE_TURN_CONTEXT),
      path: join(dirname(parsed.HERMES_LIVE_TASK_STATE_FILE), "knowledge-v1.sqlite"),
      reflection: parsed.HERMES_LIVE_KNOWLEDGE_REFLECTION !== undefined
        && ["1", "true", "yes", "on"].includes(parsed.HERMES_LIVE_KNOWLEDGE_REFLECTION),
    },
  };
}

export function assertRuntimeConfig(config: AppConfig): void {
  assertHermesApiConfig(config);
  assertGatewayExposureConfig(config);
  assertRealtimeProviderConfig(config);
}

export function assertHermesApiConfig(config: Pick<AppConfig, "hermes">): void {
  if (!config.hermes.apiKey) {
    throw new Error("Set HERMES_AGENT_API_SERVER_KEY to Hermes Agent's API_SERVER_KEY.");
  }
}

export function assertGatewayExposureConfig(config: Pick<AppConfig, "server">): void {
  if (!config.server.authToken && isNetworkAccessibleHost(config.server.host) && !config.server.allowUnauthenticated) {
    throw new Error(
      "HERMES_LIVE_AUTH_TOKEN is required when HERMES_LIVE_HOST is network-accessible. " +
        "Set HERMES_LIVE_ALLOW_UNAUTHENTICATED=true only for an isolated trusted network.",
    );
  }
  if (config.server.authToken && isNetworkAccessibleHost(config.server.host) && config.server.authToken.length < 16) {
    throw new Error("HERMES_LIVE_AUTH_TOKEN must be at least 16 characters when HERMES_LIVE_HOST is network-accessible.");
  }
}

export function assertRealtimeProviderConfig(config: Pick<AppConfig, "realtime" | "local" | "riva" | "gemini" | "openai">): void {
  if (config.realtime.provider === "local") {
    const endpoint = new URL(config.local.url);
    if (!isLoopbackHostname(endpoint.hostname) && !config.local.allowRemote) {
      throw new Error(
        "HERMES_LIVE_LOCAL_URL must use localhost by default. Set HERMES_LIVE_LOCAL_ALLOW_REMOTE=true only for a trusted Hugging Face speech-to-speech endpoint.",
      );
    }
    if (
      !isLoopbackHostname(endpoint.hostname)
      && endpoint.protocol !== "wss:"
      && !isPrivateNetworkHostname(endpoint.hostname)
    ) {
      throw new Error("A public remote HERMES_LIVE_LOCAL_URL must use wss://.");
    }
    return;
  }
  if (config.realtime.provider === "riva") {
    for (const [endpoint, intent] of [
      [config.riva.asrUrl, "transcription"],
      [config.riva.ttsUrl, "synthesize"],
    ]) {
      const url = new URL(endpoint);
      if (url.pathname !== "/v1/realtime" || url.searchParams.get("intent") !== intent || [...url.searchParams.keys()].length !== 1) {
        throw new Error(`Riva ${intent} URL must use /v1/realtime?intent=${intent}.`);
      }
      if (!isLoopbackHostname(url.hostname) && url.protocol !== "wss:") {
        throw new Error("Remote Riva realtime endpoints must use wss://.");
      }
    }
    return;
  }
  if (config.realtime.provider === "gemini" && config.gemini.enterprise && !config.gemini.project) {
    throw new Error("GOOGLE_CLOUD_PROJECT is required when GOOGLE_GENAI_USE_ENTERPRISE=true.");
  }
  if (realtimeProviderConfigured(config)) {
    return;
  }
  if (config.realtime.provider === "openai") {
    throw new Error("Set OPENAI_API_KEY or use HERMES_LIVE_PROVIDER=mock for local text-only development.");
  }
  if (config.realtime.provider === "gemini" && !config.gemini.enterprise && !config.gemini.apiKey) {
    throw new Error(
      "Set GEMINI_API_KEY or GOOGLE_API_KEY, enable GOOGLE_GENAI_USE_ENTERPRISE=true, or use HERMES_LIVE_PROVIDER=mock for local text-only development.",
    );
  }
}

export function realtimeProviderConfigured(config: Pick<AppConfig, "realtime" | "local" | "riva" | "gemini" | "openai">): boolean {
  if (config.realtime.provider === "local") {
    return true;
  }
  if (config.realtime.provider === "riva") {
    return true;
  }
  if (config.realtime.provider === "mock") {
    return true;
  }
  if (config.realtime.provider === "openai") {
    return Boolean(config.openai.apiKey);
  }
  if (config.gemini.enterprise) {
    return Boolean(config.gemini.project);
  }
  return Boolean(config.gemini.apiKey);
}

export function sanitizeSessionComponent(value: string): string {
  const sanitized: string[] = [];
  let replacingUnsafeRun = false;

  for (const character of value.trim().toLowerCase()) {
    if (isSafeSessionCharacter(character)) {
      sanitized.push(character);
      replacingUnsafeRun = false;
    } else if (!replacingUnsafeRun) {
      sanitized.push("-");
      replacingUnsafeRun = true;
    }
  }

  let start = 0;
  let end = sanitized.length;
  while (start < end && sanitized[start] === "-") {
    start += 1;
  }
  while (end > start && sanitized[end - 1] === "-") {
    end -= 1;
  }

  return sanitized.slice(start, Math.min(end, start + 80)).join("");
}

function isSafeSessionCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return (
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    character === "." ||
    character === "_" ||
    character === ":" ||
    character === "-"
  );
}

export function makeSessionKey(prefix: string, profileId: string, userLabel: string): string {
  const safeProfile = sanitizeSessionComponent(profileId || "default") || "default";
  const safeUser = sanitizeSessionComponent(userLabel || "anonymous") || "anonymous";
  return `${prefix}:profile:${safeProfile}:user:${safeUser}`.slice(0, 256);
}

function parseBool(value: string | undefined): boolean {
  return value ? ["1", "true", "yes", "on"].includes(value.trim().toLowerCase()) : false;
}

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function isSafeHermesBaseUrl(value: string): boolean {
  const parsed = parseSafeConfiguredUrl(value);
  return Boolean(
    parsed &&
    ["http:", "https:"].includes(parsed.protocol) &&
    parsed.pathname === "/" &&
    !value.includes("?") &&
    !value.includes("#")
  );
}

function isSafeHttpLocalUrl(value: string): boolean {
  const parsed = parseSafeConfiguredUrl(value);
  return Boolean(
    parsed &&
    ["http:", "https:"].includes(parsed.protocol) &&
    (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]" || parsed.hostname === "::1") &&
    !value.includes("?") &&
    !value.includes("#"),
  );
}

function isSafeOpenAIRealtimeBaseUrl(value: string): boolean {
  return isSafeRealtimeWebSocketUrl(value);
}

function isSafeRealtimeWebSocketUrl(value: string): boolean {
  const parsed = parseSafeConfiguredUrl(value);
  return Boolean(
    parsed &&
    ["ws:", "wss:"].includes(parsed.protocol) &&
    !value.includes("#")
  );
}

export function isSafeGoogleCloudProject(value: string): boolean {
  return /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(value);
}

export function isSafeGoogleCloudLocation(value: string): boolean {
  return value.length <= 63 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);
}

export function isSafeGoogleGenAiApiVersion(value: string): boolean {
  return value.length <= 32 && /^v[1-9][0-9]*(?:(?:alpha|beta)[0-9]*)?$/u.test(value);
}

function parseSafeConfiguredUrl(value: string): URL | undefined {
  if (
    !value ||
    value.length > MAX_OUTBOUND_BASE_URL_CHARS ||
    value !== value.trim() ||
    /[\\\u0000-\u001f\u007f\s]/u.test(value)
  ) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    return parsed.username || parsed.password || !parsed.hostname ? undefined : parsed;
  } catch {
    return undefined;
  }
}

export function publicBaseUrl(value: string): string {
  if (
    !value ||
    value.length > MAX_OUTBOUND_BASE_URL_CHARS ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return "[invalid-url]";
  }
  try {
    const parsed = new URL(value);
    const origin = `${parsed.protocol}//${parsed.host}`;
    if (!parsed.hostname || origin.length > 512) return "[invalid-url]";
    const path = parsed.pathname === "/" ? "" : "/[redacted-path]";
    const query = value.includes("?") ? "?[redacted]" : "";
    return `${origin}${path}${query}`;
  } catch {
    return "[invalid-url]";
  }
}

function selectedRealtimeModel(provider: RealtimeProvider, geminiModel: string, openaiModel: string): string {
  if (provider === "local") {
    return "huggingface/speech-to-speech";
  }
  if (provider === "riva") {
    return "nvidia/speech-nim";
  }
  if (provider === "openai") {
    return openaiModel;
  }
  if (provider === "mock") {
    return "mock-live";
  }
  return geminiModel;
}

function isNetworkAccessibleHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return !["127.0.0.1", "localhost", "::1", "[::1]"].includes(normalized);
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(normalized);
}

function isPrivateNetworkHostname(hostname: string): boolean {
  const value = hostname.trim().toLowerCase().replace(/^\[(.*)\]$/u, "$1");
  if (value === "host.docker.internal" || value.endsWith(".internal") || value.endsWith(".local")) return true;
  if (!value.includes(".") && !value.includes(":")) return true;
  const ipv4 = value.split(".").map(Number);
  if (ipv4.length === 4 && ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    return ipv4[0] === 10
      || (ipv4[0] === 172 && (ipv4[1] ?? 0) >= 16 && (ipv4[1] ?? 0) <= 31)
      || (ipv4[0] === 192 && ipv4[1] === 168)
      || (ipv4[0] === 169 && ipv4[1] === 254);
  }
  return value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe80:");
}
