import { createHash, randomUUID } from "node:crypto";
import { errorToMessage } from "../../domain/error-message.js";
import { isPcmMimeType, requirePcmSampleRate } from "../../domain/audio/pcm.js";
import { makeSessionKey, type AppConfig } from "../../config.js";
import type { Logger } from "../../logger.js";
import {
  parseClientMessage,
  RequestIdSchema,
  type ClientMessage,
  type RealtimeResponseTruncation,
} from "../../domain/protocol/client-protocol.js";
import {
  serverMessage,
  type PublicConversation,
  type PublicTaskSnapshot,
  type ServerMessage,
} from "../../domain/protocol/server-protocol.js";
import {
  incompatibleProtocolVersionMessage,
  isHermesLiveProtocolVersion,
  type HermesLiveProtocolVersion,
} from "../../domain/protocol/version.js";
import type { TaskExecutionMode, TaskRecord } from "../../domain/tasks/index.js";
import { realtimeClientCapabilities } from "./client-capabilities.js";
import type { ClientConnectionPort, ClientInboundFrame } from "./ports/client-connection.port.js";
import type {
  HermesRunsPort,
  HermesSessionChatResult,
  HermesSessionSummary,
} from "./ports/hermes-runs.port.js";
import type { TaskSupervisorPort } from "./ports/task-supervisor.port.js";
import {
  type LiveModelEvent,
  type LiveToolCall,
  type LiveToolName,
  type LiveModelAdapter,
  type LiveModelSession,
} from "./ports/realtime-model.port.js";
import { buildSystemInstruction } from "./system-instruction.js";
import { buildContextDigest } from "./context-digest.js";
import { SpeechTimingTracker, type SpeechTimingMetrics } from "./speech-timing.js";
import { FillerSpeaker, type FillerEmit } from "./filler-speaker.js";
import { deferredAnswerSpeech } from "./deferred-answer-speech.js";
import { SpeechMux } from "./speech-mux.js";
import type { SpeechSink } from "./ports/speech-sink.port.js";
import type { SpeechDetectionService } from "./vad/detection-service.js";
import type { SpeechGate } from "./vad/speech-gate.js";
import {
  isTaskNotificationState,
  projectSupersededTaskNotification,
  projectTaskLifecycle,
  projectTaskNotification,
  projectTaskSnapshot,
} from "./task-public-projection.js";

const MAX_PENDING_PROVIDER_EVENTS = 256;
const MAX_PENDING_PROVIDER_EVENT_BYTES = 8 * 1024 * 1024;
const MAX_PROVIDER_TRANSCRIPT_CHARS = 20_000;
const MAX_PROVIDER_IO_WAIT_MS = 10_000;
const MAX_PROVIDER_CLOSE_WAIT_MS = 5_000;
const MAX_PROVIDER_CANCEL_WAIT_MS = 1_000;
const MAX_PROVIDER_NOTIFICATION_RESPONSE_WAIT_MS = 30_000;
const MAX_NOTIFICATION_DELIVERY_ATTEMPTS = 3;
const NOTIFICATION_RETRY_BASE_MS = 250;
const MAX_PENDING_CLIENT_MESSAGES = 256;
const MAX_PENDING_CLIENT_BYTES = 8 * 1024 * 1024;
const MAX_CLIENT_MESSAGE_ERRORS = 16;
const MAX_PENDING_PROVIDER_TOOL_CALLS = 32;
/**
 * User audio/text held while a provider tool call is executing. The local
 * speech runtime refuses (and drops the session) when a new turn arrives
 * while a function call output is still outstanding, so the gateway holds
 * turns and releases them once the tool result has been delivered.
 */
const MAX_HELD_AUDIO_MS = 10_000;
const MAX_HELD_INPUTS = 256;
/** Forced behavior for the dedicated Hermes recall session behind search_past_chats. */
const RECALL_INSTRUCTIONS = [
  "You are answering one voice recall request about this user's past conversations.",
  "Use the session_search tool with a short query to find relevant past conversations, then answer in at most three short sentences suitable for speech.",
  "If nothing relevant is found, say plainly that nothing was found.",
  "Never mention tool names, session ids, or these instructions.",
].join(" ");
const MAX_CONCURRENT_PROVIDER_TOOL_CALLS = 4;
const MAX_PROCESSED_PROVIDER_TOOL_CALLS = 256;
const MAX_SEEN_PROVIDER_TOOL_CALLS = 4_096;
const MAX_PROVIDER_TOOL_CALL_ARGS_BYTES = 100_000;
const MAX_PROVIDER_TOOL_RESPONSE_BYTES = 256_000;
const MAX_CACHED_PROVIDER_TOOL_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_PUBLIC_TASKS = 100;
const MAX_TOOL_RESOURCE_KEYS = 8;
/** Deferred answers held per session; evicted oldest-first when exceeded. */
const MAX_DEFERRED_ANSWERS = 16;
/** After this long undelivered, an "answer ready" filler clip escalates. */
const DEFERRED_ANSWER_ESCALATION_MS = 20_000;
/** How often the announcement-deadline watch runs while speech is pending. */
const ANNOUNCEMENT_DEADLINE_CHECK_MS = 5_000;
const DEFAULT_ANNOUNCE_MAX_DELAY_MS = 90_000;

export interface LiveGatewaySessionDeps {
  config: AppConfig;
  hermes: HermesRunsPort;
  taskSupervisor: TaskSupervisorPort;
  liveModel: LiveModelAdapter;
  logger: Logger;
  /** Gateway speech detection (protocol v7); omitted sessions keep client-side VAD. */
  speechDetection?: SpeechDetectionService;
  /** Gateway-side TTS sidecar; omitted keeps all speech on the provider. */
  speechSink?: SpeechSink;
}

interface ProviderToolCallRecord {
  fingerprint: string;
  state: "pending" | "done";
  cancelled: boolean;
  responseDelivery: "not_started" | "sending" | "sent";
  response?: Record<string, unknown>;
  responseBytes?: number;
}

/**
 * A Hermes chat turn accepted with an instant spoken receipt whose real
 * answer arrives later through the idle-gated exact-speech channel.
 */
interface DeferredAnswerRecord {
  pendingId: string;
  kind: "conversation" | "recall";
  startedAt: number;
  readyAt?: number;
  speech?: string;
  delivered: boolean;
  /** Un-spoken tail of the streamed answer (sidecar sentence pumping). */
  deltaBuffer?: string;
  /** Characters of the final answer already spoken through the sidecar. */
  streamedChars?: number;
}

type HeldSessionInput =
  | { kind: "audio"; data: string; mimeType: string; preGated?: boolean }
  | { kind: "audio_end" }
  | { kind: "text"; text: string };

export class LiveGatewaySession {
  private readonly id = `live_${randomUUID().replaceAll("-", "")}`;
  private readonly notificationToken = randomUUID().replaceAll("-", "");
  private readonly abort = new AbortController();
  private liveSession?: LiveModelSession;
  private pendingLiveConnect?: Promise<LiveModelSession>;
  private starting = false;
  private readySent = false;
  private closing = false;
  private closePromise?: Promise<void>;
  /**
   * Gateway↔provider (s2s) link state, surfaced through GET /status.json so a
   * reconnecting browser can tell "gateway down" from "voice pipeline down".
   */
  private providerLink: {
    state: "starting" | "attached" | "detached";
    attachedAt?: number;
    detachedAt?: number;
    lastDetach?: { code?: number; reason: string; at: number };
  } = { state: "detached" };
  private sessionKey?: string;
  private ownerId?: string;
  private profileId = "default";
  private userLabel = "anonymous";
  private protocolVersion: HermesLiveProtocolVersion = 3;
  private conversation: PublicConversation = { mode: "unbound" };
  private conversationOperation: Promise<void> = Promise.resolve();
  private unsubscribeTasks?: () => void;
  private readonly pendingTaskRecords = new Map<string, TaskRecord>();
  private readonly pendingNotifications = new Map<string, TaskRecord>();
  private readonly claimedNotifications = new Map<string, TaskRecord>();
  private readonly notificationDeliveryAttempts = new Map<string, number>();
  private notificationFlushRunning = false;
  private notificationRetryTimer?: ReturnType<typeof setTimeout>;
  private announcementDeadlineTimer?: ReturnType<typeof setInterval>;
  private notificationResponsePending = false;
  private notificationResponseTimer?: ReturnType<typeof setTimeout>;
  private providerResponseActive = false;
  private providerTurnResponseExpected = false;
  private userSpeaking = false;
  private speechGate?: SpeechGate;
  private recallSessionId?: string;
  private heldInputs: HeldSessionInput[] = [];
  private heldAudioMs = 0;
  private heldInputFlushQueued = false;
  private messageQueue: Promise<void> = Promise.resolve();
  private pendingClientMessages = 0;
  private pendingClientBytes = 0;
  private clientInputOverflowed = false;
  private clientMessageErrors = 0;
  private readonly providerToolCalls = new Map<string, ProviderToolCallRecord>();
  private readonly providerToolCallTombstones = new Map<string, string>();
  private readonly providerToolOperations: Array<() => Promise<void>> = [];
  private activeProviderToolOperations = 0;
  private pendingProviderToolCalls = 0;
  private cachedProviderToolResponseBytes = 0;
  // Audio-delivery telemetry for the /v1/metrics diagnostics endpoint.
  private lastAudioOutputAt = 0;
  private lastAudioSendAt = 0;
  private readonly audioGapSamples = new Float32Array(128);
  private audioGapLength = 0;
  private audioGapNext = 0;
  // Speech-wait telemetry: tool call → first speech, announcement delivery lag.
  private readonly speechTiming = new SpeechTimingTracker();
  // Filler side-channel: pre-recorded clips spoken during slow tool waits.
  private filler?: FillerSpeaker;
  /** Filler sequences armed by a provider error skip the tool-pending gate. */
  private fillerSequenceForProvider = false;
  // Gateway-side TTS sidecar: speech without the provider LLM (Phase 4).
  private speechMux?: SpeechMux;
  // Deferred Hermes answers (async tools): receipt now, speech when ready.
  private readonly deferredAnswers = new Map<string, DeferredAnswerRecord>();
  private deferredAnswerEscalationTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly client: ClientConnectionPort,
    private readonly deps: LiveGatewaySessionDeps,
  ) {}

  bind(): void {
    this.client.onMessage((frame) => this.enqueueClientFrame(frame));
    this.client.onClose(() => {
      void this.close();
    });
    this.client.onError((error) => {
      this.deps.logger.warn("client connection error", { sessionId: this.id, error: errorToMessage(error) });
    });
  }

  async start(message: Extract<ClientMessage, { type: "session.start" }>): Promise<void> {
    if (!isHermesLiveProtocolVersion(message.protocolVersion)) {
      this.fail(
        "unsupported_protocol_version",
        new Error(incompatibleProtocolVersionMessage(message.protocolVersion)),
        false,
        message.id,
      );
      return;
    }
    if (this.liveSession || this.starting || this.readySent) {
      this.fail("session_already_started", new Error("Realtime session is already started."), true, message.id);
      return;
    }
    if (this.deps.config.realtime.provider === "local" && message.protocolVersion < 5) {
      this.fail(
        "unsupported_protocol_version",
        new Error("The Hugging Face local voice provider requires Hermes Live protocol v5. Upgrade the client and reconnect."),
        false,
        message.id,
      );
      return;
    }

    this.starting = true;
    let startupPhase: "hermes" | "realtime" = "hermes";
    let connected: LiveModelSession | undefined;
    let unsubscribe: (() => void) | undefined;
    try {
      this.protocolVersion = message.protocolVersion;
      this.profileId = this.deps.config.server.trustClientIdentity
        ? message.profileId ?? this.deps.config.server.defaultProfileId
        : this.deps.config.server.defaultProfileId;
      this.userLabel = this.deps.config.server.trustClientIdentity
        ? message.userLabel ?? this.deps.config.server.defaultUserLabel
        : this.deps.config.server.defaultUserLabel;
      this.sessionKey = makeSessionKey(this.deps.config.server.sessionPrefix, this.profileId, this.userLabel);
      this.ownerId = this.deps.taskSupervisor.registerOwner(this.sessionKey, this.sessionKey);
      unsubscribe = this.deps.taskSupervisor.subscribe(this.ownerId, (record) => this.receiveTaskRecord(record));
      this.unsubscribeTasks = unsubscribe;

      if (this.deps.config.filler.enabled) {
        this.filler = new FillerSpeaker({
          emit: (message) => this.emitFillerSpeech(message),
          gate: () => this.fillerSpeechAllowed(),
          onInjection: () => this.speechTiming.noteFillerInjection(),
          onUnavailable: (error) => this.deps.logger.warn("filler clip library unavailable", {
            sessionId: this.id,
            error: errorToMessage(error),
          }),
          delayMs: this.deps.config.filler.delayMs,
          intervalMs: this.deps.config.filler.intervalMs,
          maxPerSequence: this.deps.config.filler.maxPerTool,
          ...(this.deps.config.filler.directory ? { directory: this.deps.config.filler.directory } : {}),
        });
      }

      // TTS sidecar (local provider only: it speaks the same 24 kHz PCM the
      // realtime boundary publishes). Unset HERMES_LIVE_TTS_URL keeps all
      // speech on the provider exact-speech path.
      if (this.deps.speechSink && this.deps.config.realtime.provider === "local") {
        this.speechMux = new SpeechMux({
          client: this.deps.speechSink,
          emit: (message) => this.emitFillerSpeech(message),
          gate: () => this.fillerSpeechAllowed(),
          onSpeakingChange: (speaking) => {
            this.speechGate?.setDownlinkActive(speaking || this.downlinkActiveForGate());
          },
          onUnavailable: (error) => this.deps.logger.warn("tts sidecar unavailable; falling back to provider speech", {
            sessionId: this.id,
            error,
          }),
        });
      }

      // Speech detection loads its model in parallel with provider connect so
      // the session-ready handshake stays bounded by the provider, not the VAD.
      const speechGateReady = this.protocolVersion >= 7
        && this.deps.config.vad.engine !== "disabled"
        && this.deps.speechDetection
        ? this.deps.speechDetection.createGate({
          streamThrough: this.deps.config.openai.turnDetection === "semantic_vad",
          onSpeechExpired: () => this.handleConfirmedSpeechStopped(),
        }).catch((error: unknown) => {
          this.deps.logger.warn("gateway speech detection unavailable, using client VAD", {
            sessionId: this.id,
            error: errorToMessage(error),
          });
          return undefined;
        })
        : undefined;

      const capabilities = await this.deps.hermes.assertRunsSupported(this.abort.signal);
      // The digest and conversation resolution are independent; both must be
      // ready before the provider connect builds the system instruction.
      const digestReady = buildContextDigest({
        config: this.deps.config,
        hermes: this.deps.hermes,
        logger: this.deps.logger,
        capabilities,
        signal: this.abort.signal,
        compact: this.deps.config.realtime.provider === "local",
      });
      const conversationReady = this.protocolVersion >= 4
        ? this.resolveConversation(message.conversation ?? { mode: "unbound" })
        : Promise.resolve();
      const [digest] = await Promise.all([digestReady, conversationReady]);
      if (this.protocolVersion >= 4) {
        this.conversation = await conversationReady as PublicConversation;
      }
      startupPhase = "realtime";
      const providerEvents: LiveModelEvent[] = [];
      let providerEventBytes = 0;
      let providerOpened = false;
      let resolveOpen!: () => void;
      let rejectOpen!: (error: Error) => void;
      const providerOpen = new Promise<void>((resolve, reject) => {
        resolveOpen = resolve;
        rejectOpen = reject;
      });
      // Some adapters reject connect and report the same pre-ready failure
      // through callbacks. The connect path is awaited below, while this
      // readiness latch may otherwise reject first and become an unhandled
      // promise before startup cleanup can attach its await.
      void providerOpen.catch(() => undefined);

      const availableTools = this.availableProviderTools();
      this.providerLink = { state: "starting", lastDetach: this.providerLink.lastDetach };
      const connect = this.deps.liveModel.connect({
        sessionId: this.id,
        systemInstruction: [
          buildSystemInstruction(
            this.notificationToken,
            this.deps.config.tasks.trustDeclaredReadOnly === true,
            {
              bound: this.conversation.mode !== "unbound",
              voiceInputPause: this.protocolVersion >= 6,
              clientAudioControl: this.protocolVersion >= 9,
            },
            this.deps.config.realtime.provider === "local",
            {
              searchPastChats: availableTools.includes("search_past_chats"),
              remember: availableTools.includes("remember"),
              deferredAnswers: this.deps.config.hermes.asyncTools !== false,
            },
          ),
          ...(this.deps.config.hermes.instructions
            ? [`Personal context and behavior instructions (operator configured):\n${this.deps.config.hermes.instructions}`]
            : []),
          ...(digest.text ? [digest.text] : []),
        ].join("\n\n"),
        availableTools,
        safetyIdentifier: safetyIdentifierForSessionKey(this.sessionKey),
        callbacks: {
          onOpen: () => {
            providerOpened = true;
            this.providerLink = {
              state: "attached",
              attachedAt: Date.now(),
              lastDetach: this.providerLink.lastDetach,
            };
            this.deps.logger.info("realtime provider attached", {
              sessionId: this.id,
              provider: this.deps.config.realtime.provider,
              model: this.deps.config.realtime.model,
            });
            resolveOpen();
          },
          onClose: (event) => {
            this.providerLink = {
              state: "detached",
              attachedAt: this.providerLink.attachedAt,
              detachedAt: Date.now(),
              lastDetach: {
                ...(typeof (event as { code?: unknown })?.code === "number"
                  ? { code: (event as { code: number }).code }
                  : {}),
                reason: boundedText(String((event as { reason?: unknown })?.reason ?? ""), 200),
                at: Date.now(),
              },
            };
            if (!this.readySent) {
              rejectOpen(new Error("Realtime provider session closed before ready."));
              return;
            }
            this.deps.logger.info("realtime provider session closed", {
              sessionId: this.id,
              ...providerCloseLogDetail(event),
            });
            if (this.closing) return;
            this.fail("realtime_provider_closed", new Error("Realtime provider session closed."), true);
            void this.closeClientAfterCleanup(1011, "realtime provider closed");
          },
          onError: (error) => {
            if (!this.readySent) {
              rejectOpen(new Error(publicRealtimeStartupError(error, this.deps.config.server.providerReadyTimeoutMs)));
              return;
            }
            this.deps.logger.warn("realtime provider reported an error", {
              sessionId: this.id,
              error: "realtime_provider_error",
            });
            if (!this.closing) {
              // Recoverable provider error: the session stays alive, so cover
              // the silent gap with a clip instead of dead air.
              this.fillerSequenceForProvider = true;
              this.filler?.beginSequence();
              this.fail("realtime_provider_error", new Error("Realtime provider reported an error."), true);
            }
          },
          onEvent: (event) => {
            if (this.closing) return;
            if (!this.readySent) {
              const bytes = safeJsonByteLength(event);
              if (
                providerEvents.length >= MAX_PENDING_PROVIDER_EVENTS ||
                !Number.isFinite(bytes) ||
                bytes > MAX_PENDING_PROVIDER_EVENT_BYTES - providerEventBytes
              ) {
                rejectOpen(new Error("Realtime provider exceeded the safe pre-ready event queue limit."));
                return;
              }
              providerEvents.push(event);
              providerEventBytes += bytes;
              return;
            }
            this.dispatchLiveModelEvent(event);
          },
        },
      });
      this.pendingLiveConnect = connect;
      void connect.catch(() => undefined);
      connected = await withDeadline(
        connect,
        this.deps.config.server.providerReadyTimeoutMs,
        `Realtime provider did not connect within ${this.deps.config.server.providerReadyTimeoutMs}ms.`,
      );
      if (this.pendingLiveConnect === connect) this.pendingLiveConnect = undefined;
      this.liveSession = connected;
      if (!providerOpened) {
        await withDeadline(
          providerOpen,
          this.deps.config.server.providerReadyTimeoutMs,
          `Realtime provider did not become ready within ${this.deps.config.server.providerReadyTimeoutMs}ms.`,
        );
      }
      if (this.closing) {
        await this.closeProvider(connected);
        return;
      }

      // Recent history is intentionally bounded for the public inbox, but
      // active work and unread notifications are correctness-critical. Load
      // those independently so neither can disappear behind newer terminal
      // history, then de-duplicate and project the union in bounded frames.
      const [recentWindow, activeTasks, unreadTasks] = await Promise.all([
        this.deps.taskSupervisor.list(this.ownerId, MAX_PUBLIC_TASKS + 1),
        this.deps.taskSupervisor.listActive(this.ownerId),
        this.deps.taskSupervisor.listUnreadNotifications(this.ownerId),
      ]);
      this.speechGate = speechGateReady ? await speechGateReady : undefined;
      const initialTasks = mergeTaskRecords([
        ...activeTasks,
        ...unreadTasks,
        ...recentWindow.slice(0, MAX_PUBLIC_TASKS),
      ]);
      const projectedInitialTasks = projectTaskList(initialTasks);
      const initialSnapshotTruncated = recentWindow.length > MAX_PUBLIC_TASKS
        || projectedInitialTasks.length > MAX_PUBLIC_TASKS;
      this.send({
        type: "session.ready",
        protocolVersion: this.protocolVersion,
        ...(message.id ? { requestId: message.id } : {}),
        sessionId: this.id,
        model: this.deps.config.realtime.model,
        hermes: publicHermesCapabilities(capabilities),
        realtime: realtimeClientCapabilities(this.deps.config, {
          gatewaySpeechDetection: this.speechGate !== undefined,
        }),
        tasks: {
          scope: "owner",
          sequence: "per_task",
          reconnect: "snapshot",
          durable: true,
          parallel:
            this.deps.config.tasks.maxConcurrent > 1
            && this.deps.config.tasks.trustDeclaredReadOnly === true,
          maxConcurrent: this.deps.config.tasks.maxConcurrent,
          maxRetained: this.deps.config.tasks.historyLimit,
          supports: {
            list: true,
            get: true,
            stop: true,
            followUp: this.protocolVersion >= 4 && this.deps.taskSupervisor.followUp !== undefined,
            resume: false,
            notificationAck: true,
          },
        },
        ...(this.protocolVersion >= 4 ? { conversation: this.conversation } : {}),
      });
      const initialSnapshotReason = initialTasks.length > 0 ? "reconnect" : "initial";
      if (projectedInitialTasks.length === 0) {
        this.send({
          type: "task.snapshot",
          reason: initialSnapshotReason,
          tasks: [],
          truncated: false,
        });
      } else {
        for (let offset = 0; offset < projectedInitialTasks.length; offset += MAX_PUBLIC_TASKS) {
          this.send({
            type: "task.snapshot",
            reason: initialSnapshotReason,
            tasks: projectedInitialTasks.slice(offset, offset + MAX_PUBLIC_TASKS),
            // `truncated` describes the bounded recent-history view, not a
            // pagination cursor. Active and unread records are still emitted
            // across every bounded reconnect frame.
            truncated: initialSnapshotTruncated,
          });
        }
      }
      this.readySent = true;
      this.armAnnouncementDeadlineWatch();
      const initialTaskSequences = new Map(initialTasks.map((record) => [record.taskId, record.sequence]));
      for (const record of unreadTasks) {
        const notification = projectTaskNotification(record);
        if (!record.notification.unread || !notification) continue;
        this.send({
          type: "task.notification",
          taskId: record.taskId,
          sequence: record.sequence,
          occurredAt: record.updatedAt,
          notification,
        });
        // Client inbox delivery and provider speech have independent durable
        // state. Re-project every unread item on reconnect, but never enqueue
        // one that has already been announced for speech again.
        if (record.notification.announcedAt === undefined) {
          this.pendingNotifications.set(record.taskId, structuredClone(record));
          this.speechTiming.noteAnnouncementPending(record.taskId, Date.now());
        }
      }
      for (const record of this.pendingTaskRecords.values()) {
        if (record.sequence > (initialTaskSequences.get(record.taskId) ?? 0)) this.dispatchTaskRecord(record);
      }
      this.pendingTaskRecords.clear();
      for (const event of providerEvents) this.dispatchLiveModelEvent(event);
      this.scheduleNotificationFlush();
    } catch (error) {
      if (this.pendingLiveConnect) {
        const lateConnect = this.pendingLiveConnect;
        this.pendingLiveConnect = undefined;
        void lateConnect.then((session) => this.closeProvider(session)).catch(() => undefined);
      }
      if (connected) await this.closeProvider(connected).catch(() => undefined);
      if (this.liveSession === connected) this.liveSession = undefined;
      if (unsubscribe && this.unsubscribeTasks === unsubscribe) {
        unsubscribe();
        this.unsubscribeTasks = undefined;
      }
      if (!this.closing) {
        this.deps.logger.warn("live session startup failed", {
          sessionId: this.id,
          phase: startupPhase,
          ...startupFailureLogDetail(error),
        });
        this.fail(
          "session_start_failed",
          new Error(
            startupPhase === "hermes"
              ? "Hermes Agent is not ready for background tasks. Check the authenticated /ready endpoint and gateway logs."
              : publicRealtimeStartupError(error, this.deps.config.server.providerReadyTimeoutMs),
          ),
          true,
          message.id,
        );
      }
    } finally {
      this.starting = false;
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.performClose();
    return this.closePromise;
  }

  private enqueueClientFrame(frame: ClientInboundFrame): void {
    if (this.closing || this.clientInputOverflowed) return;
    const bytes = clientInboundFrameBytes(frame);
    if (
      this.pendingClientMessages >= MAX_PENDING_CLIENT_MESSAGES ||
      this.pendingClientBytes + bytes > MAX_PENDING_CLIENT_BYTES
    ) {
      this.clientInputOverflowed = true;
      this.fail(
        "client_input_backpressure",
        new Error("Client sent messages faster than the realtime session could process them."),
        false,
      );
      void this.closeClientAfterCleanup(1009, "client input backpressure");
      return;
    }

    let message: ClientMessage;
    let requestId: string | undefined;
    try {
      const text = typeof frame === "string" ? frame : new TextDecoder().decode(frame);
      const parsed = JSON.parse(text) as unknown;
      requestId = requestIdFromUnknown(parsed);
      message = parseClientMessage(parsed);
    } catch (error) {
      this.handleClientMessageFailure(error, requestId);
      return;
    }

    this.pendingClientMessages += 1;
    this.pendingClientBytes += bytes;
    const processMessage = async () => {
      try {
        if (!this.closing && !this.clientInputOverflowed) {
          await this.handleClientMessage(message);
          this.clientMessageErrors = 0;
        }
      } catch (error) {
        this.handleClientMessageFailure(error, message.id);
      } finally {
        this.pendingClientMessages -= 1;
        this.pendingClientBytes -= bytes;
      }
    };
    if (isPreemptiveClientControl(message, Boolean(this.liveSession))) {
      void processMessage();
    } else {
      this.messageQueue = this.messageQueue.then(processMessage, processMessage);
    }
  }

  private async handleClientMessage(message: ClientMessage): Promise<void> {
    if (message.type === "session.start") {
      await this.start(message);
      return;
    }
    if (message.type === "session.close") {
      await this.closeClientAfterCleanup(1000, "session detached");
      return;
    }
    if (!this.liveSession || !this.ownerId || !this.sessionKey || !this.readySent) {
      this.fail("session_not_started", new Error("Send session.start before using the live session."), true, message.id);
      return;
    }

    switch (message.type) {
      case "audio.input":
        validateAudioFrame(message.data, message.mimeType, this.deps.config.server.maxAudioBytes);
        if (this.shouldHoldSessionInput()) {
          this.holdAudioInput(message.data, message.mimeType);
          return;
        }
        if (this.speechGate && isPcmMimeType(message.mimeType)) {
          await this.handleGatedAudioInput(message);
          return;
        }
        this.userSpeaking = true;
        await this.forwardRealtimeClientInput(
          "audio",
          () => this.liveSession!.sendRealtimeAudio({ data: message.data, mimeType: message.mimeType }),
        );
        return;
      case "audio.end":
        if (this.shouldHoldSessionInput()) {
          this.heldInputs.push({ kind: "audio_end" });
          return;
        }
        this.userSpeaking = false;
        await this.forwardRealtimeClientInput("audio turn", async () => {
          if (await this.liveSession!.sendAudioStreamEnd()) this.providerResponseActive = true;
        });
        return;
      case "text.input":
        validateText(message.text, this.deps.config.server.maxTextChars, "Text input");
        if (this.shouldHoldSessionInput()) {
          this.holdTextInput(message.text);
          return;
        }
        this.userSpeaking = false;
        await this.forwardRealtimeClientInput("text", () => this.liveSession!.sendText(message.text), true);
        return;
      case "response.cancel":
        await this.cancelRealtimeResponse(message.reason, message.truncate);
        return;
      case "task.list": {
        const taskWindow = await this.runTaskOperation(
          () => this.deps.taskSupervisor.list(this.ownerId!, message.limit + 1),
          "Unable to read the background task inbox.",
        );
        const tasks = taskWindow.slice(0, message.limit);
        this.send({
          type: "task.snapshot",
          reason: "list",
          requestId: message.id,
          tasks: projectTaskList(tasks),
          truncated: taskWindow.length > message.limit,
        });
        return;
      }
      case "task.get": {
        const task = await this.runTaskOperation(
          () => this.deps.taskSupervisor.get(this.ownerId!, message.taskId),
          "Unable to read that background task.",
        );
        this.send({
          type: "task.snapshot",
          reason: "get",
          requestId: message.id,
          tasks: task ? [projectTaskSnapshot(task, { includeOutput: true })] : [],
          truncated: false,
        });
        return;
      }
      case "task.follow_up": {
        if (this.protocolVersion < 4 || !this.deps.taskSupervisor.followUp) {
          throw new Error("Task follow-ups require Hermes Live protocol v4.");
        }
        validateText(message.message, this.deps.config.server.maxTextChars, "Task follow-up message");
        const task = await this.runTaskOperation(
          () => this.deps.taskSupervisor.followUp!({
            ownerIdentity: this.sessionKey!,
            ownerId: this.ownerId!,
            sessionKey: this.sessionKey!,
            parentTaskId: message.taskId,
            input: message.message,
            ...(message.title ? { title: message.title } : {}),
            ...(this.conversation.sessionId ? { originConversationId: this.conversation.sessionId } : {}),
          }),
          "Unable to start that task follow-up.",
        );
        this.send(projectTaskLifecycle(task, message.id));
        return;
      }
      case "task.stop": {
        const task = await this.runTaskOperation(
          () => this.deps.taskSupervisor.stop(this.ownerId!, message.taskId, message.reason),
          "Unable to stop that background task safely.",
        );
        this.send(projectTaskLifecycle(task, message.id));
        return;
      }
      case "task.notification.ack": {
        const current = await this.runTaskOperation(
          () => this.deps.taskSupervisor.get(this.ownerId!, message.taskId),
          "Unable to acknowledge that task notification.",
        );
        const currentNotification = current ? projectTaskNotification(current) : undefined;
        if (
          !current ||
          !current.notification.unread ||
          !currentNotification ||
          currentNotification.notificationId !== message.notificationId
        ) {
          throw new Error("Notification acknowledgement does not match the current task notification.");
        }
        const task = await this.runTaskOperation(
          () => this.deps.taskSupervisor.acknowledgeNotification(this.ownerId!, message.taskId),
          "Unable to acknowledge that task notification.",
        );
        const notification = projectTaskNotification(task);
        if (notification) {
          this.send({
            type: "task.notification",
            taskId: task.taskId,
            sequence: task.sequence,
            occurredAt: task.updatedAt,
            requestId: message.id,
            notification,
          });
        }
        return;
      }
    }
  }

  private async resolveConversation(
    selection: NonNullable<Extract<ClientMessage, { type: "session.start" }>["conversation"]>,
  ): Promise<PublicConversation> {
    if (selection.mode === "unbound") return { mode: "unbound" };

    const assertSessionsSupported = this.deps.hermes.assertSessionsSupported;
    const createSession = this.deps.hermes.createSession;
    const getSession = this.deps.hermes.getSession;
    const getSessionHistory = this.deps.hermes.getSessionHistory;
    if (!assertSessionsSupported || !createSession || !getSession || !getSessionHistory) {
      if (selection.mode === "persistent") {
        this.deps.logger.warn("hermes session continuity unavailable; persistent voice thread degraded to unbound", {
          sessionId: this.id,
        });
        return { mode: "unbound" };
      }
      throw new Error("Hermes session continuity is unavailable in this installation.");
    }
    try {
      await assertSessionsSupported.call(this.deps.hermes, this.abort.signal);
    } catch (error) {
      if (selection.mode === "persistent") {
        this.deps.logger.warn("hermes session continuity unavailable; persistent voice thread degraded to unbound", {
          sessionId: this.id,
          error: errorToMessage(error),
        });
        return { mode: "unbound" };
      }
      throw error;
    }

    if (selection.mode === "new") {
      const session = await createSession.call(this.deps.hermes, {
        ...(selection.title ? { title: selection.title } : {}),
        signal: this.abort.signal,
      });
      return publicConversation("new", session);
    }

    if (selection.mode === "persistent") {
      // Serialize so simultaneous devices cannot both race past a missing
      // thread lookup (a duplicate title is still benign: the newest wins
      // on the next resolution).
      return this.serializeConversationOperation(
        () => this.resolvePersistentConversation(),
      );
    }

    const history = await getSessionHistory.call(this.deps.hermes, selection.sessionId!, this.abort.signal);
    const session = await getSession.call(this.deps.hermes, history.sessionId, this.abort.signal);
    return publicConversation("resume", session);
  }

  /**
   * The durable per-owner voice thread: the most recent Hermes session whose
   * title exactly matches the configured voice thread title, or a fresh one.
   */
  private async resolvePersistentConversation(): Promise<PublicConversation> {
    const title = this.deps.config.context.voiceThreadTitle;
    const newestId = await this.findSessionIdByTitle(title);

    if (newestId) {
      try {
        const history = await this.deps.hermes.getSessionHistory!.call(this.deps.hermes, newestId, this.abort.signal);
        const session = await this.deps.hermes.getSession!.call(this.deps.hermes, history.sessionId, this.abort.signal);
        return publicConversation("resume", session);
      } catch (error) {
        this.deps.logger.warn("persistent voice thread failed to resume; creating a fresh thread", {
          sessionId: this.id,
          threadSessionId: newestId,
          error: errorToMessage(error),
        });
      }
    }

    const session = await this.deps.hermes.createSession!.call(this.deps.hermes, {
      title,
      signal: this.abort.signal,
    });
    return publicConversation("new", session);
  }

  /** Newest session id whose title matches exactly, or undefined. */
  private async findSessionIdByTitle(title: string): Promise<string | undefined> {
    const listSessions = this.deps.hermes.listSessions;
    const existing = listSessions
      ? await listSessions.call(this.deps.hermes, { title, limit: 5, signal: this.abort.signal }).catch(() => undefined)
      : undefined;
    const newest = existing?.reduce<HermesSessionSummary | undefined>(
      (latest, session) => (latest === undefined || (session.lastActive ?? 0) >= (latest.lastActive ?? 0) ? session : latest),
      undefined,
    );
    return newest?.id;
  }

  /** Lazily created dedicated recall session behind search_past_chats. */
  private async recallSession(): Promise<string> {
    if (this.recallSessionId) return this.recallSessionId;
    const title = this.deps.config.context.recallSessionTitle;
    let sessionId = await this.findSessionIdByTitle(title);
    if (!sessionId) {
      const created = await this.deps.hermes.createSession!.call(this.deps.hermes, {
        title,
        signal: this.abort.signal,
      });
      sessionId = created.id;
    }
    this.recallSessionId = sessionId;
    return sessionId;
  }

  private serializeConversationOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.conversationOperation.then(operation, operation);
    this.conversationOperation = result.then(() => undefined, () => undefined);
    return result;
  }

  /**
   * Accept a slow Hermes chat turn for background execution. Returns the
   * pending id the receipt names; the shaped answer arrives as exact speech
   * through the idle-gated flush, with filler coverage while it computes.
   */
  private startDeferredAnswer(
    kind: DeferredAnswerRecord["kind"],
    resolveSessionId: string | (() => Promise<string>),
    message: string,
    instructions?: string,
  ): string {
    const pendingId = `defer_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const record: DeferredAnswerRecord = {
      pendingId,
      kind,
      startedAt: Date.now(),
      delivered: false,
    };
    this.deferredAnswers.set(pendingId, record);
    while (this.deferredAnswers.size > MAX_DEFERRED_ANSWERS) {
      const oldest = [...this.deferredAnswers.values()].sort((left, right) => left.startedAt - right.startedAt)[0];
      if (!oldest || oldest.pendingId === pendingId) break;
      this.deferredAnswers.delete(oldest.pendingId);
    }
    // Fillers cover the wait behind the same delay/interval policy as tools.
    this.filler?.beginSequence();
    void this.serializeConversationOperation(() => this.runDeferredAnswer(record, resolveSessionId, message, instructions))
      .catch(() => undefined);
    return pendingId;
  }

  private async runDeferredAnswer(
    record: DeferredAnswerRecord,
    resolveSessionId: string | (() => Promise<string>),
    message: string,
    instructions?: string,
  ): Promise<void> {
    try {
      const sessionId = typeof resolveSessionId === "string" ? resolveSessionId : await resolveSessionId();
      if (this.closing) return;
      let completed: HermesSessionChatResult | undefined;
      const stream = this.deps.hermes.chatSessionStream;
      if (stream) {
        try {
          for await (const event of stream.call(
            this.deps.hermes,
            sessionId,
            message,
            {
              signal: this.abort.signal,
              sessionKey: this.sessionKey!,
              ...(instructions ? { instructions } : {}),
            },
          )) {
            if (this.closing) return;
            if (event.type === "assistant.delta") {
              this.pumpDeferredDelta(record, event.text);
            } else if (event.type === "assistant.completed") {
              completed = { sessionId: event.sessionId, content: event.content };
              break;
            } else if (event.type === "run.failed") break;
          }
        } catch (error) {
          if (this.closing) return;
          this.deps.logger.warn("deferred chat stream failed; falling back to blocking chat", {
            sessionId: this.id,
            pendingId: record.pendingId,
            error: errorToMessage(error),
          });
        }
      }
      if (!completed) {
        if (this.closing) return;
        const chatSession = this.deps.hermes.chatSession!;
        completed = await chatSession.call(this.deps.hermes, sessionId, message, {
          signal: this.abort.signal,
          sessionKey: this.sessionKey!,
          ...(instructions ? { instructions } : {}),
        });
      }
      if (this.closing) return;
      if (record.kind === "conversation") {
        this.conversation = {
          ...this.conversation,
          sessionId: completed.sessionId,
          lastActiveAt: Date.now(),
        } as PublicConversation;
      }
      this.completeDeferredAnswer(record, completed.content);
    } catch (error) {
      if (this.closing) return;
      this.deps.logger.warn("deferred hermes answer failed", {
        sessionId: this.id,
        pendingId: record.pendingId,
        error: errorToMessage(error),
      });
      this.completeDeferredAnswer(record, "I couldn't finish that one. Want me to try again?");
    }
  }

  private completeDeferredAnswer(record: DeferredAnswerRecord, answer: string): void {
    const current = this.deferredAnswers.get(record.pendingId);
    if (!current || current.delivered) return;
    const spokenChars = current.streamedChars ?? 0;
    if (spokenChars > 0) {
      // Already streaming through the sidecar: speak only the unseen tail.
      const tail = answer.slice(Math.min(spokenChars, answer.length)).trim();
      if (!tail) {
        current.delivered = true;
        this.deferredAnswers.delete(current.pendingId);
        return;
      }
      if (this.speechMux?.available) {
        void this.speechMux.speak(deferredAnswerSpeech(tail));
        current.delivered = true;
        this.deferredAnswers.delete(current.pendingId);
        return;
      }
      current.speech = deferredAnswerSpeech(tail);
    } else {
      current.speech = deferredAnswerSpeech(current.kind === "recall" ? answer.slice(0, 4_000) : answer);
    }
    current.readyAt = Date.now();
    this.armDeferredAnswerEscalation();
    this.scheduleNotificationFlush();
  }

  /**
   * Sentence pump for streamed answers: each completed delta sentence goes
   * straight to the sidecar, so first answer speech follows the first
   * sentence instead of the full completion.
   */
  private pumpDeferredDelta(record: DeferredAnswerRecord, delta: string): void {
    const mux = this.speechMux;
    if (!mux?.available || record.delivered) return;
    record.deltaBuffer = (record.deltaBuffer ?? "") + delta;
    if (record.deltaBuffer.length > 4_000) record.deltaBuffer = record.deltaBuffer.slice(-2_000);
    for (;;) {
      const match = record.deltaBuffer.match(/[^.!?]+[.!?]+(\s|$)/u);
      if (!match) break;
      const consumed = match[0];
      record.deltaBuffer = record.deltaBuffer.slice(consumed.length);
      record.streamedChars = (record.streamedChars ?? 0) + consumed.length;
      const sentence = consumed.trim();
      if (sentence) void mux.speak(sentence);
    }
  }

  /** If the user stays busy, an "answer ready" clip invites them back. */
  private armDeferredAnswerEscalation(): void {
    if (this.deferredAnswerEscalationTimer !== undefined) return;
    this.deferredAnswerEscalationTimer = setTimeout(() => {
      this.deferredAnswerEscalationTimer = undefined;
      const stillWaiting = [...this.deferredAnswers.values()]
        .filter((candidate) => !candidate.delivered && candidate.speech !== undefined);
      if (stillWaiting.length === 0 || this.closing) return;
      this.filler?.speakOnce("answer_ready");
    }, DEFERRED_ANSWER_ESCALATION_MS);
    this.deferredAnswerEscalationTimer.unref?.();
  }

  /** Delivers at most one ready answer as exact speech; true when spoken. */
  private async deliverNextDeferredAnswer(force = false): Promise<boolean> {
    if (this.closing || !this.liveSession?.sendTaskNotification) return false;
    const ready = [...this.deferredAnswers.values()]
      .filter((candidate) => !candidate.delivered && candidate.speech !== undefined)
      .sort((left, right) => (left.readyAt ?? 0) - (right.readyAt ?? 0));
    const record = ready[0];
    if (!record) return false;
    // The flush's guards can be invalidated while an answer was computed.
    if (
      this.userSpeaking ||
      this.providerResponseActive ||
      (!force && this.providerTurnResponseExpected) ||
      this.notificationResponsePending
    ) {
      return false;
    }
    // Sidecar first: no provider LLM echo, no busy() serialization.
    const mux = this.speechMux;
    if (mux?.available) {
      const outcome = await mux.speak(record.speech!);
      if (outcome === "spoken") {
        this.deferredAnswers.delete(record.pendingId);
        this.scheduleNotificationFlush();
        return true;
      }
      if (outcome === "aborted") return false;
      // skipped/failed/unavailable: fall through to the provider path.
    }
    this.notificationResponsePending = true;
    const context = `[HERMES_LIVE_DEFERRED_ANSWER_V1:${this.notificationToken}] ${JSON.stringify({ announcement: record.speech })}`;
    try {
      await withAbortAndDeadline(
        this.liveSession.sendTaskNotification({ context, announcement: record.speech!, speech: record.speech! }),
        this.abort.signal,
        MAX_PROVIDER_IO_WAIT_MS,
        "Realtime provider deferred answer did not settle before the safety deadline.",
      );
    } catch (error) {
      this.notificationResponsePending = false;
      if (!this.closing) {
        this.deps.logger.warn("deferred answer speech delivery failed", {
          sessionId: this.id,
          pendingId: record.pendingId,
          error: errorToMessage(error),
        });
      }
      return false;
    }
    this.deferredAnswers.delete(record.pendingId);
    this.stopFiller();
    if (this.notificationResponsePending) this.armNotificationResponseWatchdog();
    this.scheduleNotificationFlush();
    return true;
  }

  private availableProviderTools(): LiveToolName[] {
    const tools: LiveToolName[] = [
      "start_background_task",
      "list_background_tasks",
      "get_background_task",
      "stop_background_task",
      "remember",
    ];
    if (this.protocolVersion >= 4 && this.deps.taskSupervisor.followUp) {
      tools.push("follow_up_background_task");
    }
    if (this.protocolVersion >= 4 && this.conversation.mode !== "unbound" && this.deps.hermes.chatSession) {
      tools.unshift("continue_hermes_conversation");
    }
    if (
      this.deps.hermes.chatSession
      && this.deps.hermes.listSessions
      && this.deps.hermes.createSession
    ) {
      tools.push("search_past_chats");
    }
    if (this.protocolVersion >= 6) tools.push("pause_voice_input");
    if (this.protocolVersion >= 9) tools.push("set_client_audio");
    return tools;
  }

  private executeToolCall(call: LiveToolCall): Promise<Record<string, unknown>> {
    if (!this.ownerId || !this.sessionKey) throw new Error("session.start has not completed.");
    switch (call.name) {
      case "continue_hermes_conversation": {
        const message = stringArg(call, "message");
        if (!message) throw new Error("continue_hermes_conversation requires message.");
        validateText(message, this.deps.config.server.maxTextChars, "Hermes conversation message");
        if (this.protocolVersion < 4 || this.conversation.mode === "unbound" || !this.conversation.sessionId) {
          return Promise.resolve({
            ok: false,
            error: "No persisted Hermes conversation is selected for this voice session.",
          });
        }
        const chatSession = this.deps.hermes.chatSession;
        if (!chatSession) {
          return Promise.resolve({ ok: false, error: "This Hermes installation cannot continue saved conversations." });
        }
        // Async tools: acknowledge instantly, deliver the answer as speech
        // when it is ready. The held-input window collapses to the receipt.
        if (this.deps.config.hermes.asyncTools !== false) {
          const pendingId = this.startDeferredAnswer("conversation", this.conversation.sessionId!, message);
          return Promise.resolve({
            spoken_response: "On it — I'm checking with Hermes now. Keep talking; I'll share the answer the moment I have it.",
            ok: true,
            deferred: true,
            pending_id: pendingId,
          });
        }
        return this.serializeConversationOperation(async () => {
          const result = await chatSession.call(this.deps.hermes, this.conversation.sessionId!, message, {
            signal: this.abort.signal,
            sessionKey: this.sessionKey!,
          });
          this.conversation = {
            ...this.conversation,
            sessionId: result.sessionId,
            lastActiveAt: Date.now(),
          } as PublicConversation;
          return {
            ok: true,
            session_id: result.sessionId,
            message: result.content,
            ...(result.usage ? { usage: result.usage } : {}),
          };
        });
      }
      case "search_past_chats": {
        const query = stringArg(call, "query");
        if (!query) throw new Error("search_past_chats requires query.");
        validateText(query, this.deps.config.server.maxTextChars, "Past chat search query");
        const chatSession = this.deps.hermes.chatSession;
        if (!chatSession || !this.deps.hermes.listSessions || !this.deps.hermes.createSession) {
          return Promise.resolve({ ok: false, error: "This Hermes installation cannot search past conversations." });
        }
        if (this.deps.config.hermes.asyncTools !== false) {
          // The recall session resolves inside the background runner so the
          // spoken receipt returns without any Hermes round-trip.
          const pendingId = this.startDeferredAnswer("recall", async () => this.recallSession(), query, RECALL_INSTRUCTIONS);
          return Promise.resolve({
            spoken_response: "Let me look through our past chats — give me a moment.",
            ok: true,
            deferred: true,
            pending_id: pendingId,
          });
        }
        return this.serializeConversationOperation(async () => {
          const recallSessionId = await this.recallSession();
          try {
            const result = await Promise.race([
              chatSession.call(this.deps.hermes, recallSessionId, query, {
                signal: this.abort.signal,
                sessionKey: this.sessionKey!,
                instructions: RECALL_INSTRUCTIONS,
              }),
              new Promise<never>((_resolve, reject) => setTimeout(
                () => reject(new Error("recall timeout")),
                this.deps.config.context.recallTimeoutMs,
              ).unref?.()),
            ]);
            return {
              ok: true,
              query,
              message: result.content.slice(0, 4_000),
            };
          } catch (error) {
            if (this.closing) throw error;
            this.deps.logger.warn("past chat search failed", {
              sessionId: this.id,
              error: errorToMessage(error),
            });
            return { ok: false, error: "Past conversation search is unavailable right now." };
          }
        });
      }
      case "remember": {
        const fact = stringArg(call, "fact");
        if (!fact) throw new Error("remember requires fact.");
        validateText(fact, this.deps.config.server.maxTextChars, "Remembered fact");
        return this.runTaskOperation(
          () => this.deps.taskSupervisor.submit({
            ownerIdentity: this.sessionKey!,
            sessionKey: this.sessionKey!,
            input: `Remember persistently in long-term memory: ${fact}`,
            title: `Remember: ${fact.slice(0, 80)}`,
            executionMode: "exclusive",
            ...(this.conversation.sessionId ? { originConversationId: this.conversation.sessionId } : {}),
          }),
          "Memory write could not be accepted safely.",
        ).then((task) => ({
          spoken_response: "I've sent that to Hermes to remember.",
          ok: true,
          task_id: task.taskId,
          status: task.status,
        }));
      }
      case "start_background_task": {
        const message = stringArg(call, "message");
        if (!message) throw new Error("start_background_task requires message.");
        validateText(message, this.deps.config.server.maxTextChars, "Background task message");
        const recentContext = optionalStringArg(call, "recent_voice_context");
        if (recentContext) validateText(recentContext, this.deps.config.server.maxTextChars, "Recent voice context");
        const title = optionalStringArg(call, "title");
        if (title && title.length > 256) throw new Error("Background task title exceeds 256 characters.");
        const requestedExecutionMode = executionModeArg(call);
        const executionMode = this.deps.config.tasks.trustDeclaredReadOnly === true
          ? requestedExecutionMode
          : "exclusive";
        const resourceKeys = this.deps.config.tasks.trustDeclaredReadOnly === true
          ? resourceKeysArg(call)
          : undefined;
        const input = recentContext ? `${message}\n\nRecent voice context:\n${recentContext}` : message;
        return this.runTaskOperation(() => this.deps.taskSupervisor.submit({
          ownerIdentity: this.sessionKey!,
          sessionKey: this.sessionKey!,
          input,
          ...(title ? { title } : {}),
          executionMode,
          ...(resourceKeys ? { resourceKeys } : {}),
          ...(this.conversation.sessionId ? { originConversationId: this.conversation.sessionId } : {}),
        }), "Background task could not be accepted safely.").then((task) => ({
          spoken_response: "Nice, I just spun up that task and started a watcher to keep an eye on it. I’ll let you know when it finishes or needs attention, and you can keep talking.",
          ok: true,
          task_id: task.taskId,
          status: task.status,
          execution_mode: task.executionMode,
          message: "Background task accepted. The user can keep talking or disconnect.",
        }));
      }
      case "list_background_tasks": {
        const includeCompleted = booleanArg(call, "include_completed", true);
        const summaryOnly = booleanArg(call, "summary_only", false);
        return this.runTaskOperation(
          () => this.deps.taskSupervisor.list(this.ownerId!, 25),
          "Unable to read the background task inbox.",
        ).then((records) => {
          const selected = records
            .filter((record) => includeCompleted || !isTaskNotificationState(record.status));
          return {
            ...(summaryOnly ? { spoken_response: taskInboxSpokenSummary(selected) } : {}),
            ok: true,
            tasks: selected.map((record) => projectTaskSnapshot(record)),
          };
        });
      }
      case "get_background_task": {
        const taskId = stringArg(call, "task_id");
        if (!taskId) throw new Error("get_background_task requires task_id.");
        const includeOutput = booleanArg(call, "include_output", false);
        return this.runTaskOperation(
          () => this.deps.taskSupervisor.get(this.ownerId!, taskId),
          "Unable to read that background task.",
        ).then((task) => task
          ? { ok: true, task: projectTaskSnapshot(task, { includeOutput }) }
          : { ok: false, task_id: taskId, error: "Task not found." });
      }
      case "follow_up_background_task": {
        const taskId = stringArg(call, "task_id");
        const message = stringArg(call, "message");
        if (!taskId || !message) throw new Error("follow_up_background_task requires task_id and message.");
        validateText(message, this.deps.config.server.maxTextChars, "Task follow-up message");
        const title = optionalStringArg(call, "title");
        if (title && title.length > 256) throw new Error("Task follow-up title exceeds 256 characters.");
        if (this.protocolVersion < 4 || !this.deps.taskSupervisor.followUp) {
          return Promise.resolve({ ok: false, error: "Task follow-ups require Hermes Live protocol v4." });
        }
        return this.runTaskOperation(() => this.deps.taskSupervisor.followUp!({
          ownerIdentity: this.sessionKey!,
          ownerId: this.ownerId!,
          sessionKey: this.sessionKey!,
          parentTaskId: taskId,
          input: message,
          ...(title ? { title } : {}),
          ...(this.conversation.sessionId ? { originConversationId: this.conversation.sessionId } : {}),
        }), "Unable to start that task follow-up.").then((task) => ({
          spoken_response: "I've started that follow-up in the background.",
          ok: true,
          task_id: task.taskId,
          parent_task_id: task.parentTaskId,
          root_task_id: task.rootTaskId,
          status: task.status,
          message: "Follow-up task accepted. The user can keep talking or disconnect.",
        }));
      }
      case "stop_background_task": {
        const taskId = stringArg(call, "task_id");
        if (!taskId) throw new Error("stop_background_task requires task_id.");
        return this.runTaskOperation(
          () => this.deps.taskSupervisor.stop(this.ownerId!, taskId, optionalStringArg(call, "reason")),
          "Unable to stop that background task safely.",
        ).then((task) => ({
          spoken_response: "I've asked Hermes to stop that task.",
          ok: true,
          task_id: task.taskId,
          status: projectTaskSnapshot(task).state,
        }));
      }
      case "pause_voice_input": {
        if (this.protocolVersion < 6) {
          return Promise.resolve({
            ok: false,
            error: "Voice-controlled microphone pause requires Hermes Live protocol v6.",
          });
        }
        this.send({ type: "input.pause_requested", reason: "voice_command" });
        return Promise.resolve({
          spoken_response: "Listening is paused. Use the microphone button when you want me back.",
          ok: true,
          listening: false,
          message: "Microphone listening paused. The user can resume from the client microphone control.",
        });
      }
      case "set_client_audio": {
        if (this.protocolVersion < 9) {
          return Promise.resolve({
            ok: false,
            error: "Voice-controlled client audio settings require Hermes Live protocol v9.",
          });
        }
        const microphone = call.args.microphone;
        if (microphone !== undefined && microphone !== "active" && microphone !== "paused") {
          throw new Error("set_client_audio microphone must be active or paused.");
        }
        const effects = call.args.effects;
        if (effects !== undefined && typeof effects !== "boolean") {
          throw new Error("set_client_audio effects must be a boolean.");
        }
        const effectsVolumeRaw = call.args.effects_volume;
        if (
          effectsVolumeRaw !== undefined
          && (typeof effectsVolumeRaw !== "number" || !Number.isFinite(effectsVolumeRaw)
            || effectsVolumeRaw < 0 || effectsVolumeRaw > 1)
        ) {
          throw new Error("set_client_audio effects_volume must be a number between 0 and 1.");
        }
        if (microphone === undefined && effects === undefined && effectsVolumeRaw === undefined) {
          return Promise.resolve({
            ok: false,
            error: "set_client_audio requires at least one of microphone, effects, or effects_volume.",
          });
        }
        const effectsVolume = effectsVolumeRaw === undefined
          ? undefined
          : Math.round(effectsVolumeRaw * 100) / 100;
        this.send({
          type: "client.audio_settings",
          source: "voice_command",
          ...(microphone !== undefined ? { microphone } : {}),
          ...(effects !== undefined ? { effects } : {}),
          ...(effectsVolume !== undefined ? { effectsVolume } : {}),
        });
        // Fire-and-forget like pause_voice_input: the client stays in charge
        // of its own hardware, so the receipt describes the request, not a
        // confirmed client state.
        const applied = [
          microphone === "active"
            ? "the microphone is listening again"
            : microphone === "paused" ? "the microphone is paused" : null,
          effects === true ? "the interface sounds are on" : effects === false ? "the interface sounds are off" : null,
          effectsVolume !== undefined ? `the interface sound volume is ${Math.round(effectsVolume * 100)}%` : null,
        ].filter(Boolean).join(", ");
        return Promise.resolve({
          spoken_response: `Done — ${applied}.`,
          ok: true,
          message: `Client audio settings requested: ${applied}. The client applies them and stays authoritative.`,
        });
      }
      default:
        return Promise.resolve({ ok: false, error: `Unknown hermes-live tool: ${call.name}` });
    }
  }

  private enqueueProviderToolCall(call: LiveToolCall): void {
    let id: string;
    let fingerprint: string;
    try {
      id = requireProviderToolCallId(call);
      fingerprint = providerToolCallFingerprint(call);
    } catch (error) {
      this.fail("tool_call_failed", error, false);
      void this.closeClientAfterCleanup(1011, "invalid realtime tool call");
      return;
    }

    const existing = this.providerToolCalls.get(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        this.fail("realtime_tool_call_conflict", new Error("Realtime provider reused a tool-call id."), false);
        void this.closeClientAfterCleanup(1011, "conflicting realtime tool call");
        return;
      }
      if (existing.cancelled || existing.state !== "done") return;
      if (!existing.response) {
        this.failExpiredProviderToolCallReplay();
        return;
      }
      this.scheduleProviderToolOperation(() => this.deliverProviderToolResponse(call, existing.response!, existing));
      return;
    }

    const tombstoneFingerprint = this.providerToolCallTombstones.get(providerToolCallIdDigest(id));
    if (tombstoneFingerprint) {
      if (tombstoneFingerprint !== fingerprint) {
        this.fail("realtime_tool_call_conflict", new Error("Realtime provider reused a tool-call id."), false);
        void this.closeClientAfterCleanup(1011, "conflicting realtime tool call");
        return;
      }
      this.failExpiredProviderToolCallReplay();
      return;
    }

    if (this.pendingProviderToolCalls >= MAX_PENDING_PROVIDER_TOOL_CALLS) {
      this.failProviderToolQueueOverflow();
      return;
    }
    if (this.providerToolCalls.size + this.providerToolCallTombstones.size >= MAX_SEEN_PROVIDER_TOOL_CALLS) {
      this.failProviderToolReplayLedgerOverflow();
      return;
    }
    if (this.providerToolCalls.size >= MAX_PROCESSED_PROVIDER_TOOL_CALLS) {
      const oldestDone = [...this.providerToolCalls].find(([, record]) => record.state === "done");
      if (!oldestDone) {
        this.failProviderToolQueueOverflow();
        return;
      }
      this.cachedProviderToolResponseBytes = Math.max(
        0,
        this.cachedProviderToolResponseBytes - (oldestDone[1].responseBytes ?? 0),
      );
      this.providerToolCalls.delete(oldestDone[0]);
      this.providerToolCallTombstones.set(providerToolCallIdDigest(oldestDone[0]), oldestDone[1].fingerprint);
    }

    const record: ProviderToolCallRecord = {
      fingerprint,
      state: "pending",
      cancelled: false,
      responseDelivery: "not_started",
    };
    this.providerToolCalls.set(id, record);
    this.speechTiming.noteToolCallStarted(Date.now());
    // Fast tools finish before the filler delay elapses; slow ones get clips.
    if (!this.fillerSequenceForProvider) this.filler?.beginSequence();
    this.pendingProviderToolCalls += 1;
    this.scheduleProviderToolOperation(async () => {
      try {
        if (record.cancelled) return;
        let response: Record<string, unknown>;
        try {
          response = await this.executeToolCall(call);
        } catch (error) {
          const publicMessage = error instanceof PublicTaskOperationError
            ? error.message
            : "Background task request was rejected.";
          const operationError = error instanceof PublicTaskOperationError ? error.operationCause : error;
          response = { ok: false, error: publicMessage };
          if (!record.cancelled) {
            this.failPublic("tool_call_failed", publicMessage, operationError, true);
          }
        }
        response = boundedProviderToolResponse(response);
        record.state = "done";
        if (!record.cancelled) {
          const bytes = safeJsonByteLength(response);
          if (bytes <= MAX_CACHED_PROVIDER_TOOL_RESPONSE_BYTES - this.cachedProviderToolResponseBytes) {
            record.response = response;
            record.responseBytes = bytes;
            this.cachedProviderToolResponseBytes += bytes;
          }
          await this.deliverProviderToolResponse(call, response, record);
        }
      } finally {
        record.state = "done";
        this.pendingProviderToolCalls -= 1;
      }
    });
  }

  private handleProviderToolCallCancellation(callIds: string[]): void {
    if (callIds.length === 0 || callIds.length > MAX_PROCESSED_PROVIDER_TOOL_CALLS) {
      throw new Error("Realtime provider emitted an invalid tool-call cancellation batch.");
    }
    for (const id of new Set(callIds.map(requireProviderToolCancellationId))) {
      const record = this.providerToolCalls.get(id);
      if (!record) {
        if (this.providerToolCallTombstones.has(providerToolCallIdDigest(id))) {
          this.send({ type: "log", level: "info", message: "Realtime provider cancelled a completed tool call" });
          continue;
        }
        this.fail("realtime_tool_cancellation_unknown", new Error("Realtime provider cancelled an unknown tool call."), false);
        void this.closeClientAfterCleanup(1011, "uncorrelated realtime tool cancellation");
        return;
      }
      if (record.responseDelivery === "sending") {
        this.fail(
          "realtime_tool_cancellation_delivery_indeterminate",
          new Error("The realtime provider cancelled a tool result while it was being delivered."),
          false,
        );
        void this.closeClientAfterCleanup(1011, "realtime tool delivery indeterminate");
        return;
      }
      record.cancelled = true;
      if (record.responseBytes) {
        this.cachedProviderToolResponseBytes = Math.max(0, this.cachedProviderToolResponseBytes - record.responseBytes);
      }
      record.response = undefined;
      record.responseBytes = undefined;
      this.send({ type: "log", level: "info", message: "Realtime provider cancelled a tool call" });
    }
    this.maybeReleaseHeldInputs();
  }

  private async deliverProviderToolResponse(
    call: LiveToolCall,
    response: Record<string, unknown>,
    record: ProviderToolCallRecord,
  ): Promise<void> {
    if (record.cancelled || this.closing || !this.liveSession) return;
    record.responseDelivery = "sending";
    try {
      const spokenReceipt = typeof response.spoken_response === "string" ? response.spoken_response.trim() : "";
      const sidecarSpeaksReceipt = spokenReceipt.length > 0 && (this.speechMux?.available ?? false);
      if (sidecarSpeaksReceipt) {
        // The sidecar speaks the receipt without a provider LLM round-trip.
        void this.speechMux!.speak(spokenReceipt, { immediate: true });
      }
      await withAbortAndDeadline(
        this.liveSession.sendToolResponse(
          call,
          response,
          sidecarSpeaksReceipt ? { suppressSpeech: true } : undefined,
        ),
        this.abort.signal,
        MAX_PROVIDER_IO_WAIT_MS,
        "Realtime provider tool response did not settle before the safety deadline.",
      );
      if (!record.cancelled) record.responseDelivery = "sent";
      // The receipt speech is starting: filler and stale sidecar speech yield.
      if (!sidecarSpeaksReceipt) this.stopFiller();
    } catch (error) {
      if (this.closing) return;
      this.deps.logger.warn("failed to send realtime tool response", {
        sessionId: this.id,
        error: "realtime_provider_tool_response_failed",
      });
      this.fail("realtime_tool_response_failed", new Error("Realtime provider could not accept the task receipt."), false);
      await this.closeClientAfterCleanup(1011, "realtime tool response failed");
    }
  }

  private scheduleProviderToolOperation(operation: () => Promise<void>): void {
    this.providerToolOperations.push(operation);
    this.drainProviderToolOperations();
  }

  private drainProviderToolOperations(): void {
    while (
      !this.closing &&
      this.activeProviderToolOperations < MAX_CONCURRENT_PROVIDER_TOOL_CALLS &&
      this.providerToolOperations.length > 0
    ) {
      const operation = this.providerToolOperations.shift()!;
      this.activeProviderToolOperations += 1;
      void operation().catch((error) => {
        this.deps.logger.error("unexpected realtime tool operation failure", {
          sessionId: this.id,
          error: errorToMessage(error),
        });
      }).finally(() => {
        this.activeProviderToolOperations -= 1;
        this.maybeReleaseHeldInputs();
        this.drainProviderToolOperations();
      });
    }
  }

  private failProviderToolQueueOverflow(): void {
    this.fail("realtime_tool_queue_overflow", new Error("Realtime provider exceeded the safe tool-call limit."), false);
    void this.closeClientAfterCleanup(1011, "realtime tool queue overflow");
  }

  /**
   * Speech-confirmed audio path (protocol v7): the gate decides which frames
   * reach the provider and when the client learns about confirmed speech, so
   * noise never interrupts a response and the provider VAD stays protected.
   */
  private async handleGatedAudioInput(message: Extract<ClientMessage, { type: "audio.input" }>): Promise<void> {
    const gate = this.speechGate!;
    gate.setDownlinkActive(this.downlinkActiveForGate());
    const decision = await gate.ingest({ data: message.data, mimeType: message.mimeType });
    if (this.closing) return;
    if (decision.started) {
      this.userSpeaking = true;
      this.stopFiller();
      this.send({
        type: "input.speech_started",
        provider: "gateway",
        ...(decision.probability === undefined ? {} : { probability: decision.probability }),
      });
    }
    for (const frame of decision.forward) {
      if (this.closing) return;
      await this.forwardRealtimeClientInput(
        "audio",
        () => this.liveSession!.sendRealtimeAudio({ data: frame.data, mimeType: frame.mimeType }),
      );
    }
    if (decision.stopped) {
      this.handleConfirmedSpeechStopped();
    }
  }

  private handleConfirmedSpeechStopped(): void {
    if (this.closing) return;
    this.userSpeaking = false;
    this.send({ type: "input.speech_stopped", provider: "gateway" });
    this.scheduleNotificationFlush();
  }

  private emitFillerSpeech(message: FillerEmit): void {
    if (this.closing) return;
    if (message.kind === "transcript") {
      this.send({ type: "transcript.delta", speaker: "assistant", text: message.text, final: true });
      return;
    }
    this.send({ type: "audio.output", data: message.data, mimeType: message.mimeType });
  }

  /**
   * Filler clips may speak only into genuine dead air: never over the user,
   * a live provider response, or a pending announcement handoff. Tool-wait
   * sequences additionally require an outstanding tool response; sequences
   * armed by a provider error are the exception (the tool state is exactly
   * what cannot be trusted then).
   */
  private fillerSpeechAllowed(): boolean {
    if (
      this.closing ||
      this.userSpeaking ||
      this.providerResponseActive ||
      this.providerTurnResponseExpected ||
      this.notificationResponsePending
    ) {
      return false;
    }
    return this.fillerSequenceForProvider
      || this.providerToolResponsePending()
      || this.hasUndeliveredDeferredAnswers();
  }

  private hasUndeliveredDeferredAnswers(): boolean {
    for (const record of this.deferredAnswers.values()) {
      if (!record.delivered) return true;
    }
    return false;
  }

  private hasReadyDeferredAnswers(): boolean {
    for (const record of this.deferredAnswers.values()) {
      if (!record.delivered && record.speech !== undefined) return true;
    }
    return false;
  }

  private stopFiller(): void {
    this.fillerSequenceForProvider = false;
    this.filler?.stop();
    this.speechMux?.abort();
  }

  /** Downlink-active covers provider speech, expected responses, fillers, and sidecar speech. */
  private downlinkActiveForGate(): boolean {
    return this.providerResponseActive
      || this.providerTurnResponseExpected
      || (this.filler?.active ?? false)
      || (this.speechMux?.speaking ?? false);
  }

  /**
   * True while any provider tool call has not yet delivered its output: the
   * local speech runtime fails a new turn in that window ("Cannot generate a
   * response while function call outputs are pending") and drops the session,
   * so the gateway holds user turns until the tool result lands.
   */
  private providerToolResponsePending(): boolean {
    for (const record of this.providerToolCalls.values()) {
      if (!record.cancelled && record.responseDelivery !== "sent") return true;
    }
    return false;
  }

  private shouldHoldSessionInput(): boolean {
    return this.heldInputFlushQueued || this.heldInputs.length > 0 || this.providerToolResponsePending();
  }

  private holdAudioInput(data: string, mimeType: string): void {
    // With a speech gate, held frames still run through it: the gateway hears
    // the user during tool waits (barge-in, filler stop), and the gate's
    // forward output (preroll included) is what gets buffered for the flush.
    if (this.speechGate && isPcmMimeType(mimeType)) {
      void this.ingestHeldAudio(data, mimeType);
      return;
    }
    this.pushHeldAudio(data, mimeType);
    this.userSpeaking = true;
  }

  private async ingestHeldAudio(data: string, mimeType: string): Promise<void> {
    const gate = this.speechGate!;
    gate.setDownlinkActive(this.downlinkActiveForGate());
    const decision = await gate.ingest({ data, mimeType });
    if (this.closing) return;
    if (decision.started) {
      this.userSpeaking = true;
      this.stopFiller();
      this.send({
        type: "input.speech_started",
        provider: "gateway",
        ...(decision.probability === undefined ? {} : { probability: decision.probability }),
      });
    }
    for (const frame of decision.forward) {
      this.pushHeldAudio(frame.data, frame.mimeType, true);
    }
    if (decision.stopped) {
      this.userSpeaking = false;
      this.send({ type: "input.speech_stopped", provider: "gateway" });
      this.scheduleNotificationFlush();
    }
  }

  private pushHeldAudio(data: string, mimeType: string, preGated = false): void {
    const samples = Buffer.from(data, "base64").length / 2;
    const frameMs = samples * 1_000 / requirePcmSampleRate(mimeType);
    this.heldInputs.push({ kind: "audio", data, mimeType, ...(preGated ? { preGated: true } : {}) });
    this.heldAudioMs += frameMs;
    while (
      this.heldInputs.length > 1
      && (this.heldAudioMs > MAX_HELD_AUDIO_MS || this.heldInputs.length > MAX_HELD_INPUTS)
    ) {
      const dropped = this.heldInputs.shift();
      if (!dropped || dropped.kind !== "audio") break;
      const droppedSamples = Buffer.from(dropped.data, "base64").length / 2;
      this.heldAudioMs = Math.max(0, this.heldAudioMs - droppedSamples * 1_000 / requirePcmSampleRate(dropped.mimeType));
    }
  }

  private holdTextInput(text: string): void {
    this.heldInputs.push({ kind: "text", text });
    while (this.heldInputs.length > MAX_HELD_INPUTS && this.heldInputs.length > 1) {
      const dropped = this.heldInputs.shift();
      if (!dropped || dropped.kind !== "audio") break;
      const droppedSamples = Buffer.from(dropped.data, "base64").length / 2;
      this.heldAudioMs = Math.max(0, this.heldAudioMs - droppedSamples * 1_000 / requirePcmSampleRate(dropped.mimeType));
    }
  }

  private maybeReleaseHeldInputs(): void {
    if (this.closing || this.heldInputs.length === 0 || this.heldInputFlushQueued) return;
    if (this.providerToolResponsePending()) return;
    this.heldInputFlushQueued = true;
    const drain = async () => {
      if (this.closing) {
        this.heldInputs = [];
        this.heldAudioMs = 0;
        return;
      }
      const held = this.heldInputs;
      this.heldInputs = [];
      this.heldAudioMs = 0;
      try {
      for (const input of held) {
        if (this.closing) return;
        if (input.kind === "text") {
          await this.forwardRealtimeClientInput("text", () => this.liveSession!.sendText(input.text), true);
          continue;
        }
        if (input.kind === "audio_end") {
          this.userSpeaking = false;
          await this.forwardRealtimeClientInput("audio turn", async () => {
            if (await this.liveSession!.sendAudioStreamEnd()) this.providerResponseActive = true;
          });
          continue;
        }
        // Pre-gated frames were already scored while held; re-ingesting would
        // duplicate speech events and double-buffer the preroll.
        if (!input.preGated && this.speechGate && isPcmMimeType(input.mimeType)) {
          await this.handleGatedAudioInput({ type: "audio.input", data: input.data, mimeType: input.mimeType });
        } else {
          await this.forwardRealtimeClientInput(
            "audio",
            () => this.liveSession!.sendRealtimeAudio({ data: input.data, mimeType: input.mimeType }),
          );
        }
      }
      } catch (error) {
        if (!this.closing) {
          this.deps.logger.error("held session input flush failed", {
            sessionId: this.id,
            error: errorToMessage(error),
          });
          this.fail("held_input_flush_failed", new Error("Held session input could not be delivered."), false);
          void this.closeClientAfterCleanup(1011, "held input flush failed");
        }
      }
    };
    // Serialized with client frames so held audio never interleaves with live audio.
    this.messageQueue = this.messageQueue.then(() => drain().finally(() => {
      this.heldInputFlushQueued = false;
      // Frames that arrived while draining were held; release them too.
      this.maybeReleaseHeldInputs();
    }), () => {
      this.heldInputFlushQueued = false;
    });
  }

  private failExpiredProviderToolCallReplay(): void {
    this.fail(
      "realtime_tool_call_replay_expired",
      new Error("Realtime provider replayed a completed tool call after its response cache expired."),
      false,
    );
    void this.closeClientAfterCleanup(1011, "realtime tool replay expired");
  }

  private failProviderToolReplayLedgerOverflow(): void {
    this.fail(
      "realtime_tool_replay_ledger_overflow",
      new Error("Realtime provider exceeded the safe lifetime tool-call limit."),
      false,
    );
    void this.closeClientAfterCleanup(1011, "realtime tool replay ledger overflow");
  }

  private dispatchLiveModelEvent(event: LiveModelEvent): void {
    if (this.closing) return;
    try {
      this.handleLiveModelEvent(event);
    } catch (error) {
      this.deps.logger.warn("invalid realtime provider event", { sessionId: this.id, error: errorToMessage(error) });
      this.fail("realtime_provider_event_invalid", new Error("Realtime provider emitted an invalid event."), false);
      void this.closeClientAfterCleanup(1011, "invalid realtime provider event");
    }
  }

  private handleLiveModelEvent(event: LiveModelEvent): void {
    if (event.type === "audio") {
      validateAudioFrame(event.audio.data, event.audio.mimeType, this.deps.config.server.maxAudioBytes);
      const itemId = publicProviderIdentifier(event.audio.itemId);
      const contentIndex = publicContentIndex(event.audio.contentIndex);
      this.send({
        type: "audio.output",
        data: event.audio.data,
        mimeType: event.audio.mimeType,
        ...(itemId ? { itemId } : {}),
        ...(contentIndex === undefined ? {} : { contentIndex }),
      });
      return;
    }
    if (event.type === "text") {
      if (!event.text || event.text.length > MAX_PROVIDER_TRANSCRIPT_CHARS) {
        throw new Error("Realtime provider transcript is empty or exceeds its limit.");
      }
      if ((event.speaker ?? "assistant") === "user" && event.final) {
        this.userSpeaking = false;
        this.scheduleNotificationFlush();
      }
      this.send({
        type: "transcript.delta",
        speaker: event.speaker ?? "assistant",
        text: event.text,
        ...(event.final === undefined ? {} : { final: event.final }),
      });
      return;
    }
    if (event.type === "tool_call") {
      this.enqueueProviderToolCall(event.call);
      return;
    }
    if (event.type === "tool_call_cancelled") {
      this.handleProviderToolCallCancellation(event.callIds);
      return;
    }
    if (event.type === "input_speech_started") {
      this.stopFiller();
      if (!this.speechGate) this.userSpeaking = true;
      const itemId = publicProviderIdentifier(event.itemId);
      const audioStartMs = publicAudioStartMs(event.audioStartMs);
      this.send({
        type: "input.speech_started",
        provider: event.provider,
        ...(itemId ? { itemId } : {}),
        ...(audioStartMs === undefined ? {} : { audioStartMs }),
      });
      return;
    }
    if (event.type === "input_speech_stopped") {
      this.userSpeaking = false;
      // The OpenAI adapter schedules the normal conversational response after
      // this event. Keep completion speech gated during the protocol gap before
      // the provider emits response.created.
      this.providerTurnResponseExpected = true;
      return;
    }
    if (event.status === "started") {
      if (event.scope !== "task_notification") this.providerTurnResponseExpected = false;
      this.providerResponseActive = true;
      this.stopFiller();
      this.speechTiming.noteResponseStarted(event.scope, Date.now());
      const responseId = publicProviderIdentifier(event.responseId);
      this.send({ type: "response.started", ...(responseId ? { responseId } : {}) });
      return;
    }

    this.providerResponseActive = false;
    if (event.scope !== "conversation") this.clearNotificationResponsePending();
    const responseId = publicProviderIdentifier(event.responseId);
    if (event.status === "failed") {
      this.send({
        type: "response.failed",
        ...(responseId ? { responseId } : {}),
        error: "Realtime provider response failed. Check the gateway logs.",
      });
    } else if (event.status === "completed") {
      this.send({ type: "response.completed", ...(responseId ? { responseId } : {}) });
    } else {
      this.send({ type: "response.cancelled", ...(responseId ? { responseId } : {}) });
    }
    this.scheduleNotificationFlush();
  }

  private receiveTaskRecord(record: TaskRecord): void {
    if (this.closing) return;
    if (!this.readySent) {
      this.pendingTaskRecords.set(record.taskId, structuredClone(record));
      return;
    }
    this.dispatchTaskRecord(record);
  }

  private dispatchTaskRecord(record: TaskRecord): void {
    const latestType = record.events.at(-1)?.type;
    const notificationMetadataOnly = latestType === "notification.announced"
      || latestType === "notification.acknowledged";
    if (!notificationMetadataOnly) {
      this.send(projectTaskLifecycle(record));
    }
    const notification = projectTaskNotification(record)
      ?? projectSupersededTaskNotification(record);
    // Announcement ownership is internal metadata. Acknowledgements, however,
    // must be broadcast so every connected client clears the same durable
    // unread item rather than only the client that sent the request.
    if (notification && latestType !== "notification.announced") {
      this.send({
        type: "task.notification",
        taskId: record.taskId,
        sequence: record.sequence,
        occurredAt: record.updatedAt,
        notification,
      });
    }
    if (record.notification.unread && record.notification.announcedAt === undefined && notification) {
      this.pendingNotifications.set(record.taskId, structuredClone(record));
      this.speechTiming.noteAnnouncementPending(record.taskId, Date.now());
    } else {
      this.pendingNotifications.delete(record.taskId);
      this.notificationDeliveryAttempts.delete(record.taskId);
    }
    this.scheduleNotificationFlush();
  }

  private scheduleNotificationFlush(): void {
    if (
      this.closing ||
      !this.readySent ||
      this.notificationFlushRunning ||
      this.notificationResponsePending ||
      this.providerResponseActive ||
      this.providerTurnResponseExpected ||
      this.userSpeaking ||
      this.notificationRetryTimer !== undefined ||
      (this.pendingNotifications.size === 0 && !this.hasReadyDeferredAnswers())
    ) {
      return;
    }
    queueMicrotask(() => {
      void this.flushNotifications();
    });
  }

  private async flushNotifications(force = false): Promise<void> {
    if (
      this.closing ||
      this.notificationFlushRunning ||
      this.notificationResponsePending ||
      !this.liveSession?.sendTaskNotification ||
      !this.ownerId ||
      (!force && (this.providerResponseActive || this.providerTurnResponseExpected || this.userSpeaking))
    ) {
      return;
    }
    const candidates = [...this.pendingNotifications.values()];
    if (candidates.length === 0 && !this.hasReadyDeferredAnswers()) return;
    this.notificationFlushRunning = true;
    // Deferred answers outrank task notifications: the user asked for them
    // and is waiting. One speech response per flush; the loser re-schedules.
    if (this.hasReadyDeferredAnswers()) {
      try {
        if (await this.deliverNextDeferredAnswer(force)) return;
      } finally {
        this.notificationFlushRunning = false;
      }
    }
    if (candidates.length === 0) return;
    this.notificationFlushRunning = true;
    const records: TaskRecord[] = [];
    try {
      for (const candidate of candidates) {
        try {
          const claim = await this.deps.taskSupervisor.claimNotificationAnnouncement(
            this.ownerId,
            candidate.taskId,
            this.id,
          );
          if (claim.claimed) {
            this.claimedNotifications.set(claim.task.taskId, claim.task);
            if (this.closing) {
              this.releaseNotificationClaim(claim.task.taskId);
              continue;
            }
            this.pendingNotifications.delete(candidate.taskId);
            records.push(claim.task);
          } else if (!claim.task.notification.unread || claim.task.notification.announcedAt !== undefined) {
            this.pendingNotifications.delete(candidate.taskId);
          } else {
            // Another owner session currently holds the in-memory lease. Keep
            // the durable item eligible in this session in case that claimant
            // disconnects or its provider handoff fails.
            this.scheduleNotificationRetry(NOTIFICATION_RETRY_BASE_MS);
          }
        } catch (error) {
          this.retryNotification(candidate);
          this.deps.logger.warn("failed to claim task notification announcement", {
            sessionId: this.id,
            taskId: candidate.taskId,
            error: errorToMessage(error),
          });
        }
      }
      if (records.length === 0) return;

      // A claim is asynchronous. Speech or a normal provider response can
      // begin while it is in flight, so recheck immediately before handing an
      // announcement to the provider. Released claims remain unread and can be
      // retried when the conversation becomes idle.
      if (
        this.closing ||
        this.userSpeaking ||
        this.providerResponseActive ||
        this.providerTurnResponseExpected ||
        this.notificationResponsePending
      ) {
        for (const record of records) {
          if (this.claimedNotifications.has(record.taskId)) this.releaseNotificationClaim(record.taskId);
          this.pendingNotifications.set(record.taskId, structuredClone(record));
        }
        return;
      }

      this.notificationResponsePending = true;
      const announcement = notificationDigest(records);
      const context = `[HERMES_LIVE_TASK_EVENT_V1:${this.notificationToken}] ${JSON.stringify({ announcement })}`;
      await withAbortAndDeadline(
        this.liveSession.sendTaskNotification({ context, announcement }),
        this.abort.signal,
        MAX_PROVIDER_IO_WAIT_MS,
        "Realtime provider task notification did not settle before the safety deadline.",
      );
      for (const record of records) {
        this.speechTiming.noteAnnouncementDelivered(record.taskId, Date.now());
      }
      for (const record of records) {
        try {
          await this.deps.taskSupervisor.completeNotificationAnnouncement(
            this.ownerId,
            record.taskId,
            this.id,
          );
          this.claimedNotifications.delete(record.taskId);
          this.notificationDeliveryAttempts.delete(record.taskId);
        } catch (error) {
          this.releaseNotificationClaim(record.taskId);
          if (!this.closing) {
            // Provider delivery succeeded, but without the durable marker a
            // restart cannot distinguish this from an unsent notification.
            // Preserve at-least-once delivery and retry within the same
            // bounded budget instead of silently waiting for a reconnect.
            this.retryNotification(record);
            this.deps.logger.warn("failed to persist task notification announcement", {
              sessionId: this.id,
              taskId: record.taskId,
              error: errorToMessage(error),
            });
          }
        }
      }
      // A mock or fast provider can emit completion before the send promise
      // settles. In that case the event handler already cleared this flag and
      // no stale watchdog should be armed.
      if (this.notificationResponsePending) this.armNotificationResponseWatchdog();
    } catch (error) {
      this.notificationResponsePending = false;
      for (const record of records) {
        if (!this.claimedNotifications.has(record.taskId)) continue;
        this.releaseNotificationClaim(record.taskId);
        this.retryNotification(record);
      }
      if (!this.closing) {
        this.deps.logger.warn("task notification speech delivery failed", {
          sessionId: this.id,
          error: errorToMessage(error),
        });
      }
    } finally {
      this.notificationFlushRunning = false;
    }
  }

  private releaseNotificationClaim(taskId: string): void {
    if (!this.claimedNotifications.delete(taskId) || !this.ownerId) return;
    try {
      this.deps.taskSupervisor.releaseNotificationAnnouncement(this.ownerId, taskId, this.id);
    } catch (error) {
      if (!this.closing) {
        this.deps.logger.warn("failed to release task notification announcement claim", {
          sessionId: this.id,
          taskId,
          error: errorToMessage(error),
        });
      }
    }
  }

  private retryNotification(record: TaskRecord): void {
    if (this.closing) return;
    const attempt = (this.notificationDeliveryAttempts.get(record.taskId) ?? 0) + 1;
    if (attempt >= MAX_NOTIFICATION_DELIVERY_ATTEMPTS) {
      this.notificationDeliveryAttempts.delete(record.taskId);
      // Stop automatic retries for this live session while leaving the durable
      // unread inbox item untouched. A reconnect receives a fresh snapshot and
      // may try again with a fresh bounded budget.
      this.pendingNotifications.delete(record.taskId);
      this.speechTiming.forgetAnnouncement(record.taskId);
      return;
    }
    this.notificationDeliveryAttempts.set(record.taskId, attempt);
    this.pendingNotifications.set(record.taskId, structuredClone(record));
    this.scheduleNotificationRetry(NOTIFICATION_RETRY_BASE_MS * (2 ** (attempt - 1)));
  }

  /**
   * Deadline watch for pending speech: once an answer or announcement has
   * waited past announceMaxDelayMs, deliver it at the next gap where the user
   * is not speaking and the provider is not mid-response — overriding the
   * strict idle gate (which a stale expected-turn flag can wedge forever).
   */
  private armAnnouncementDeadlineWatch(): void {
    if (this.announcementDeadlineTimer !== undefined) return;
    this.announcementDeadlineTimer = setInterval(() => {
      if (this.closing) return;
      const now = Date.now();
      const maxDelayMs = this.deps.config.hermes.announceMaxDelayMs ?? DEFAULT_ANNOUNCE_MAX_DELAY_MS;
      const agedAnswer = [...this.deferredAnswers.values()].some(
        (record) => !record.delivered && record.speech !== undefined && now - (record.readyAt ?? record.startedAt) > maxDelayMs,
      );
      const agedNotification = [...this.pendingNotifications.values()].some(
        (record) => now - record.updatedAt > maxDelayMs,
      );
      if (!agedAnswer && !agedNotification) return;
      if (this.userSpeaking || this.providerResponseActive || this.notificationResponsePending || this.notificationFlushRunning) return;
      if (this.notificationRetryTimer !== undefined) {
        clearTimeout(this.notificationRetryTimer);
        this.notificationRetryTimer = undefined;
      }
      void this.flushNotifications(true);
    }, ANNOUNCEMENT_DEADLINE_CHECK_MS);
    this.announcementDeadlineTimer.unref?.();
  }

  private scheduleNotificationRetry(delayMs: number): void {
    if (this.closing || this.notificationRetryTimer !== undefined) return;
    this.notificationRetryTimer = setTimeout(() => {
      this.notificationRetryTimer = undefined;
      // A claim batch can legitimately outlive the backoff (for example when
      // the serialized store is busy). Do not consume the only wake-up while
      // that batch still owns the flush loop.
      if (this.notificationFlushRunning) {
        this.scheduleNotificationRetry(NOTIFICATION_RETRY_BASE_MS);
        return;
      }
      this.scheduleNotificationFlush();
    }, delayMs);
    this.notificationRetryTimer.unref?.();
  }

  private async forwardRealtimeClientInput(
    label: string,
    operation: () => Promise<void>,
    beginsResponse = false,
  ): Promise<void> {
    if (beginsResponse) this.providerResponseActive = true;
    try {
      await withAbortAndDeadline(
        operation(),
        this.abort.signal,
        MAX_PROVIDER_IO_WAIT_MS,
        `Realtime provider ${label} input did not settle before the safety deadline.`,
      );
    } catch (error) {
      if (beginsResponse) this.providerResponseActive = false;
      if (this.closing) return;
      this.deps.logger.warn("realtime provider rejected client input", {
        sessionId: this.id,
        input: label,
        error: errorToMessage(error),
      });
      this.fail("realtime_provider_input_failed", new Error(`Realtime provider could not confirm ${label} input.`), false);
      await this.closeClientAfterCleanup(1011, "realtime provider input failed");
    }
  }

  private async cancelRealtimeResponse(reason?: string, truncate?: RealtimeResponseTruncation): Promise<void> {
    try {
      const cancelled = await withDeadline(
        Promise.resolve(this.liveSession?.cancelResponse(reason, truncate) ?? false),
        MAX_PROVIDER_CANCEL_WAIT_MS,
        "Realtime response cancellation did not settle before the safety deadline.",
      );
      if (!this.closing) {
        this.send({
          type: "log",
          level: cancelled ? "info" : "debug",
          message: cancelled ? "Realtime response cancellation requested" : "No active realtime response to cancel",
        });
      }
    } catch (error) {
      if (!this.closing) {
        this.deps.logger.warn("failed to cancel realtime response", {
          sessionId: this.id,
          error: errorToMessage(error),
        });
        this.send({ type: "log", level: "warn", message: "Realtime response cancellation failed" });
      }
    }
  }

  private async performClose(): Promise<void> {
    this.stopFiller();
    if (this.deferredAnswerEscalationTimer !== undefined) {
      clearTimeout(this.deferredAnswerEscalationTimer);
      this.deferredAnswerEscalationTimer = undefined;
    }
    if (this.announcementDeadlineTimer !== undefined) {
      clearInterval(this.announcementDeadlineTimer);
      this.announcementDeadlineTimer = undefined;
    }
    this.deferredAnswers.clear();
    this.unsubscribeTasks?.();
    this.unsubscribeTasks = undefined;
    this.pendingTaskRecords.clear();
    this.speechGate?.reset();
    this.speechGate = undefined;
    this.heldInputs = [];
    this.heldAudioMs = 0;
    this.heldInputFlushQueued = false;
    if (this.notificationRetryTimer !== undefined) {
      clearTimeout(this.notificationRetryTimer);
      this.notificationRetryTimer = undefined;
    }
    for (const taskId of [...this.claimedNotifications.keys()]) this.releaseNotificationClaim(taskId);
    this.pendingNotifications.clear();
    this.notificationDeliveryAttempts.clear();
    this.clearNotificationResponsePending();
    this.providerToolOperations.length = 0;
    this.abort.abort(new Error("Voice session detached."));

    const operations: Promise<unknown>[] = [];
    if (this.liveSession) operations.push(this.closeProvider(this.liveSession));
    if (this.pendingLiveConnect) {
      const connect = this.pendingLiveConnect;
      this.pendingLiveConnect = undefined;
      const closeLateSession = connect
        .then((session) => this.closeProvider(session))
        .catch(() => undefined);
      // Some provider SDKs cannot cancel a handshake already in flight. Keep
      // the late-close continuation attached, but do not let that raw promise
      // make gateway shutdown unbounded.
      operations.push(withDeadline(
        closeLateSession,
        MAX_PROVIDER_CLOSE_WAIT_MS,
        "Pending realtime provider connection did not settle before the close deadline.",
      ).catch((error) => {
        this.deps.logger.error("failed to confirm pending realtime provider closure", {
          sessionId: this.id,
          error: errorToMessage(error),
        });
      }));
    }
    await Promise.allSettled(operations);
  }

  private async closeProvider(session: LiveModelSession): Promise<void> {
    await withDeadline(
      Promise.resolve().then(() => session.close()),
      MAX_PROVIDER_CLOSE_WAIT_MS,
      "Realtime provider did not confirm closure before the safety deadline.",
    ).catch((error) => {
      this.deps.logger.error("failed to confirm realtime provider closure", {
        sessionId: this.id,
        error: errorToMessage(error),
      });
    });
  }

  private async closeClientAfterCleanup(code: number, reason: string): Promise<void> {
    await this.close();
    this.client.close(code, reason);
  }

  private send(message: ServerMessage): void {
    if (this.closing && message.type !== "session.error") return;
    if (message.type === "audio.output") this.recordAudioOutput();
    this.client.sendText(serverMessage(message));
  }

  private recordAudioOutput(): void {
    const now = Date.now();
    if (this.lastAudioSendAt > 0) {
      const gap = now - this.lastAudioSendAt;
      // Inter-frame gaps only; long pauses between responses are not jitter.
      if (gap > 0 && gap <= 10_000) {
        this.audioGapSamples[this.audioGapNext] = gap;
        this.audioGapNext = (this.audioGapNext + 1) % this.audioGapSamples.length;
        if (this.audioGapLength < this.audioGapSamples.length) this.audioGapLength += 1;
      }
    }
    this.lastAudioSendAt = now;
    this.lastAudioOutputAt = now;
  }

  /**
   * Server-side audio delivery telemetry consumed by GET /v1/metrics: how long
   * ago this session last emitted TTS audio, and the emit cadence of recent
   * audio frames (percentiles over a small rolling window). Compared against
   * the client-observed arrival gaps, this separates "the server fed frames
   * late" from "the network or browser delayed them".
   */
  audioDeliveryMetrics(now = Date.now()): {
    lastOutputMsAgo: number | null;
    gapP50Ms: number | null;
    gapP95Ms: number | null;
  } {
    const lastOutputMsAgo = this.lastAudioOutputAt > 0 ? Math.max(0, now - this.lastAudioOutputAt) : null;
    if (this.audioGapLength === 0) return { lastOutputMsAgo, gapP50Ms: null, gapP95Ms: null };
    const sorted = Array.from(this.audioGapSamples.subarray(0, this.audioGapLength)).sort((a, b) => a - b);
    const percentile = (quantile: number) => sorted[Math.min(sorted.length - 1, Math.floor(quantile * (sorted.length - 1)))];
    return { lastOutputMsAgo, gapP50Ms: percentile(0.5), gapP95Ms: percentile(0.95) };
  }

  /**
   * Speech-wait telemetry consumed by GET /v1/metrics: how long the user
   * waited to hear anything after a tool call began, and how long completed
   * tasks waited before their announcement was spoken.
   */
  speechTimingMetrics(): SpeechTimingMetrics {
    return this.speechTiming.metrics();
  }

  /**
   * Gateway↔provider (s2s) link state for GET /status.json: whether this
   * session's speech pipeline is attached, and when/why it last detached.
   */
  providerLinkStatus(now = Date.now()): {
    state: "starting" | "attached" | "detached";
    provider: string;
    model: string;
    attachedMsAgo: number | null;
    detachedMsAgo: number | null;
    lastDetach: { code?: number; reason: string; msAgo: number } | null;
  } {
    const link = this.providerLink;
    return {
      state: link.state,
      provider: this.deps.config.realtime.provider,
      model: this.deps.config.realtime.model,
      attachedMsAgo: link.attachedAt === undefined ? null : Math.max(0, now - link.attachedAt),
      detachedMsAgo: link.detachedAt === undefined ? null : Math.max(0, now - link.detachedAt),
      lastDetach: link.lastDetach
        ? { ...link.lastDetach, msAgo: Math.max(0, now - link.lastDetach.at) }
        : null,
    };
  }

  private handleClientMessageFailure(error: unknown, requestId?: string): void {
    if (this.closing) return;
    this.clientMessageErrors += 1;
    if (error instanceof PublicTaskOperationError) {
      this.failPublic("client_message_failed", error.message, error.operationCause, false, requestId);
    } else {
      this.fail("client_message_failed", error, false, requestId);
    }
    if (this.clientMessageErrors >= MAX_CLIENT_MESSAGE_ERRORS) {
      void this.closeClientAfterCleanup(1008, "too many invalid client messages");
    }
  }

  private fail(code: string, error: unknown, recoverable = false, requestId?: string): void {
    const message = boundedText(errorToMessage(error), 2_000);
    const safeRequestId = validatedRequestId(requestId);
    this.deps.logger.warn("live session error", { sessionId: this.id, code, message });
    this.send({
      type: "session.error",
      code,
      message,
      recoverable,
      ...(safeRequestId ? { requestId: safeRequestId } : {}),
    });
  }

  private failPublic(
    code: string,
    publicMessage: string,
    operationError: unknown,
    recoverable = false,
    requestId?: string,
  ): void {
    const message = boundedText(publicMessage, 500);
    const safeRequestId = validatedRequestId(requestId);
    this.deps.logger.warn("live session operation failed", {
      sessionId: this.id,
      code,
      error: errorToMessage(operationError),
    });
    this.send({
      type: "session.error",
      code,
      message,
      recoverable,
      ...(safeRequestId ? { requestId: safeRequestId } : {}),
    });
  }

  private runTaskOperation<T>(operation: () => Promise<T>, fallbackMessage: string): Promise<T> {
    return Promise.resolve().then(operation).catch((error) => {
      throw new PublicTaskOperationError(publicTaskOperationMessage(error, fallbackMessage), error);
    });
  }

  private armNotificationResponseWatchdog(): void {
    if (this.notificationResponseTimer) clearTimeout(this.notificationResponseTimer);
    this.notificationResponseTimer = setTimeout(() => {
      this.notificationResponseTimer = undefined;
      this.notificationResponsePending = false;
      this.scheduleNotificationFlush();
    }, MAX_PROVIDER_NOTIFICATION_RESPONSE_WAIT_MS);
    this.notificationResponseTimer.unref?.();
  }

  private clearNotificationResponsePending(): void {
    this.notificationResponsePending = false;
    if (this.notificationResponseTimer) {
      clearTimeout(this.notificationResponseTimer);
      this.notificationResponseTimer = undefined;
    }
  }
}

function startupFailureLogDetail(error: unknown): {
  error: "startup_failed";
  hermesStatus?: number;
  hermesErrorCode?: string;
} {
  const detail: {
    error: "startup_failed";
    hermesStatus?: number;
    hermesErrorCode?: string;
  } = { error: "startup_failed" };
  if (!error || typeof error !== "object" || (error as { name?: unknown }).name !== "HermesRequestError") {
    return detail;
  }
  const status = (error as { status?: unknown }).status;
  if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) {
    detail.hermesStatus = status;
  }
  const errorCode = (error as { errorCode?: unknown }).errorCode;
  if (typeof errorCode === "string" && /^[A-Za-z0-9._-]{1,80}$/u.test(errorCode)) {
    detail.hermesErrorCode = errorCode;
  }
  return detail;
}

function publicConversation(
  mode: "new" | "resume",
  session: HermesSessionSummary,
): PublicConversation {
  return {
    mode,
    sessionId: session.id,
    ...(session.title ? { title: session.title } : {}),
    ...(session.source ? { source: session.source } : {}),
    ...(session.preview !== undefined ? { preview: session.preview } : {}),
    ...(session.lastActive !== undefined ? { lastActiveAt: session.lastActive } : {}),
  };
}

class PublicTaskOperationError extends Error {
  readonly operationCause: unknown;

  constructor(publicMessage: string, operationCause: unknown) {
    super(publicMessage);
    this.name = "PublicTaskOperationError";
    this.operationCause = operationCause;
  }
}

function publicTaskOperationMessage(error: unknown, fallback: string): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "TaskNotFoundError") return "Task not found.";
  if (name === "TaskQueueFullError" || name === "TaskStoreCapacityError") {
    return "The background task queue is full. Wait for retained work to finish or expire.";
  }
  if (name === "TaskSupervisorClosedError") return "The background task supervisor is unavailable.";
  return fallback;
}

function projectTaskList(records: TaskRecord[]): PublicTaskSnapshot[] {
  return records.map((record) => projectTaskSnapshot(record));
}

function mergeTaskRecords(records: TaskRecord[]): TaskRecord[] {
  const newestByTaskId = new Map<string, TaskRecord>();
  for (const record of records) {
    const existing = newestByTaskId.get(record.taskId);
    if (!existing || record.sequence > existing.sequence) newestByTaskId.set(record.taskId, record);
  }
  return [...newestByTaskId.values()].sort(
    (left, right) => right.updatedAt - left.updatedAt || left.taskId.localeCompare(right.taskId),
  );
}

function notificationDigest(records: TaskRecord[]): string {
  const completed = records.filter((record) => record.status === "completed").length;
  const attention = records.length - completed;
  if (records.length === 1 && completed === 1) {
    return "Your background task is finished. The result is ready in the task inbox.";
  }
  if (records.length === 1) {
    return "A background task needs your attention. Open the task inbox for the exact status.";
  }
  if (attention === 0) {
    return `${records.length} background tasks are finished. Their results are ready in the task inbox.`;
  }
  return `${records.length} background tasks have updates: ${completed} finished and ${attention} need attention. Open the task inbox for details.`;
}

function validateAudioFrame(data: string, mimeType: string, maxBytes: number): void {
  if (!mimeType || mimeType.length > 128) throw new Error("Audio frame MIME type is invalid.");
  const decoded = decodeBase64Audio(data, maxBytes);
  if (decoded.length > maxBytes) throw new Error("Audio frame exceeds HERMES_LIVE_MAX_AUDIO_BYTES.");
  if (isPcmMimeType(mimeType)) {
    requirePcmSampleRate(mimeType);
    if (decoded.length % 2 !== 0) throw new Error("PCM16 audio frames must contain an even number of bytes.");
  }
}

function decodeBase64Audio(data: string, maxBytes: number): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(data) || data.length % 4 === 1) {
    throw new Error("Audio frame data must be base64 encoded.");
  }
  if (data.length > Math.ceil((maxBytes * 4) / 3) + 4) {
    throw new Error("Audio frame exceeds HERMES_LIVE_MAX_AUDIO_BYTES.");
  }
  return Buffer.from(data, "base64");
}

function validateText(value: string, maxChars: number, label: string): void {
  if (value.length > maxChars) throw new Error(`${label} exceeds HERMES_LIVE_MAX_TEXT_CHARS.`);
}

function clientInboundFrameBytes(frame: ClientInboundFrame): number {
  return typeof frame === "string" ? Buffer.byteLength(frame, "utf8") : frame.byteLength;
}

function requestIdFromUnknown(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return validatedRequestId((value as { id?: unknown }).id);
}

function validatedRequestId(value: unknown): string | undefined {
  const parsed = RequestIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function isPreemptiveClientControl(message: ClientMessage, sessionReady: boolean): boolean {
  if (message.type === "session.close") return true;
  return sessionReady && ["response.cancel", "task.stop"].includes(message.type);
}

function safetyIdentifierForSessionKey(sessionKey: string): string {
  return createHash("sha256").update(sessionKey).digest("hex");
}

function stringArg(call: LiveToolCall, name: string): string {
  const value = call.args[name];
  return typeof value === "string" ? value.trim() : "";
}

function optionalStringArg(call: LiveToolCall, name: string): string | undefined {
  const value = stringArg(call, name);
  return value || undefined;
}

function booleanArg(call: LiveToolCall, name: string, fallback: boolean): boolean {
  const value = call.args[name];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean.`);
  return value;
}

function executionModeArg(call: LiveToolCall): TaskExecutionMode {
  const value = call.args.execution_mode;
  if (value === undefined) return "exclusive";
  if (value !== "exclusive" && value !== "parallel_read_only") {
    throw new Error("execution_mode must be exclusive or parallel_read_only.");
  }
  return value;
}

function resourceKeysArg(call: LiveToolCall): string[] | undefined {
  const value = call.args.resource_keys;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TOOL_RESOURCE_KEYS) {
    throw new Error(`resource_keys must contain between 1 and ${MAX_TOOL_RESOURCE_KEYS} strings.`);
  }
  const keys = value.map((item) => {
    if (typeof item !== "string" || !item.trim() || item.length > 256 || /[\u0000-\u001f\u007f]/u.test(item)) {
      throw new Error("resource_keys contains an invalid value.");
    }
    return item.trim();
  });
  return [...new Set(keys)];
}

function requireProviderToolCallId(call: LiveToolCall): string {
  if (!call.name || call.name.length > 128 || !/^[A-Za-z0-9_.:-]+$/u.test(call.name)) {
    throw new Error("Realtime provider emitted a tool call with an invalid name.");
  }
  if (!call.id || call.id.length > 256 || /[\u0000-\u001f\u007f]/u.test(call.id)) {
    throw new Error("Realtime provider emitted a tool call without a bounded id.");
  }
  return call.id;
}

function requireProviderToolCancellationId(value: string): string {
  if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("Realtime provider emitted a tool cancellation without a bounded id.");
  }
  return value;
}

function providerToolCallFingerprint(call: LiveToolCall): string {
  let args: string;
  try {
    args = JSON.stringify(call.args);
  } catch {
    throw new Error("Realtime provider tool-call arguments were not serializable.");
  }
  if (Buffer.byteLength(args, "utf8") > MAX_PROVIDER_TOOL_CALL_ARGS_BYTES) {
    throw new Error("Realtime provider tool-call arguments exceeded the safe size limit.");
  }
  return createHash("sha256").update(call.name).update("\0").update(args).digest("hex");
}

function providerToolCallIdDigest(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

function boundedProviderToolResponse(response: Record<string, unknown>): Record<string, unknown> {
  return safeJsonByteLength(response) <= MAX_PROVIDER_TOOL_RESPONSE_BYTES
    ? response
    : { ok: false, error: "Task result exceeded the safe provider response limit." };
}

function taskInboxSpokenSummary(records: readonly TaskRecord[]): string {
  if (records.length === 0) return "Your background task inbox is empty.";
  const finished = records.filter((record) => ["completed", "failed", "cancelled"].includes(record.status)).length;
  const uncertain = records.filter((record) => ["unknown", "dispatch_unknown"].includes(record.status)).length;
  const active = records.length - finished - uncertain;
  const parts: string[] = [];
  if (active > 0) parts.push(`${active === 1 ? "one" : active} background ${active === 1 ? "task is" : "tasks are"} active`);
  if (finished > 0) parts.push(`${finished === 1 ? "one task is" : `${finished} tasks are`} finished in the inbox`);
  if (uncertain > 0) parts.push(`${uncertain === 1 ? "one task has" : `${uncertain} tasks have`} an uncertain state`);
  const sentence = parts.join(", and ");
  return `${sentence[0]!.toUpperCase()}${sentence.slice(1)}.`;
}

function publicHermesCapabilities(
  capabilities: Awaited<ReturnType<HermesRunsPort["capabilities"]>>,
): { model?: string; capabilities?: Record<string, unknown> } {
  const model = boundedDisplayText(capabilities.model, 256);
  const projected: Record<string, unknown> = {};
  const features = capabilities.features;
  if (features && typeof features === "object" && !Array.isArray(features)) {
    for (const key of [
      "run_submission",
      "run_status",
      "run_events_sse",
      "run_stop",
      "run_approval_response",
      "run_approval_response_by_id",
    ]) {
      if (typeof features[key] === "boolean") projected[key] = features[key];
    }
  }
  return {
    ...(model ? { model } : {}),
    ...(Object.keys(projected).length ? { capabilities: projected } : {}),
  };
}

function publicRealtimeStartupError(error: unknown, readyTimeoutMs: number): string {
  const message = errorToMessage(error);
  if (
    message.includes("Realtime provider did not") ||
    message === "Realtime provider session closed before ready." ||
    message === "Realtime provider exceeded the safe pre-ready event queue limit."
  ) {
    return boundedText(message, 500);
  }
  return `Realtime provider session failed to start within ${readyTimeoutMs}ms. Check the gateway logs.`;
}

function providerCloseLogDetail(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const code = (value as Record<string, unknown>).code;
  return typeof code === "number" && Number.isInteger(code) && code >= 1_000 && code <= 4_999
    ? { providerCode: code }
    : {};
}

function publicProviderIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    return undefined;
  }
  return value;
}

function publicContentIndex(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100 ? value : undefined;
}

function publicAudioStartMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 60 * 60 * 1_000
    ? value
    : undefined;
}

function boundedDisplayText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const printable = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  return printable ? printable.slice(0, maximum) : undefined;
}

function boundedText(value: string, maximum: number): string {
  return value.length <= maximum ? value : value.slice(0, maximum);
}

function safeJsonByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), Math.max(1, timeoutMs));
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function withAbortAndDeadline<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
  message: string,
): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort!: (reason?: unknown) => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(signal.reason ?? new DOMException("Aborted", "AbortError"));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([
      promise,
      aborted,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), Math.max(1, timeoutMs));
        timeout.unref?.();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (timeout) clearTimeout(timeout);
  }
}
