import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { MANAGED_CONFIG_KEYS } from "../src/cli/managed-config.js";
import {
  buildLayaState,
  defaultLayaShadowLogPath,
  LAYA_SHADOW_QUESTIONS,
  LayaShadowLog,
  LayaShadowRecorder,
  layaShadowRecorderFromConfig,
  LAYA_STATE_BUDGET_CHARS,
} from "../src/application/live-gateway/laya-shadow.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function startSidecar(handler: (body: string, send: (payload: unknown, status?: number) => void) => void): Promise<{
  url: string;
  server: Server;
}> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const send = (payload: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
      };
      handler(body, send);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    server,
  };
}

describe("buildLayaState", () => {
  it("places the utterance first, then recent turns, then active tasks", () => {
    const built = buildLayaState({
      utterance: "rebuild the dashboard",
      recentTurns: [
        { speaker: "assistant", text: "Started the disk check task." },
        { speaker: "user", text: "thanks" },
      ],
      activeTaskTitles: ["check exodia disk usage"],
    });
    const lines = built.state.split("\n");
    expect(lines[0]).toBe("user: rebuild the dashboard");
    expect(built.state.indexOf("Started the disk check task.")).toBeGreaterThan(built.state.indexOf("rebuild the dashboard"));
    expect(built.state).toContain("active tasks: check exodia disk usage");
    expect(built.utteranceHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("enforces the hard budget: drops the recent-turn tail first, never the utterance", () => {
    const utterance = "please rebuild the dashboard and redeploy it after the current task finishes";
    const recentTurns = Array.from({ length: 12 }, (_, index) => ({
      speaker: "user" as const,
      text: `older turn number ${index} with some detail to fill the budget`,
    }));
    const built = buildLayaState({ utterance, recentTurns, activeTaskTitles: ["task"] });
    expect(built.state.length).toBeLessThanOrEqual(LAYA_STATE_BUDGET_CHARS);
    expect(built.state).toContain(utterance);
    // The oldest turns are the tail that gets dropped; the newest survive.
    expect(built.state).toContain("older turn number 11");
    expect(built.state).not.toContain("older turn number 0");
  });

  it("drops the active-task line before recent turns when space is tight", () => {
    const utterance = "x".repeat(1_200);
    const built = buildLayaState({
      utterance,
      recentTurns: [{ speaker: "assistant", text: "r".repeat(160) }],
      activeTaskTitles: ["a task title"],
    });
    expect(built.state.length).toBeLessThanOrEqual(LAYA_STATE_BUDGET_CHARS);
    expect(built.state).toContain("rrrr");
    expect(built.state).not.toContain("active tasks:");
  });

  it("truncates an over-budget utterance head-first rather than dropping it", () => {
    const built = buildLayaState({ utterance: "y".repeat(5_000), recentTurns: [], activeTaskTitles: [] });
    expect(built.state.length).toBeLessThanOrEqual(LAYA_STATE_BUDGET_CHARS);
    expect(built.state.startsWith("user: yyyy")).toBe(true);
    // Hash covers the full finalized text, not the truncated state copy.
    expect(built.utteranceHash).toBe(buildLayaState({ utterance: "y".repeat(5_000) }).utteranceHash);
    expect(built.utteranceHash).not.toBe(buildLayaState({ utterance: "y".repeat(4_999) }).utteranceHash);
  });

  it("builds a minimal state from an utterance alone", () => {
    const built = buildLayaState({ utterance: "hey", recentTurns: [], activeTaskTitles: [] });
    expect(built.state).toBe("user: hey");
  });
});

describe("LayaShadowRecorder", () => {
  let directory: string;
  let servers: Server[];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "laya-shadow-test-"));
    servers = [];
  });

  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    await rm(directory, { recursive: true, force: true });
  });

  function recorderFor(url: string, timeoutMs = 150, maxBytes?: number): { recorder: LayaShadowRecorder; logPath: string } {
    const logPath = join(directory, "turns.jsonl");
    return {
      recorder: new LayaShadowRecorder({
        baseUrl: url,
        timeoutMs,
        log: new LayaShadowLog({ filePath: logPath, ...(maxBytes ? { maxBytes } : {}) }),
      }),
      logPath,
    };
  }

  async function readRows(path: string): Promise<Array<Record<string, unknown>>> {
    const content = await readFile(path, "utf8");
    return content.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("never awaits the sidecar on the hot path and writes an unknown row on timeout", async () => {
    let release: (() => void) | undefined;
    const sidecar = await startSidecar((_body, _send) => {
      // Hang until the test releases; the recorder must not wait for it.
      void new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    servers.push(sidecar.server);
    const { recorder, logPath } = recorderFor(sidecar.url, 60);

    const state = buildLayaState({ utterance: "hello there", recentTurns: [], activeTaskTitles: [] });
    const started = performance.now();
    expect(recorder.noteTurn("session-a", state, true)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(25);

    await sleep(150);
    recorder.noteOutcome("session-a", [], null);
    await sleep(25);
    release?.();

    const rows = await readRows(logPath);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.timeout).toBe(true);
    expect(rows[0]!.answers).toBeNull();
    expect(rows[0]!.layaLatencyMs).toBeNull();
    expect((rows[0]!.brain as Record<string, unknown>)!.turnHadSpeech).toBe(true);
  });

  it("writes a sidecar-down row without throwing", async () => {
    // A port with no listener: the connection is refused, not timed out.
    const { recorder, logPath } = recorderFor("http://127.0.0.1:1", 100);
    const state = buildLayaState({ utterance: "anyone home", recentTurns: [], activeTaskTitles: [] });
    expect(() => recorder.noteTurn("session-b", state, false)).not.toThrow();
    await sleep(80);
    recorder.noteOutcome("session-b", [], null);
    await sleep(25);
    const rows = await readRows(logPath);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.answers).toBeNull();
    expect(rows[0]!.timeout).toBe(false);
  });

  it("joins answers and brain outcome into one finalized row", async () => {
    const answers = { route: { type: "choice", choice: "start_background_task", confidence: 0.9 } };
    const sidecar = await startSidecar((body, send) => {
      expect(JSON.parse(body).questions).toEqual(LAYA_SHADOW_QUESTIONS);
      send({ answers, latency_ms: 512 });
    });
    servers.push(sidecar.server);
    const { recorder, logPath } = recorderFor(sidecar.url);

    const state = buildLayaState({ utterance: "rebuild the dashboard please", recentTurns: [], activeTaskTitles: [] });
    recorder.noteTurn("session-c", state, true);
    await sleep(80);
    recorder.noteOutcome("session-c", [{ name: "start_background_task", executionMode: "exclusive" }], true);
    // A duplicate outcome join must not write a second row.
    recorder.noteOutcome("session-c", [], null);
    await sleep(25);

    const rows = await readRows(logPath);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.answers).toEqual(answers);
    expect(rows[0]!.cached).toBe(false);
    expect(rows[0]!.timeout).toBe(false);
    expect(typeof rows[0]!.layaLatencyMs).toBe("number");
    const brain = rows[0]!.brain as Record<string, unknown>;
    expect(brain.toolCalls).toEqual([{ name: "start_background_task", executionMode: "exclusive" }]);
    expect(brain.taskAccepted).toBe(true);
    expect(rows[0]!.questions).toEqual(LAYA_SHADOW_QUESTIONS);
  });

  it("serves repeated utterances from the answer cache without a second request", async () => {
    let requests = 0;
    const answers = { route: { type: "choice", choice: "answer_directly", confidence: 0.8 } };
    const sidecar = await startSidecar((_body, send) => {
      requests += 1;
      send({ answers });
    });
    servers.push(sidecar.server);
    const { recorder, logPath } = recorderFor(sidecar.url);

    const state = buildLayaState({ utterance: "thanks", recentTurns: [], activeTaskTitles: [] });
    recorder.noteTurn("session-d", state, true);
    await sleep(80);
    recorder.noteOutcome("session-d", [], null);
    recorder.noteTurn("session-d", state, true);
    await sleep(80);
    recorder.noteOutcome("session-d", [], null);
    await sleep(25);

    expect(requests).toBe(1);
    const rows = await readRows(logPath);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.cached).toBe(false);
    expect(rows[1]!.cached).toBe(true);
  });

  it("waits for an in-flight fetch before writing the finalized row", async () => {
    const answers = { route: { type: "choice", choice: "task_control", confidence: 0.7 } };
    const sidecar = await startSidecar((_body, send) => {
      setTimeout(() => send({ answers }), 120);
    });
    servers.push(sidecar.server);
    const { recorder, logPath } = recorderFor(sidecar.url, 2_000);

    recorder.noteTurn("session-f", buildLayaState({ utterance: "list my tasks", recentTurns: [], activeTaskTitles: [] }), true);
    // Outcome lands before the sidecar answers: the row must still carry it.
    recorder.noteOutcome("session-f", [{ name: "list_background_tasks" }], null);
    await sleep(40);
    await expect(readFile(logPath, "utf8")).rejects.toThrowError();
    await sleep(200);
    const rows = await readRows(logPath);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.answers).toEqual(answers);
    expect(rows[0]!.brain).toMatchObject({ toolCalls: [{ name: "list_background_tasks" }] });
  });

  it("finalizes the pending row on close with whatever is known", async () => {
    const sidecar = await startSidecar((_body, send) => send({ answers: {} }));
    servers.push(sidecar.server);
    const { recorder, logPath } = recorderFor(sidecar.url);
    recorder.noteTurn("session-e", buildLayaState({ utterance: "bye", recentTurns: [], activeTaskTitles: [] }), true);
    await sleep(80);
    recorder.close("session-e");
    await sleep(25);
    const rows = await readRows(logPath);
    expect(rows).toHaveLength(1);
  });

  it("rotates the JSONL log at the size limit", async () => {
    const sidecar = await startSidecar((_body, send) => send({ answers: {} }));
    servers.push(sidecar.server);
    const { recorder, logPath } = recorderFor(sidecar.url, 150, 512);
    for (let index = 0; index < 8; index += 1) {
      recorder.noteTurn(`session-r${index}`, buildLayaState({
        utterance: `utterance number ${index} ${"z".repeat(200)}`,
        recentTurns: [],
        activeTaskTitles: [],
      }), true);
      await sleep(40);
      recorder.close(`session-r${index}`);
      await sleep(15);
    }
    const files = await readdir(directory);
    expect(files).toContain("turns.jsonl.1");
    const active = await stat(logPath);
    expect(active.size).toBeLessThan(2_048);
  });
});

describe("laya shadow configuration", () => {
  it("is fully inert when HERMES_LIVE_LAYA_URL is unset", () => {
    const config = loadConfig({});
    expect(config.laya.baseUrl).toBeUndefined();
    expect(config.laya.shadowEnabled).toBe(true);
    expect(layaShadowRecorderFromConfig(config, new LayaShadowLog({ filePath: "/tmp/unused-laya.jsonl" }))).toBeUndefined();
  });

  it("is inert when shadow logging is disabled, even with a URL", () => {
    const config = loadConfig({ HERMES_LIVE_LAYA_URL: "http://127.0.0.1:8767", HERMES_LIVE_LAYA_SHADOW_ENABLED: "false" });
    expect(config.laya.baseUrl).toBe("http://127.0.0.1:8767");
    expect(config.laya.shadowEnabled).toBe(false);
    expect(layaShadowRecorderFromConfig(config, new LayaShadowLog({ filePath: "/tmp/unused-laya.jsonl" }))).toBeUndefined();
  });

  it("builds a recorder from an explicit local URL with the configured timeout", () => {
    const config = loadConfig({ HERMES_LIVE_LAYA_URL: "http://127.0.0.1:8767/", HERMES_LIVE_LAYA_TIMEOUT_MS: "900" });
    expect(config.laya.baseUrl).toBe("http://127.0.0.1:8767");
    expect(config.laya.timeoutMs).toBe(900);
    expect(layaShadowRecorderFromConfig(config, new LayaShadowLog({ filePath: "/tmp/unused-laya.jsonl" }))).toBeInstanceOf(LayaShadowRecorder);
  });

  it("rejects non-local or malformed URLs at config parse time", () => {
    expect(() => loadConfig({ HERMES_LIVE_LAYA_URL: "http://10.0.0.5:8767" })).toThrowError(/HERMES_LIVE_LAYA_URL/u);
    expect(() => loadConfig({ HERMES_LIVE_LAYA_URL: "not-a-url" })).toThrowError(/HERMES_LIVE_LAYA_URL/u);
  });

  it("registers every HERMES_LIVE_LAYA_* key in MANAGED_CONFIG_KEYS (unregistered keys crash the gateway)", () => {
    expect(MANAGED_CONFIG_KEYS).toContain("HERMES_LIVE_LAYA_URL");
    expect(MANAGED_CONFIG_KEYS).toContain("HERMES_LIVE_LAYA_SHADOW_ENABLED");
    expect(MANAGED_CONFIG_KEYS).toContain("HERMES_LIVE_LAYA_TIMEOUT_MS");
  });

  it("keeps the shadow log under the hermes-live home", () => {
    expect(defaultLayaShadowLogPath("/home/tester")).toBe(
      "/home/tester/.hermes/hermes-live/laya-shadow/turns.jsonl",
    );
  });
});

import type { ClientConnectionPort } from "../src/application/live-gateway/ports/client-connection.port.js";
import type { HermesRunsPort } from "../src/application/live-gateway/ports/hermes-runs.port.js";
import type { TaskSupervisorPort } from "../src/application/live-gateway/ports/task-supervisor.port.js";
import type {
  LiveModelAdapter,
  LiveModelConnectParams,
  LiveModelEvent,
  LiveModelSession,
  LiveToolCall,
} from "../src/application/live-gateway/ports/realtime-model.port.js";
import { LiveGatewaySession } from "../src/application/live-gateway/live-gateway-session.js";
import { createTaskRecord } from "../src/domain/tasks/index.js";
import type { AppConfig } from "../src/config.js";
import type { Logger } from "../src/logger.js";

class FakeClientConnection implements ClientConnectionPort {
  readonly sent: Array<Record<string, unknown>> = [];
  private frame?: (data: string) => void;

  onMessage(handler: (data: string) => void): void {
    this.frame = handler;
  }

  onClose(): void {}

  onError(): void {}

  sendText(payload: string): void {
    this.sent.push(JSON.parse(payload) as Record<string, unknown>);
  }

  close(): void {}

  send(message: Record<string, unknown>): void {
    this.frame?.(JSON.stringify(message));
  }

  async waitFor(predicate: (message: Record<string, unknown>) => boolean): Promise<void> {
    for (let index = 0; index < 200; index += 1) {
      if (this.sent.some(predicate)) return;
      await sleep(10);
    }
    throw new Error(`timed out waiting for client message; got ${JSON.stringify(this.sent.slice(0, 6))}`);
  }
}

class ScriptedLiveSession implements LiveModelSession {
  readonly toolResponses: Array<{ call: LiveToolCall; response: Record<string, unknown> }> = [];

  constructor(readonly params: LiveModelConnectParams) {}

  async sendRealtimeAudio(): Promise<void> {}

  async sendText(): Promise<void> {}

  async sendAudioStreamEnd(): Promise<boolean> {
    return true;
  }

  async cancelResponse(): Promise<boolean> {
    return true;
  }

  async sendToolResponse(call: LiveToolCall, response: Record<string, unknown>): Promise<void> {
    this.toolResponses.push({ call, response });
  }

  async close(): Promise<void> {}
}

class ScriptedLiveAdapter implements LiveModelAdapter {
  session?: ScriptedLiveSession;

  async connect(params: LiveModelConnectParams): Promise<LiveModelSession> {
    this.session = new ScriptedLiveSession(params);
    queueMicrotask(() => params.callbacks.onOpen?.());
    return this.session;
  }

  emit(event: LiveModelEvent): void {
    this.session?.params.callbacks.onEvent(event);
  }
}

function fakeHermes(): HermesRunsPort {
  return {
    baseUrl: "http://127.0.0.1:8642",
    async assertRunsSupported() {
      return { features: { run_submission: true } };
    },
  } as unknown as HermesRunsPort;
}

function fakeSupervisor(): TaskSupervisorPort {
  const records: Array<ReturnType<typeof createTaskRecord>> = [];
  const unused = async () => {
    throw new Error("not used in this test");
  };
  return {
    registerOwner: () => "owner_test",
    subscribe: () => () => undefined,
    async submit(input) {
      const record = createTaskRecord({
        ownerIdentity: input.ownerIdentity,
        input: input.input,
        ...(input.title ? { title: input.title } : {}),
        executionMode: input.executionMode,
      });
      records.push(record);
      return record;
    },
    async list() {
      return records;
    },
    async listActive() {
      return records;
    },
    async listUnreadNotifications() {
      return [];
    },
    get: async () => undefined,
    stop: unused,
    acknowledgeNotification: unused,
    markNotificationAnnounced: unused,
    claimNotificationAnnouncement: unused,
    completeNotificationAnnouncement: unused,
    releaseNotificationAnnouncement: () => undefined,
  };
}

const fakeLogger = (): Logger => ({
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
});

async function startShadowSession(config: AppConfig): Promise<{
  session: LiveGatewaySession;
  client: FakeClientConnection;
  adapter: ScriptedLiveAdapter;
}> {
  const client = new FakeClientConnection();
  const adapter = new ScriptedLiveAdapter();
  const session = new LiveGatewaySession(client, {
    config,
    hermes: fakeHermes(),
    taskSupervisor: fakeSupervisor(),
    liveModel: adapter,
    logger: fakeLogger(),
    ...(config.laya.baseUrl
      ? {
        layaShadow: layaShadowRecorderFromConfig(
          config,
          new LayaShadowLog({ filePath: join(shadowDir(), "turns.jsonl") }),
        ),
      }
      : {}),
  });
  session.bind();
  client.send({ type: "session.start", protocolVersion: 9, id: "start-1" });
  await client.waitFor((message) => message.type === "session.ready");
  return { session, client, adapter };
}

let sessionDirectory: string;

function shadowDir(): string {
  return sessionDirectory;
}

describe("live gateway session shadow hooks", () => {
  let openServers: Server[];

  beforeEach(async () => {
    sessionDirectory = await mkdtemp(join(tmpdir(), "laya-shadow-session-"));
    openServers = [];
  });

  afterEach(async () => {
    await Promise.all(openServers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    await rm(sessionDirectory, { recursive: true, force: true });
  });

  it("logs answered turns and joins the brain's tool calls into rows", async () => {
    let requests = 0;
    const answers = { route: { type: "choice", choice: "answer_directly", confidence: 0.81 } };
    const sidecar = await startSidecar((_body, send) => {
      requests += 1;
      send({ answers });
    });
    openServers.push(sidecar.server);
    const logPath = join(sessionDirectory, "turns.jsonl");
    const config = loadConfig({
      HERMES_LIVE_PROVIDER: "mock",
      HERMES_LIVE_CONTEXT_DIGEST: "false",
      HERMES_LIVE_LAYA_URL: sidecar.url,
      HERMES_LIVE_LAYA_TIMEOUT_MS: "2000",
    });
    const { session, adapter } = await startShadowSession(config);

    // Turn 1: answered directly (no tool calls) — row finalizes on the
    // settled response with an empty tool-call list. Events are emitted
    // back-to-back (faster than the sidecar) to prove the row still waits
    // for the in-flight answer.
    adapter.emit({ type: "text", text: "hey, quick one — what's up?", speaker: "user", final: true });
    adapter.emit({ type: "response", status: "started", scope: "conversation" });
    adapter.emit({ type: "text", text: "Not much — ready when you are.", speaker: "assistant", final: true });
    adapter.emit({ type: "response", status: "completed", scope: "conversation" });

    // Turn 2: delegated to a background task.
    adapter.emit({ type: "text", text: "please rebuild the dashboard", speaker: "user", final: true });
    adapter.emit({ type: "response", status: "started", scope: "conversation" });
    adapter.emit({
      type: "tool_call",
      call: { id: "call-1", name: "start_background_task", args: { message: "rebuild the dashboard" } },
    });
    await sleep(50);
    adapter.emit({ type: "response", status: "completed", scope: "conversation" });
    await sleep(150);
    await session.close();

    const rows = (await readFile(logPath, "utf8")).split("\n").filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(requests).toBe(2);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.brain).toMatchObject({ toolCalls: [], taskAccepted: null, turnHadSpeech: true });
    expect(rows[0]!.answers).toEqual(answers);
    const rowState = rows[1]!.state as string;
    expect(rowState).toContain("user: please rebuild the dashboard");
    // The turn-1 exchange is now recent context, after the utterance.
    expect(rowState.indexOf("what's up?")).toBeGreaterThan(rowState.indexOf("rebuild the dashboard"));
    expect(rows[1]!.brain).toMatchObject({
      toolCalls: [{ name: "start_background_task", executionMode: "exclusive" }],
      taskAccepted: true,
    });
  });

  it("is fully inert when HERMES_LIVE_LAYA_URL is unset", async () => {
    const config = loadConfig({
      HERMES_LIVE_PROVIDER: "mock",
      HERMES_LIVE_CONTEXT_DIGEST: "false",
    });
    expect(config.laya.baseUrl).toBeUndefined();
    const { session, client, adapter } = await startShadowSession(config);

    adapter.emit({ type: "text", text: "hello there", speaker: "user", final: true });
    adapter.emit({ type: "response", status: "started", scope: "conversation" });
    adapter.emit({
      type: "tool_call",
      call: { id: "call-2", name: "start_background_task", args: { message: "do a thing" } },
    });
    await sleep(50);
    adapter.emit({ type: "response", status: "completed", scope: "conversation" });
    await sleep(100);
    await session.close();

    // The conversation path itself is untouched: transcript and tool receipt
    // still flow, and no shadow row was written anywhere.
    expect(client.sent.some((message) => message.type === "transcript.delta")).toBe(true);
    expect(adapter.session!.toolResponses).toHaveLength(1);
    expect(adapter.session!.toolResponses[0]!.response.ok).toBe(true);
    const files = await readdir(sessionDirectory).catch(() => [] as string[]);
    expect(files).toEqual([]);
  });
});
