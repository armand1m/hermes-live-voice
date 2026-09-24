import { readFile } from "node:fs/promises";
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { cpus, homedir, loadavg } from "node:os";
import type { AddressInfo } from "node:net";
import { basename, dirname } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import {
  assertGatewayExposureConfig,
  assertHermesApiConfig,
  assertRealtimeProviderConfig,
  makeSessionKey,
  type AppConfig,
} from "../../../config.js";
import type { HermesRunsPort } from "../../../application/live-gateway/ports/hermes-runs.port.js";
import type { TaskSupervisorPort } from "../../../application/live-gateway/ports/task-supervisor.port.js";
import { LiveGatewaySession } from "../../../application/live-gateway/live-gateway-session.js";
import { VoiceArbiter } from "../../../application/live-gateway/voice-arbiter.js";
import { TaskSupervisor } from "../../../application/task-supervisor/task-supervisor.js";
import type { LiveModelAdapter } from "../../../application/live-gateway/ports/realtime-model.port.js";
import { HermesClient } from "../../outbound/hermes/hermes-runs.client.js";
import { createLiveModelAdapter } from "../../outbound/realtime/factory.js";
import { sidecarTtsClientFromConfig } from "../../outbound/tts/local-tts.client.js";
import {
  defaultLayaShadowLogPath,
  LayaShadowLog,
  layaShadowRecorderFromConfig,
} from "../../../application/live-gateway/laya-shadow.js";
import { narratorClientFromConfig } from "../../outbound/narrator/narrator-llm.client.js";
import { createTaskNarrationService, type TaskNarrationService } from "../../../application/live-gateway/task-narration.service.js";
import { projectTaskSnapshot } from "../../../application/live-gateway/task-public-projection.js";
import { FileTaskStore } from "../../outbound/task-store/file-task-store.js";
import { FileAgentWatchStore } from "../../outbound/external-work/file-agent-watch-store.js";
import { HerdrExternalAgentAdapter } from "../../outbound/external-work/herdr-external-agent.adapter.js";
import { ExternalAgentMonitor, type ExternalMonitorEvent } from "../../../application/external-work/external-agent-monitor.js";
import { DelegationService } from "../../../application/external-work/delegation.service.js";
import { HerdrExternalLaunchAdapter } from "../../outbound/external-work/herdr-external-launch.adapter.js";
import type { Logger } from "../../../logger.js";
import { buildReadinessReport } from "../../../readiness.js";
import { WebSocketClientConnection } from "./websocket-client-connection.js";
import { createGatewayMetricsCollector, type GatewayMetricsCollector } from "./gateway-metrics.js";
import { errorToMessage } from "../../../domain/error-message.js";
import {
  HERMES_LIVE_PROTOCOL_VERSION,
  HERMES_LIVE_SUPPORTED_PROTOCOL_VERSIONS,
} from "../../../domain/protocol/version.js";
import { realtimeClientCapabilities } from "../../../application/live-gateway/client-capabilities.js";
import { negotiateHermesApprovalCompatibility } from "../../../application/live-gateway/hermes-approval-compatibility.js";
import { createSpeechDetectionService, type SpeechDetectionService } from "../../../application/live-gateway/vad/detection-service.js";
import { HERMES_LIVE_SERVICE_ID } from "../../../service-identity.js";

const SERVER_SESSION_CLOSE_TIMEOUT_MS = 6_000;
const SERVER_WEBSOCKET_CLOSE_GRACE_MS = 250;
const SERVER_WEBSOCKET_FORCE_WAIT_MS = 1_000;
const SERVER_HTTP_CLOSE_TIMEOUT_MS = 2_000;

export interface StartServerOptions {
  config: AppConfig;
  logger: Logger;
  hermes?: HermesRunsPort;
  liveModel?: LiveModelAdapter;
  taskSupervisor?: TaskSupervisorRuntime;
  speechDetection?: SpeechDetectionService;
  narration?: TaskNarrationService;
  /** Overrides the config-built monitor (tests inject a fake agent port). */
  externalMonitor?: ExternalAgentMonitor;
  /** Overrides the config-built delegation bridge (tests inject fakes). */
  delegations?: Pick<DelegationService, "delegate">;
  signal?: AbortSignal;
}

export interface TaskSupervisorRuntime extends TaskSupervisorPort {
  initialize(): Promise<void>;
  close(): Promise<void>;
  health(): Promise<void>;
}

export async function startServer({
  config,
  logger,
  hermes: providedHermes,
  liveModel: providedLiveModel,
  taskSupervisor: providedTaskSupervisor,
  speechDetection: providedSpeechDetection,
  narration: providedNarration,
  externalMonitor: providedExternalMonitor,
  delegations: providedDelegations,
  signal,
}: StartServerOptions): Promise<{
  close(): Promise<void>;
  url: string;
}> {
  assertGatewayExposureConfig(config);
  if (!providedHermes) {
    assertHermesApiConfig(config);
  }
  if (!providedLiveModel) {
    assertRealtimeProviderConfig(config);
  }
  const hermes = providedHermes ?? new HermesClient(config.hermes);
  const liveModel = providedLiveModel ?? createLiveModelAdapter(config);
  const speechSink = sidecarTtsClientFromConfig(config);
  // LAYA System-1 shadow pilot: undefined (fully inert) unless HERMES_LIVE_LAYA_URL
  // is set and shadow logging is enabled. Log-only; never gates behavior.
  const layaShadow = layaShadowRecorderFromConfig(
    config,
    new LayaShadowLog({ filePath: defaultLayaShadowLogPath(homedir()), logger }),
    logger,
  );
  const speechDetection = providedSpeechDetection ?? createSpeechDetectionService(config, logger);
  const narrationClient = narratorClientFromConfig(config);
  const narration = providedNarration ?? (narrationClient
    ? createTaskNarrationService({ client: narrationClient })
    : undefined);
  const taskSupervisor = providedTaskSupervisor ?? new TaskSupervisor({
    store: new FileTaskStore({
      directory: dirname(config.tasks.stateFile),
      filename: basename(config.tasks.stateFile),
      maxRecords: config.tasks.historyLimit + config.tasks.maxConcurrent + config.tasks.maxQueued,
      retentionMs: config.tasks.retentionMs,
      terminalReserveSlots: config.tasks.maxConcurrent,
    }),
    hermes,
    maxConcurrent: config.tasks.maxConcurrent,
    trustDeclaredReadOnly: config.tasks.trustDeclaredReadOnly === true,
    maxQueued: config.tasks.maxQueued,
    pollIntervalMs: config.tasks.pollIntervalMs,
    ...(config.hermes.instructions ? { runInstructions: config.hermes.instructions } : {}),
    onError: (error) => logger.error("background task supervisor error", { error: errorToMessage(error) }),
  });
  // External-work monitor (plan §B): inert unless HERMES_LIVE_EXTERNAL_WORK_ENABLED.
  // It owns durable observation of harness agents on the fixed hosts and runs
  // independently of the Hermes implementation queue — a status poll on the
  // Mac mini never waits behind code-changing work.
  // An injected monitor is trusted (tests); only the config-built path
  // requires the explicit HERMES_LIVE_EXTERNAL_WORK_ENABLED flag.
  const externalWork = config.externalWork;
  const externalMonitor = providedExternalMonitor ?? (externalWork?.enabled
    ? new ExternalAgentMonitor({
        store: new FileAgentWatchStore({ directory: dirname(config.tasks.stateFile) }),
        agents: new HerdrExternalAgentAdapter({
          herdrExecutable: externalWork.herdrExecutable,
          msshExecutable: externalWork.msshExecutable,
          localHost: "exodia",
          remoteHost: "mac-mini",
        }),
        onError: (error) => logger.error("external work monitor error", { error: errorToMessage(error) }),
      })
    : undefined);
  const delegations = providedDelegations ?? (externalWork?.enabled && externalMonitor
    ? new DelegationService({
        launches: new HerdrExternalLaunchAdapter({
          agentAdapter: new HerdrExternalAgentAdapter({
            herdrExecutable: externalWork.herdrExecutable,
            msshExecutable: externalWork.msshExecutable,
            localHost: "exodia",
            remoteHost: "mac-mini",
          }),
        }),
        monitor: externalMonitor,
        onError: (error) => logger.error("delegation error", { error: errorToMessage(error) }),
      })
    : undefined);
  const defaultSessionKey = makeSessionKey(
    config.server.sessionPrefix,
    config.server.defaultProfileId,
    config.server.defaultUserLabel,
  );
  type StartupTaskCloseResult =
    | { ok: true }
    | { ok: false; error: unknown };
  let startupAbortClose: Promise<StartupTaskCloseResult> | undefined;
  const closeTaskStateForAbort = () => {
    if (!startupAbortClose) {
      // Always settle this promise. The abort listener can run while
      // initialize() is still pending, so rethrowing here would briefly leave
      // a rejected promise without a handler. The startup path inspects and
      // propagates the captured cleanup failure before it rejects.
      startupAbortClose = Promise.resolve().then(() => taskSupervisor.close()).then(
        () => ({ ok: true }),
        (error) => {
          logger.error("failed to close task supervisor during startup cleanup", {
            error: errorToMessage(error),
          });
          return { ok: false, error };
        },
      );
    }
    return startupAbortClose;
  };
  if (signal?.aborted) closeTaskStateForAbort();
  else signal?.addEventListener("abort", closeTaskStateForAbort, { once: true });
  // The owner id the HTTP narration route uses to resolve task records;
  // sessions register the same key, so they share one task inbox.
  let defaultOwnerId = "";
  try {
    if (signal?.aborted) throw startupAbortError(signal);
    defaultOwnerId = taskSupervisor.registerOwner(defaultSessionKey, defaultSessionKey);
    await taskSupervisor.initialize();
    if (signal?.aborted) throw startupAbortError(signal);
  } catch (error) {
    signal?.removeEventListener("abort", closeTaskStateForAbort);
    const closeResult = await closeTaskStateForAbort();
    if (!closeResult.ok) {
      throw startupCleanupError(signal?.aborted ? startupAbortError(signal) : error, closeResult.error);
    }
    if (signal?.aborted) throw startupAbortError(signal);
    throw error;
  }
  if (externalMonitor) {
    // One gateway-level subscription: verified external observations flow into
    // the linked task's retained progress log regardless of which (or whether
    // any) voice session is connected.
    externalMonitor.subscribe((event) => {
      const taskId = event.watch.linkedTaskId;
      if (!taskId) return;
      if (event.kind === "registered" || event.kind === "stopped") return;
      const observation = event.watch.lastObserved;
      const evidence = observation?.excerpt ? ` Last output: ${observation.excerpt.slice(0, 180)}` : "";
      void taskSupervisor.noteExternalObservation(
        event.watch.ownerId,
        taskId,
        `External agent on ${event.watch.host} (${event.watch.paneId}): ${observationSummaryPhrase(event)}${evidence}`,
      ).catch(() => undefined);
    });
    await externalMonitor.initialize();
  }
  const sessions = new Set<LiveGatewaySession>();
  // Process/host signals for the browser diagnostics overlay (GET /v1/metrics).
  const metrics = createGatewayMetricsCollector();

  const server = createServer(async (req, res) => {
    try {
      await handleHttp(req, res, {
        config,
        hermes,
        taskSupervisor,
        taskOwnerId: defaultOwnerId,
        taskOwnerIdentity: defaultSessionKey,
        narration,
        ...(delegations ? { delegations } : {}),
        logger,
        sessions,
        metrics,
        requireHermesApiKey: !providedHermes,
        requireRealtimeProviderConfig: !providedLiveModel,
      });
    } catch (error) {
      const message = errorToMessage(error);
      logger.error("http handler failed", { error: message });
      json(req, res, 500, { status: "error", error: "Internal server error." });
    }
  });

  const voiceArbiter = new VoiceArbiter();
  const wss = new WebSocketServer({ noServer: true, maxPayload: clientWebSocketMaxPayload(config) });
  server.on("upgrade", (req, socket, head) => {
    let url: URL;
    try {
      url = parseRequestTarget(req.url);
      if (!parseHttpHost(req.headers.host, "http:")) {
        throw new TypeError("Invalid Host header");
      }
    } catch {
      rejectMalformedUpgrade(socket);
      return;
    }
    if (url.pathname !== "/v1/live") {
      socket.destroy();
      return;
    }
    if (!isWebSocketOriginAllowed(req, config)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!isAuthorized(req, config, url, { allowQueryToken: true })) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    if (sessions.size >= config.server.maxSessions) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nRetry-After: 5\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      armClientKeepalive(ws, config.server.wsKeepaliveMs, logger);
      const session = new LiveGatewaySession(new WebSocketClientConnection(ws), {
        config,
        hermes,
        liveModel,
        taskSupervisor,
        logger,
        speechDetection,
        ...(speechSink ? { speechSink } : {}),
        ...(layaShadow ? { layaShadow } : {}),
        voiceArbiter,
        ...(externalMonitor ? { externalMonitor } : {}),
      });
      sessions.add(session);
      ws.once("close", () => {
        void session.close()
          .catch((error) => {
            logger.error("live session cleanup failed", {
              error: errorToMessage(error),
            });
          })
          .finally(() => sessions.delete(session));
      });
      session.bind();
      wss.emit("connection", ws, req);
    });
  });

  try {
    await listenHttpServer(server, config.server.port, config.server.host);
  } catch (error) {
    signal?.removeEventListener("abort", closeTaskStateForAbort);
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    const closeResult = await closeTaskStateForAbort();
    if (!closeResult.ok) throw startupCleanupError(error, closeResult.error);
    throw error;
  }
  if (signal?.aborted) {
    signal.removeEventListener("abort", closeTaskStateForAbort);
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await closeHttpServer(server);
    const closeResult = await closeTaskStateForAbort();
    if (!closeResult.ok) throw startupCleanupError(startupAbortError(signal), closeResult.error);
    throw startupAbortError(signal);
  }
  signal?.removeEventListener("abort", closeTaskStateForAbort);
  const address = server.address() as AddressInfo | null;
  const port = address?.port ?? config.server.port;
  const url = `http://${config.server.host}:${port}`;
  logger.info("hermes-live listening", { url });

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (!closePromise) {
      closePromise = (async () => {
        // Stop accepting HTTP requests and WebSocket upgrades before waiting
        // for any client/provider cleanup.
        const httpClosing = closeHttpServer(server);
        metrics.stop();
        // Session cleanup may take several seconds. Attach a rejection handler
        // immediately so an early server.close callback error cannot surface as
        // an unhandled rejection before the ordered aggregation below awaits it.
        void httpClosing.catch(() => undefined);
        const shutdownFailures: unknown[] = [];
        try {
          server.closeIdleConnections();
        } catch (error) {
          shutdownFailures.push(error);
        }
        try {
          const sessionResults = await Promise.allSettled(Array.from(sessions, (session) => withServerDeadline(
            session.close(),
            SERVER_SESSION_CLOSE_TIMEOUT_MS,
            "Live session did not close before the server shutdown deadline.",
          )));
          for (const result of sessionResults) {
            if (result.status === "rejected") shutdownFailures.push(result.reason);
          }
        } catch (error) {
          shutdownFailures.push(error);
        }
        try {
          await closeWebSocketServer(wss);
        } catch (error) {
          shutdownFailures.push(error);
        }
        try {
          server.closeAllConnections();
        } catch (error) {
          shutdownFailures.push(error);
        }
        try {
          await withServerDeadline(
            httpClosing,
            SERVER_HTTP_CLOSE_TIMEOUT_MS,
            "HTTP server did not close before the shutdown deadline.",
          );
        } catch (error) {
          shutdownFailures.push(error);
        }
        for (const client of wss.clients) {
          try {
            client.terminate();
          } catch (error) {
            shutdownFailures.push(error);
          }
        }
        try {
          server.closeAllConnections();
        } catch (error) {
          shutdownFailures.push(error);
        }
        // Task-state ownership must be released even when transport teardown
        // reports an error; otherwise a normal shutdown can look like a crash.
        try {
          await taskSupervisor.close();
        } catch (error) {
          shutdownFailures.push(error);
        }
        try {
          await externalMonitor?.close();
        } catch (error) {
          shutdownFailures.push(error);
        }
        if (shutdownFailures.length === 1) throw shutdownFailures[0];
        if (shutdownFailures.length > 1) {
          throw new AggregateError(
            shutdownFailures,
            "Hermes Live server shutdown encountered multiple cleanup failures.",
          );
        }
      })();
    }
    return closePromise;
  };

  return {
    url,
    close,
  };
}

const DELEGATION_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/u;
const DELEGATION_REPOSITORY_PATTERN = /^\/[^ -]{0,500}$/u;

function parseDelegationRequest(body: Record<string, unknown>):
  | { ok: true; value: {
      idempotencyKey: string;
      host: "exodia" | "mac-mini";
      harness: "herdr";
      agentKind: string;
      repository: string;
      objective: string;
      acceptanceCriteria: string[];
      linkedTaskId?: string;
    } }
  | { ok: false; error: string } {
  const idempotencyKey = typeof body.idempotency_key === "string" ? body.idempotency_key : "";
  if (!DELEGATION_IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return { ok: false, error: "idempotency_key must be 8-128 chars of letters, digits, :, -, ., or _." };
  }
  const host = body.host;
  if (host !== "exodia" && host !== "mac-mini") {
    return { ok: false, error: "host must be exodia or mac-mini." };
  }
  const repository = typeof body.repository === "string" ? body.repository : "";
  if (!DELEGATION_REPOSITORY_PATTERN.test(repository)) {
    return { ok: false, error: "repository must be an absolute path on that host." };
  }
  const objective = typeof body.objective === "string" ? body.objective.trim() : "";
  if (!objective || objective.length > 4_000) {
    return { ok: false, error: "objective must be 1-4000 characters." };
  }
  const agentKind = typeof body.agent_kind === "string" && /^[a-z][a-z0-9_-]{0,31}$/u.test(body.agent_kind)
    ? body.agent_kind
    : "claude";
  const acceptanceCriteria = Array.isArray(body.acceptance_criteria)
    ? body.acceptance_criteria
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim().slice(0, 500))
        .slice(0, 8)
    : [];
  const linkedTaskId = typeof body.task_id === "string" ? body.task_id : undefined;
  if (linkedTaskId !== undefined && !TASK_ID_PATTERN.test(linkedTaskId)) {
    return { ok: false, error: "task_id must be a task id." };
  }
  return {
    ok: true,
    value: {
      idempotencyKey,
      host,
      harness: "herdr",
      agentKind,
      repository,
      objective,
      acceptanceCriteria: acceptanceCriteria.length > 0 ? acceptanceCriteria : ["Outcome inspected by the owner."],
      ...(linkedTaskId !== undefined ? { linkedTaskId } : {}),
    },
  };
}

/** Honest one-line phrase for a linked task's progress log; never claims completion. */
function observationSummaryPhrase(event: ExternalMonitorEvent): string {
  const state = event.watch.lastObserved?.state;
  switch (event.kind) {
    case "offline":
      return "host unreachable; observations are stale.";
    case "recovered":
      return `host reachable again; the agent is ${state ?? "observed"}.`;
    case "mismatched":
      return "the pane now runs a different session; the watch needs attention.";
    default:
      return `is ${state ?? "observed"}${event.kind === "output-evidence" ? " with new output" : ""}.`;
  }
}

function startupAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Hermes Live startup was aborted before the server became ready.");
}

function startupCleanupError(startupError: unknown, cleanupError: unknown): AggregateError {
  return new AggregateError(
    [startupError, cleanupError],
    `Hermes Live startup failed and task-state cleanup also failed: ${errorToMessage(cleanupError)}`,
  );
}

function closeHttpServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) client.close(1001, "server shutdown");
  const closed = new Promise<void>((resolve) => {
    try {
      wss.close(() => resolve());
    } catch {
      resolve();
    }
  });
  if (await settlesWithin(closed, SERVER_WEBSOCKET_CLOSE_GRACE_MS)) return;
  for (const client of wss.clients) client.terminate();
  await settlesWithin(closed, SERVER_WEBSOCKET_FORCE_WAIT_MS);
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function withServerDeadline<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

// The console page boots two small inline scripts that resolve voice.js and
// voice.css against the document's mount path, so the page survives being
// served behind a path-stripping reverse proxy with no trailing slash. The
// CSP admits exactly those scripts by sha256 hash; test/console-page.test.ts
// fails whenever index.html's inline scripts drift from this list.
export const CONSOLE_INLINE_SCRIPT_HASHES: readonly string[] = [
  "sha256-mq1hfoo5YHSDtaoJ1p/zwcJD1GUVMaK1syjmsBveOD8=",
  "sha256-NmKY75Dxp7VN/5hMaS7UmRGFkY+GXqvb4hZbFUBDAZA=",
];

export function consoleContentSecurityPolicy(): string {
  const scriptSources = CONSOLE_INLINE_SCRIPT_HASHES.map((hash) => `'${hash}'`).join(" ");
  return `default-src 'self'; script-src 'self' ${scriptSources}; `
    + "style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";
}

async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    config: AppConfig;
    hermes: HermesRunsPort;
    taskSupervisor: TaskSupervisorRuntime;
    /** Owner whose task inbox the narration route resolves records from. */
    taskOwnerId: string;
    /** The owner identity (session key) watch registrations hash. */
    taskOwnerIdentity: string;
    /** Present only when a narrator LLM is configured. */
    narration?: TaskNarrationService;
    /** Present only when external work is enabled. */
    delegations?: Pick<DelegationService, "delegate">;
    logger: Logger;
    sessions: Set<LiveGatewaySession>;
    metrics: GatewayMetricsCollector;
    requireHermesApiKey: boolean;
    requireRealtimeProviderConfig: boolean;
  },
): Promise<void> {
  addCors(req, res, options.config);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  const url = parseRequestTarget(req.url);

  // Exact allowlist, resolved against the installed module (never process.cwd).
  const browserFiles: Record<string, [string, string]> = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/voice.js": ["voice.js", "text/javascript; charset=utf-8"],
    "/voice.css": ["voice.css", "text/css; charset=utf-8"],
    "/hermes-live-client.js": ["hermes-live-client.js", "text/javascript; charset=utf-8"],
    "/mic-worklet.js": ["mic-worklet.js", "text/javascript; charset=utf-8"],
    "/entity-state.js": ["entity-state.js", "text/javascript; charset=utf-8"],
    "/entity-gl.js": ["entity-gl.js", "text/javascript; charset=utf-8"],
    "/entity-head.js": ["entity-head.js", "text/javascript; charset=utf-8"],
    "/entity-facekit.js": ["entity-facekit.js", "text/javascript; charset=utf-8"],
    "/facekit-data.js": ["facekit-data.js", "text/javascript; charset=utf-8"],
    "/FACEKIT-LICENSE.txt": ["FACEKIT-LICENSE.txt", "text/plain; charset=utf-8"],
    "/entity-scene.js": ["entity-scene.js", "text/javascript; charset=utf-8"],
    "/entity-debug.js": ["entity-debug.js", "text/javascript; charset=utf-8"],
    "/diagnostics.js": ["diagnostics.js", "text/javascript; charset=utf-8"],
    "/sfx.js": ["sfx.js", "text/javascript; charset=utf-8"],
    "/markdown.js": ["markdown.js", "text/javascript; charset=utf-8"],
    "/task-narrator.js": ["task-narrator.js", "text/javascript; charset=utf-8"],
    "/brain-status.json": ["brain-status.json", "application/json; charset=utf-8"],
    "/connection-supervisor.js": ["connection-supervisor.js", "text/javascript; charset=utf-8"],
  };
  const asset = browserFiles[url.pathname];
  if (asset) {
    if (!isGetOrHead(req)) { methodNotAllowed(req, res, "GET, HEAD"); return; }
    const content = await readFile(new URL(`../../../../clients/browser/${asset[0]}`, import.meta.url));
    res.writeHead(200, {
      "Content-Type": asset[1], "Content-Length": content.length,
      "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": consoleContentSecurityPolicy(),
    });
    res.end(req.method === "HEAD" ? undefined : content);
    return;
  }

  if (url.pathname === "/health") {
    if (!isGetOrHead(req)) {
      methodNotAllowed(req, res, "GET, HEAD");
      return;
    }
    json(req, res, 200, { status: "ok", service: HERMES_LIVE_SERVICE_ID });
    return;
  }
  if (url.pathname === "/status.json") {
    if (!isGetOrHead(req)) {
      methodNotAllowed(req, res, "GET, HEAD");
      return;
    }
    // Connection-health surface for reconnecting browsers: gateway liveness
    // plus the gateway↔provider (s2s) attach state of every live session.
    // Unauthenticated like /health — it carries no secrets or session ids.
    const now = Date.now();
    const providerLinks = [...options.sessions].map((session) => session.providerLinkStatus(now));
    const providerProbe = await probeRealtimeProvider(options.config);
    json(req, res, 200, {
      ts: now,
      status: "ok",
      service: HERMES_LIVE_SERVICE_ID,
      uptimeMs: Math.round(process.uptime() * 1_000),
      provider: {
        name: options.config.realtime.provider,
        model: options.config.realtime.model,
      },
      sessions: {
        browser: providerLinks.length,
        providerAttached: providerLinks.filter((link) => link.state === "attached").length,
        providerStarting: providerLinks.filter((link) => link.state === "starting").length,
      },
      providerLinks,
      providerProbe,
    });
    return;
  }
  if (requiresHttpAuth(url.pathname) && !isAuthorized(req, options.config, url, { allowQueryToken: false })) {
    json(req, res, 401, { status: "unauthorized" });
    return;
  }
  if (url.pathname === "/ready") {
    if (!isGetOrHead(req)) {
      methodNotAllowed(req, res, "GET, HEAD");
      return;
    }
    const report = await buildReadinessReport(options.config, {
      hermes: options.hermes,
      tasks: options.taskSupervisor,
      requireHermesApiKey: options.requireHermesApiKey,
      requireRealtimeProviderConfig: options.requireRealtimeProviderConfig,
    });
    json(req, res, report.ok ? 200 : 503, {
      status: report.ok ? "ready" : "not_ready",
      service: HERMES_LIVE_SERVICE_ID,
      checks: {
        gateway: report.gateway,
        hermes: report.hermes,
        realtime: report.realtime,
        tasks: report.tasks,
        context: report.context,
      },
    });
    return;
  }
  if (url.pathname === "/v1/metrics") {
    if (!isGetOrHead(req)) {
      methodNotAllowed(req, res, "GET, HEAD");
      return;
    }
    const processMetrics = await options.metrics.sample();
    // Aggregate the audio-delivery telemetry of live sessions: the most
    // recent audio emission and the worst recent emit cadence across them.
    let lastAudioOutputMsAgo: number | null = null;
    let gatewayAudioGapP50Ms: number | null = null;
    let gatewayAudioGapP95Ms: number | null = null;
    // Speech-wait telemetry: the worst recent tool→speech and announcement
    // latencies across sessions, plus the filler injections spoken.
    let toolSpeechP50Ms: number | null = null;
    let toolSpeechP95Ms: number | null = null;
    let announcementDelayP50Ms: number | null = null;
    let announcementDelayP95Ms: number | null = null;
    let fillerInjections = 0;
    for (const session of options.sessions) {
      const audio = session.audioDeliveryMetrics();
      if (audio.lastOutputMsAgo !== null) {
        lastAudioOutputMsAgo = lastAudioOutputMsAgo === null
          ? audio.lastOutputMsAgo
          : Math.min(lastAudioOutputMsAgo, audio.lastOutputMsAgo);
      }
      if (audio.gapP50Ms !== null) {
        gatewayAudioGapP50Ms = Math.max(gatewayAudioGapP50Ms ?? 0, audio.gapP50Ms);
      }
      if (audio.gapP95Ms !== null) {
        gatewayAudioGapP95Ms = Math.max(gatewayAudioGapP95Ms ?? 0, audio.gapP95Ms);
      }
      const timing = session.speechTimingMetrics();
      if (timing.toolSpeechP50Ms !== null) {
        toolSpeechP50Ms = Math.max(toolSpeechP50Ms ?? 0, timing.toolSpeechP50Ms);
      }
      if (timing.toolSpeechP95Ms !== null) {
        toolSpeechP95Ms = Math.max(toolSpeechP95Ms ?? 0, timing.toolSpeechP95Ms);
      }
      if (timing.announcementDelayP50Ms !== null) {
        announcementDelayP50Ms = Math.max(announcementDelayP50Ms ?? 0, timing.announcementDelayP50Ms);
      }
      if (timing.announcementDelayP95Ms !== null) {
        announcementDelayP95Ms = Math.max(announcementDelayP95Ms ?? 0, timing.announcementDelayP95Ms);
      }
      fillerInjections += timing.fillerInjections;
    }
    json(req, res, 200, {
      ts: Date.now(),
      gatewayCpuPct: processMetrics.gatewayCpuPct,
      loadAvg: loadavg().map((value) => Math.round(value * 100) / 100),
      cores: cpus().length,
      lastAudioOutputMsAgo,
      gatewayAudioGapP50Ms,
      gatewayAudioGapP95Ms,
      toolSpeechP50Ms,
      toolSpeechP95Ms,
      announcementDelayP50Ms,
      announcementDelayP95Ms,
      fillerInjections,
      voiceStackCpuPct: processMetrics.voiceStackCpuPct,
      voiceStackPid: processMetrics.voiceStackPid,
      eventLagMs: processMetrics.eventLagMs,
    });
    return;
  }
  if (url.pathname === "/v1/task-narration") {
    if (req.method !== "POST") {
      methodNotAllowed(req, res, "POST");
      return;
    }
    if (!options.narration) {
      json(req, res, 503, { status: "narration_disabled" });
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = await readJsonObjectBody(req);
    } catch (error) {
      json(req, res, 400, { status: "invalid_request", error: errorToMessage(error) });
      return;
    }
    const taskId = typeof body.taskId === "string" ? body.taskId.trim() : "";
    if (!TASK_ID_PATTERN.test(taskId)) {
      json(req, res, 400, { status: "invalid_request", error: "taskId must be a task id." });
      return;
    }
    // The record is resolved from the gateway's own task inbox — the client
    // never supplies the content being summarized.
    const record = await options.taskSupervisor.get(options.taskOwnerId, taskId);
    if (!record) {
      json(req, res, 404, { status: "not_found" });
      return;
    }
    try {
      const result = await options.narration.narrate(projectTaskSnapshot(record, { includeOutput: true }));
      json(req, res, 200, result);
    } catch (error) {
      // A failure can mean the LLM is down (or was crashed by this very
      // request); the service opens its circuit breaker and retries shortly.
      // The raw structured facts stay visible regardless — narration is
      // presentation, never the source of truth.
      options.logger.error("task narration failed", {
        taskId,
        error: errorToMessage(error),
      });
      json(req, res, 502, { status: "narration_failed", error: errorToMessage(error) });
    }
    return;
  }
  if (url.pathname === "/v1/delegations") {
    if (req.method !== "POST") {
      methodNotAllowed(req, res, "POST");
      return;
    }
    if (!options.delegations) {
      json(req, res, 503, { status: "external_work_disabled" });
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = await readJsonObjectBody(req);
    } catch (error) {
      json(req, res, 400, { status: "invalid_request", error: errorToMessage(error) });
      return;
    }
    const parse = parseDelegationRequest(body);
    if (!parse.ok) {
      json(req, res, 400, { status: "invalid_request", error: parse.error });
      return;
    }
    try {
      // The verified receipt: launch (or reconcile), register the watch, and
      // move the linked task into the delegated phase — one idempotent call.
      const result = await options.delegations.delegate({
        ...parse.value,
        ownerIdentity: options.taskOwnerIdentity,
        ...(parse.value.linkedTaskId !== undefined ? { linkedTaskId: parse.value.linkedTaskId } : {}),
      });
      if (parse.value.linkedTaskId !== undefined) {
        try {
          await options.taskSupervisor.markDelegated(
            options.taskOwnerId,
            parse.value.linkedTaskId,
            `Verified handoff: ${parse.value.harness} agent ${result.watch.agentSessionValue.slice(0, 8)} on ${result.watch.host} (${result.watch.paneId}) took over this work; the gateway is monitoring.`,
          );
        } catch (error) {
          options.logger.warn("delegation linked task could not enter delegated phase", {
            taskId: parse.value.linkedTaskId,
            error: errorToMessage(error),
          });
        }
      }
      json(req, res, 200, {
        status: "delegated",
        reconciled: result.reconciled,
        watch_id: result.watch.watchId,
        host: result.watch.host,
        harness: result.watch.harness,
        pane_id: result.watch.paneId,
        agent_session_value: result.watch.agentSessionValue,
        ...(parse.value.linkedTaskId !== undefined ? { task_id: parse.value.linkedTaskId, task_status: "delegated" } : {}),
        message: result.reconciled
          ? "An agent for this delegation already existed; it is being monitored."
          : "Agent launched and verified; the gateway is monitoring it.",
      });
    } catch (error) {
      // An ambiguous launch is never retried blindly: the next call with the
      // same idempotency key reconciles against the host first.
      options.logger.error("delegation failed", { error: errorToMessage(error) });
      json(req, res, 502, { status: "delegation_failed", error: errorToMessage(error) });
    }
    return;
  }
  if (url.pathname === "/v1/capabilities") {
    if (!isGetOrHead(req)) {
      methodNotAllowed(req, res, "GET, HEAD");
      return;
    }
    const approvals = await negotiateHermesApprovalCompatibility(options.hermes);
    json(req, res, 200, {
      object: "hermes_live.capabilities",
      service: HERMES_LIVE_SERVICE_ID,
      protocolVersion: HERMES_LIVE_PROTOCOL_VERSION,
      supportedProtocolVersions: HERMES_LIVE_SUPPORTED_PROTOCOL_VERSIONS,
      websocket: { path: "/v1/live", protocol: "json-base64-audio" },
      realtime: realtimeClientCapabilities(options.config),
      hermes: { approvals },
      tasks: {
        scope: "owner",
        durable: true,
        persistence: "local_file",
        disconnectContinuation: true,
        gatewayRestartRecovery: "reconcile_by_upstream_run_id",
        hermesRestartRecovery: false,
        ambiguousDispatch: "fenced_no_automatic_retry",
        declaredReadOnlyTrusted: options.config.tasks.trustDeclaredReadOnly === true,
        maxConcurrent: options.config.tasks.maxConcurrent,
        maxQueued: options.config.tasks.maxQueued,
        maxRetained: options.config.tasks.historyLimit,
        retentionMs: options.config.tasks.retentionMs,
        pollIntervalMs: options.config.tasks.pollIntervalMs,
      },
      features: {
        auth_required: Boolean(options.config.server.authToken),
        server_managed_identity: !options.config.server.trustClientIdentity,
        max_sessions: options.config.server.maxSessions,
        gateway_speech_vad: options.config.vad.engine !== "disabled",
        // Protocol v9: the agent can request client-side audio setting
        // changes (microphone pause/resume, interface sounds) by voice.
        client_audio_control: true,
        context_digest: options.config.context.digestEnabled,
        persistent_voice_thread: true,
        huggingface_local: options.config.realtime.provider === "local",
        gemini_live: options.config.realtime.provider === "gemini",
        openai_realtime: options.config.realtime.provider === "openai",
        mock_live: options.config.realtime.provider === "mock",
        hermes_runs: true,
        hermes_conversations: true,
        conversation_create: true,
        conversation_resume: true,
        background_tasks: true,
        durable_task_state: true,
        task_reconnect_snapshot: true,
        parallel_read_only_tasks:
          options.config.tasks.maxConcurrent > 1 && options.config.tasks.trustDeclaredReadOnly === true,
        exact_task_stop: true,
        task_notifications: true,
        hermes_run_events_internal: true,
        hermes_stop: true,
        hermes_approval: false,
        hermes_approval_ui: false,
        hermes_approval_fallback_deny_all: approvals.fallback === "deny_all_then_stop",
        hermes_approval_fallback_stops_run: true,
        hermes_approval_requires_targeted_response: true,
        optional_hermes_plugin: true,
      },
    });
    return;
  }
  if (url.pathname === "/v1/conversations") {
    const assertSessionsSupported = options.hermes.assertSessionsSupported;
    const listSessions = options.hermes.listSessions;
    const createSession = options.hermes.createSession;
    if (!assertSessionsSupported || !listSessions || !createSession) {
      json(req, res, 503, { status: "unavailable", error: "Hermes session continuity is unavailable." });
      return;
    }
    if (isGetOrHead(req)) {
      const limit = boundedQueryInteger(url, "limit", 20, 1, 100);
      const offset = boundedQueryInteger(url, "offset", 0, 0, 100_000);
      if (limit === undefined || offset === undefined) {
        json(req, res, 400, { status: "invalid_request", error: "Conversation pagination is invalid." });
        return;
      }
      const source = url.searchParams.get("source")?.trim();
      if (source !== undefined && (source.length === 0 || source.length > 64)) {
        json(req, res, 400, { status: "invalid_request", error: "Conversation source is invalid." });
        return;
      }
      await assertSessionsSupported.call(options.hermes);
      const conversations = await listSessions.call(options.hermes, {
        limit,
        offset,
        ...(source ? { source } : {}),
      });
      json(req, res, 200, { object: "list", conversations });
      return;
    }
    if (req.method === "POST") {
      const parsed = await readBoundedJsonObject(req, 16_384);
      if (!parsed.ok) {
        json(req, res, parsed.status, { status: "invalid_request", error: parsed.error });
        return;
      }
      const keys = Object.keys(parsed.value);
      const title = parsed.value.title;
      if (keys.some((key) => key !== "title") || (title !== undefined && (
        typeof title !== "string" || title.trim().length === 0 || title.trim().length > 100
      ))) {
        json(req, res, 400, { status: "invalid_request", error: "Conversation title is invalid." });
        return;
      }
      await assertSessionsSupported.call(options.hermes);
      const conversation = await createSession.call(options.hermes, {
        ...(typeof title === "string" ? { title: title.trim() } : {}),
      });
      json(req, res, 201, { object: "hermes_live.conversation", conversation });
      return;
    }
    methodNotAllowed(req, res, "GET, HEAD, POST");
    return;
  }
  json(req, res, 404, { status: "not_found" });
}

function isAuthorized(req: IncomingMessage, config: AppConfig, url: URL, options: { allowQueryToken: boolean }): boolean {
  if (!config.server.authToken) {
    return true;
  }
  const bearer = bearerToken(req.headers.authorization);
  const queryToken = options.allowQueryToken ? url.searchParams.get("token") : undefined;
  return secureTokenEqual(bearer, config.server.authToken) || secureTokenEqual(queryToken, config.server.authToken);
}

function requiresHttpAuth(pathname: string): boolean {
  return pathname === "/ready" || pathname === "/v1/capabilities" || pathname === "/v1/conversations" || pathname === "/v1/metrics" || pathname === "/v1/task-narration" || pathname === "/v1/delegations";
}

function isWebSocketOriginAllowed(req: IncomingMessage, config: AppConfig): boolean {
  const origin = req.headers.origin;
  if (!origin) {
    return true;
  }
  if (config.server.allowOrigin === "*") {
    return true;
  }
  if (config.server.allowOrigin) {
    return origin === config.server.allowOrigin;
  }

  const originUrl = parseBrowserOrigin(origin);
  const requestHost = originUrl
    ? parseHttpHost(req.headers.host, originUrl.protocol === "https:" ? "https:" : "http:")
    : undefined;
  return (
    originUrl !== undefined &&
    requestHost !== undefined &&
    isLoopbackHostname(originUrl.hostname) &&
    isLoopbackHostname(requestHost.hostname) &&
    effectivePort(originUrl) === effectivePort(requestHost)
  );
}

function parseBrowserOrigin(origin: string): URL | undefined {
  if (origin !== origin.trim()) {
    return undefined;
  }
  try {
    const parsed = new URL(origin);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.origin !== origin
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function parseHttpHost(host: string | undefined, protocol: "http:" | "https:"): URL | undefined {
  if (!host || host !== host.trim()) {
    return undefined;
  }
  try {
    const parsed = new URL(`${protocol}//${host}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function parseRequestTarget(target: string | undefined): URL {
  return new URL(target ?? "/", "http://localhost");
}

interface RealtimeProviderProbe {
  reachable: boolean;
  latencyMs: number;
  target: string;
  checkedAt: number;
  error?: string;
}

const PROVIDER_PROBE_CACHE_MS = 2_000;
const PROVIDER_PROBE_TIMEOUT_MS = 1_500;
const providerProbeCache = new Map<string, { at: number; result: RealtimeProviderProbe }>();

/** Provider endpoints whose origins can be probed over HTTP. */
function realtimeProviderProbeTargets(config: AppConfig): string[] {
  if (config.realtime.provider === "local") return [config.local.url];
  if (config.realtime.provider === "riva") return [config.riva.asrUrl, config.riva.ttsUrl];
  if (config.realtime.provider === "openai") return [config.openai.baseUrl];
  return [];
}

/**
 * Cheap HTTP reachability checks of the speech origins, cached
 * briefly so polling clients cannot turn /status.json into a probe amplifier.
 * Any HTTP answer — even 404/426 — proves the speech service is listening;
 * only a refused/timed-out connection reports unreachable.
 */
async function probeRealtimeProvider(config: AppConfig): Promise<RealtimeProviderProbe | null> {
  const targets = realtimeProviderProbeTargets(config);
  if (!targets.length) return null;
  const cacheKey = targets.join("|");
  const cached = providerProbeCache.get(cacheKey);
  if (cached && Date.now() - cached.at <= PROVIDER_PROBE_CACHE_MS) return cached.result;
  const beganAt = Date.now();
  const origins = targets.map((target) => {
    const origin = new URL(target);
    origin.protocol = origin.protocol === "wss:" ? "https:" : "http:";
    origin.pathname = "/";
    origin.search = "";
    return origin;
  });
  const checks = await Promise.all(origins.map(async (origin) => {
    try {
      await fetch(origin, {
        signal: AbortSignal.timeout(PROVIDER_PROBE_TIMEOUT_MS),
        headers: { Accept: "application/json" },
      });
      return { reachable: true as const, target: origin.origin };
    } catch (error) {
      return { reachable: false as const, target: origin.origin, error: errorToMessage(error) };
    }
  }));
  const failed = checks.filter((check) => !check.reachable);
  const result: RealtimeProviderProbe = {
    reachable: failed.length === 0,
    latencyMs: Date.now() - beganAt,
    target: checks.map((check) => check.target).join(", "),
    checkedAt: Date.now(),
    ...(failed.length ? { error: failed.map((check) => `${check.target}: ${check.error}`).join("; ") } : {}),
  };
  providerProbeCache.set(cacheKey, { at: Date.now(), result });
  return result;
}

function rejectMalformedUpgrade(socket: Duplex): void {
  socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", () => socket.destroy());
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }
  const octets = normalized.split(".");
  return octets.length === 4 && octets[0] === "127" && octets.every((octet) => /^(?:0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255);
}

function effectivePort(url: URL): string | undefined {
  if (url.protocol === "http:") {
    return url.port || "80";
  }
  if (url.protocol === "https:") {
    return url.port || "443";
  }
  return undefined;
}

function addCors(req: IncomingMessage, res: ServerResponse, config: AppConfig): void {
  const origin = req.headers.origin;
  if (!origin) {
    return;
  }
  if (config.server.allowOrigin === "*" || config.server.allowOrigin === origin) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "origin");
    res.setHeader("access-control-allow-headers", "authorization, content-type");
    res.setHeader("access-control-allow-methods", "GET, HEAD, POST, OPTIONS");
  }
}

function boundedQueryInteger(
  url: URL,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  if (!/^(?:0|[1-9]\d*)$/u.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : undefined;
}

async function readBoundedJsonObject(
  req: IncomingMessage,
  maxBytes: number,
): Promise<
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; status: 400 | 413; error: string }
> {
  const contentLength = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return { ok: false, status: 413, error: "Request body is too large." };
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxBytes) return { ok: false, status: 413, error: "Request body is too large." };
    chunks.push(buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, status: 400, error: "Request body must be a JSON object." };
  }
}

function isGetOrHead(req: IncomingMessage): boolean {
  return req.method === "GET" || req.method === "HEAD";
}

function methodNotAllowed(req: IncomingMessage, res: ServerResponse, allow: string): void {
  json(req, res, 405, { status: "method_not_allowed", allow }, { allow });
}

function json(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(payload)),
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    ...headers,
  });
  if (req.method === "HEAD") {
    res.end();
  } else {
    res.end(payload);
  }
}

/** Narration requests carry one task id; anything larger is malformed. */
const MAX_JSON_BODY_BYTES = 4_096;
/** Public task ids are exactly `task_` plus 32 lowercase hex characters. */
const TASK_ID_PATTERN = /^task_[0-9a-f]{32}$/;

async function readJsonObjectBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_JSON_BODY_BYTES) throw new Error("Request body is too large.");
    chunks.push(chunk as Buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function bearerToken(authorization: string | undefined): string | undefined {
  if (!authorization) {
    return undefined;
  }
  const [scheme, ...rest] = authorization.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer" || rest.length !== 1) {
    return undefined;
  }
  return rest[0];
}

function secureTokenEqual(actual: string | null | undefined, expected: string): boolean {
  if (!actual) {
    return false;
  }
  const actualHash = createHash("sha256").update(actual).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

function clientWebSocketMaxPayload(config: AppConfig): number {
  const base64AudioBytes = Math.ceil((config.server.maxAudioBytes * 4) / 3);
  const textBytes = config.server.maxTextChars * 6;
  return Math.max(base64AudioBytes, textBytes) + 4096;
}

function listenHttpServer(server: ReturnType<typeof createServer>, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(new Error(`Failed to start hermes-live on ${host}:${port}: ${error.message}`));
    };
    const onListening = () => {
      cleanup();
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

/**
 * Zombie-session reaper. A vanished client (sleep, roam, NAT drop) leaves a
 * half-open WebSocket that keeps its provider pipeline slot and blocks new
 * sessions with 503s. Browsers answer protocol pings automatically, so two
 * consecutive missed pongs mean the peer is gone: terminate the socket, which
 * runs the normal close path and releases the slot.
 */
function armClientKeepalive(
  ws: import("ws").WebSocket,
  keepaliveMs: number | undefined,
  logger: Logger,
): void {
  const intervalMs = keepaliveMs ?? 15_000;
  if (intervalMs <= 0) return;
  let alive = true;
  let missedPongs = 0;
  ws.on("pong", () => {
    alive = true;
    missedPongs = 0;
  });
  const timer = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return;
    if (!alive) {
      missedPongs += 1;
      if (missedPongs >= 2) {
        logger.warn("terminating unresponsive live client after missed keepalives", {
          keepaliveMs: intervalMs,
        });
        ws.terminate();
        return;
      }
    } else {
      missedPongs = 0;
    }
    alive = false;
    ws.ping();
  }, intervalMs);
  timer.unref?.();
  ws.once("close", () => clearInterval(timer));
  ws.once("error", () => clearInterval(timer));
}
