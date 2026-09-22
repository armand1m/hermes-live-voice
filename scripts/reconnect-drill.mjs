#!/usr/bin/env node
// End-to-end connection-resilience drill for the voice console.
//
// Throwaway instances ONLY (never the live services):
//   4601  gateway under test (dist/cli.js serve)
//   4602  fake speech-to-speech (OpenAI-Realtime-ish ws, HTTP 426 on GET)
//   4610  fake Hermes Agent HTTP API
//
// Scenario, with headless chromium as the browser:
//   1. connect + arm the mic, one seeded RUNNING background task visible
//   2. SIGKILL the gateway mid-session → visible lost/reconnecting states
//   3. press "Reconnect now" during the backoff wait → immediate attempt
//   4. relaunch the gateway on the same port → auto-reconnect re-hydrates
//      (task snapshot + transcript survive; gateway logs a fresh attach)
//   5. kill the fake s2s → "Voice pipeline down" state; restart it → recovery
//
// Evidence (screenshots, DOM texts, gateway log lines) lands in /tmp/reconnect-drill/.
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { chromium } from "@playwright/test";
import { createTaskRecord } from "../dist/domain/tasks/task.js";
import { transitionTask as transitionTaskRecord } from "../dist/domain/tasks/task-transition.js";
import { PcmVoiceActivityDetector } from "../clients/browser/hermes-live-client.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const GATEWAY_PORT = 4601;
const S2S_PORT = 4602;
const HERMES_PORT = 4610;
const EVIDENCE_DIR = "/tmp/reconnect-drill";
const OWNER_IDENTITY = "agent:main:hermes-live:profile:default:user:voice";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Fake Hermes Agent API
// ---------------------------------------------------------------------------
function startFakeHermes() {
  const sessions = new Map();
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${HERMES_PORT}`);
    const reply = (value, status = 200) => { res.statusCode = status; res.end(JSON.stringify(value)); };
    const route = `${req.method} ${url.pathname}`;
    if (route === "GET /v1/capabilities") {
      return reply({
        object: "hermes.capabilities",
        model: "hermes-agent",
        features: Object.fromEntries([
          "run_submission", "run_status", "run_events_sse", "run_stop", "run_approval_response",
          "session_resources", "session_chat", "session_chat_streaming", "model_options",
          "session_model_lock", "skills_api",
        ].map((name) => [name, true])),
      });
    }
    if (route === "GET /api/model/options") return reply({ model: "drill-llm", provider: "drill" });
    if (route === "GET /v1/skills") return reply({ object: "list", data: [] });
    if (route === "GET /health") return reply({ status: "ok" });
    if (route === "GET /api/sessions") {
      const title = url.searchParams.get("title") ?? undefined;
      const data = [...sessions.values()]
        .filter((session) => title === undefined || session.title === title)
        .map((session) => ({ ...session, preview: "Voice conversation", message_count: 1 }));
      return reply({ object: "list", data });
    }
    if (route === "POST /api/sessions") {
      let body = ""; for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || "{}");
      const session = {
        id: `drill-hermes-${sessions.size + 1}`,
        ...(parsed.title ? { title: parsed.title } : {}),
        model: "drill-llm",
        last_active: Date.now(),
      };
      sessions.set(session.id, session);
      return reply({ object: "hermes.session", session });
    }
    if (req.method === "POST" && /^\/api\/sessions\/[^/]+\/chat$/.test(url.pathname)) {
      let body = ""; for await (const chunk of req) body += chunk;
      return reply({
        object: "hermes.session.chat.completion",
        session_id: url.pathname.split("/")[3],
        message: { role: "assistant", content: "Drill acknowledged." },
      });
    }
    if (route === "POST /v1/runs") return reply({ run_id: "run_drill_1", status: "running" });
    if (req.method === "GET" && /^\/v1\/runs\/[^/]+$/.test(url.pathname)) {
      return reply({ run_id: "run_drill_1", status: "running" });
    }
    if (req.method === "GET" && url.pathname.endsWith("/events")) {
      // SSE stream that stays open and quiet: the run keeps "running".
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 5_000);
      req.on("close", () => clearInterval(heartbeat));
      return;
    }
    if (req.method === "POST" && url.pathname.endsWith("/stop")) {
      return reply({ run_id: "run_drill_1", status: "cancelled" });
    }
    return reply({ error: "unexpected request" }, 404);
  });
  return new Promise((resolve) => {
    server.listen(HERMES_PORT, "127.0.0.1", () => resolve(server));
  });
}

// ---------------------------------------------------------------------------
// Fake speech-to-speech pipeline (the 8765 stand-in)
// ---------------------------------------------------------------------------
async function startFakeS2s() {
  const observed = { connections: 0, audioFrames: 0 };
  const wss = new WebSocketServer({ noServer: true });
  const server = createServer((req, res) => {
    // Any HTTP answer proves reachability; 426 is the honest ws-server reply
    // (the gateway's /status.json probe treats any answer as "up").
    res.writeHead(426, { "Content-Type": "text/plain" });
    res.end("Upgrade Required");
  });
  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });
  wss.on("connection", (ws) => {
    observed.connections += 1;
    const send = (event) => ws.send(JSON.stringify(event));
    const vad = new PcmVoiceActivityDetector(24000, { silenceMs: 700 });
    send({ type: "session.created", session: { id: "drill-speech" } });
    ws.on("message", (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.type === "input_audio_buffer.append") {
        observed.audioFrames += 1;
        const pcm = Buffer.from(event.audio, "base64");
        const samples = new Int16Array(pcm.length / 2);
        for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2);
        const activity = vad.process(samples);
        if (activity.started) send({ type: "input_audio_buffer.speech_started" });
        if (activity.stopped) send({ type: "input_audio_buffer.speech_stopped" });
      }
      if (event.type === "response.create") {
        send({ type: "response.created", response: { id: "reply" } });
        send({ type: "response.done", response: { id: "reply", status: "completed" } });
      }
    });
  });
  await new Promise((resolve) => server.listen(S2S_PORT, "127.0.0.1", resolve));
  const close = async () => {
    for (const ws of wss.clients) ws.terminate();
    for (const ws of wss.clients) ws.close?.();
    await new Promise((resolve) => server.close(() => resolve()));
    server.closeAllConnections?.();
  };
  return { close, observed };
}

// ---------------------------------------------------------------------------
// Gateway under test
// ---------------------------------------------------------------------------
const gatewayLog = [];
let gatewayChild = null;

function spawnGateway(directory) {
  const child = spawn(process.execPath, [join(root, "dist/cli.js"), "serve"], {
    env: {
      ...process.env,
      // Isolate completely from the live deployment's managed config.
      HERMES_LIVE_CONFIG_FILE: join(directory, "config.env"),
      HERMES_HOME: join(directory, "hermes-home"),
      HERMES_LIVE_HERMES_HOME: join(directory, "hermes-home"),
      HERMES_LIVE_PORT: String(GATEWAY_PORT),
      HERMES_BASE_URL: `http://127.0.0.1:${HERMES_PORT}`,
      HERMES_AGENT_API_SERVER_KEY: "drill-key",
      HERMES_LIVE_PROVIDER: "local",
      HERMES_LIVE_LOCAL_URL: `ws://127.0.0.1:${S2S_PORT}/v1/realtime`,
      HERMES_LIVE_LOCAL_OWNS_TURN_ROUTING: "true",
      HERMES_LIVE_TASK_STATE_FILE: join(directory, "tasks-v1.json"),
      HERMES_LIVE_VAD: "disabled",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  gatewayChild = child;
  const record = (stream, tag) => {
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) gatewayLog.push(`${new Date().toISOString()} ${tag} ${line}`);
      }
    });
  };
  record(child.stdout, "out");
  record(child.stderr, "err");
  child.on("exit", (code, signal) => {
    gatewayLog.push(`${new Date().toISOString()} --- gateway exited code=${code} signal=${signal}`);
  });
  return child;
}

async function waitForGatewayHealthy(timeoutMs = 15_000) {
  const began = Date.now();
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/health`);
      if (response.ok) return;
    } catch { /* not listening yet */ }
    if (Date.now() - began > timeoutMs) throw new Error("Gateway did not become healthy in time.");
    await delay(200);
  }
}

async function killGateway() {
  const child = gatewayChild;
  if (!child || child.exitCode !== null) return;
  child.kill("SIGKILL");
  await once(child, "exit");
}

// ---------------------------------------------------------------------------
// Drill
// ---------------------------------------------------------------------------
async function main() {
  await rm(EVIDENCE_DIR, { recursive: true, force: true });
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const directory = await mkdtemp(join(tmpdir(), "reconnect-drill-"));

  // Seed one RUNNING background task owned by the default voice identity so
  // reconnect snapshots have real state to re-hydrate.
  const now = Date.now();
  const queued = createTaskRecord({ ownerIdentity: OWNER_IDENTITY, input: "Watch the flange pressure report", now });
  const dispatching = transitionTaskRecord(queued, "dispatching", { now: now + 1 });
  const running = transitionTaskRecord(dispatching, "running", { now: now + 2, runId: "run_drill_1" });
  await writeFile(join(directory, "tasks-v1.json"), JSON.stringify({
    schemaVersion: 1,
    updatedAt: now + 2,
    tasks: [running],
  }, null, 2), { mode: 0o600 });

  const hermes = await startFakeHermes();
  let s2s = await startFakeS2s();
  spawnGateway(directory);
  await waitForGatewayHealthy();

  const browser = await chromium.launch({
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      `--use-file-for-fake-audio-capture=${join(root, "test/fixtures/hello.wav")}`,
    ],
  });
  const context = await browser.newContext({ permissions: ["microphone"] });
  const page = await context.newPage();
  const consoleLines = [];
  page.on("console", (message) => consoleLines.push(`[${message.type()}] ${message.text()}`));

  const stateText = () => page.locator("#state").textContent();
  const stateAttr = () => page.locator("#state").getAttribute("data-state");
  const shot = (name) => page.screenshot({ path: join(EVIDENCE_DIR, `${name}.png`) });

  try {
    // --- 1. Initial connection ------------------------------------------------
    await page.goto(`http://127.0.0.1:${GATEWAY_PORT}/?dev=1`);
    await page.waitForFunction(() => document.querySelector("#state").dataset.state === "armed", null, { timeout: 20_000 });
    check("initial connection arms the mic", true, `#state="${await stateText()}"`);

    await page.evaluate(() => {
      window.__drill = { messages: [], supervisor: [], audio: [] };
      const entity = window.__entity;
      entity.client.on("message", (message) => window.__drill.messages.push({
        type: message.type, reason: message.reason ?? null, at: Date.now(),
      }));
      entity.supervisor.on("change", (change) => window.__drill.supervisor.push({
        state: change.status.state,
        attempt: change.status.attempt,
        message: change.message ?? null,
        at: Date.now(),
      }));
      entity.audio.on("microphone", (event) => window.__drill.audio.push({ state: event.state, at: Date.now() }));
      entity.audio.on("error", (event) => window.__drill.audio.push({ error: String(event.error?.message || event.error), code: event.code ?? null, at: Date.now() }));
    });

    await page.waitForFunction(() => !document.querySelector("#task-line").hidden, null, { timeout: 10_000 });
    const taskLine = await page.locator("#task-line").textContent();
    check("seeded running task is visible", /Running/.test(taskLine ?? ""), JSON.stringify(taskLine));
    const status = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/status.json`).then((r) => r.json());
    check("/status.json reports the attached provider link",
      status.sessions?.providerAttached === 1 && status.providerLinks?.[0]?.state === "attached",
      `provider=${status.provider?.name} probe=${JSON.stringify(status.providerProbe)}`);
    await shot("01-connected-armed");

    // --- 2. Gateway dies mid-session ------------------------------------------
    await killGateway();
    await page.waitForFunction(() => ["reconnecting", "gateway-down"].includes(document.querySelector("#state").dataset.state), null, { timeout: 15_000 });
    await page.waitForFunction(() => /next in \d+(\.\d+)?s/.test(document.querySelector("#state").textContent), null, { timeout: 10_000 });
    const lostText = await stateText();
    check("gateway kill flips to visible reconnecting state", /reconnect|retry/i.test(lostText ?? ""), `#state[data-state=${await stateAttr()}]="${lostText}"`);
    check("Reconnect now button is offered", await page.locator("#reconnect").isVisible());
    const probeHeadlineOk = await page.waitForFunction(() => /Gateway not reachable/.test(document.querySelector("#state").textContent), null, { timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    check("gateway-unreachable headline appears once the probe fails", probeHeadlineOk, `"${await stateText()}"`);
    await shot("02-gateway-down-reconnecting");

    // --- 3. Forced reconnect during the backoff wait ---------------------------

    // A scheduled retry is in flight; confirm one fires on its timer.
    const attemptBeforeForce = await page.evaluate(() => window.__drill.supervisor.at(-1)?.attempt ?? 0);
    await page.locator("#reconnect").click();
    const forcedOk = await page.waitForFunction(() => {
      const events = window.__drill.supervisor;
      return events.some((event) => event.message?.includes("(button)"));
    }, null, { timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    const recentSupervisor = await page.evaluate(() => window.__drill.supervisor.slice(-4));
    check("Reconnect now forces an immediate attempt", forcedOk, JSON.stringify(recentSupervisor));
    const forcedEvents = await page.evaluate(() => window.__drill.supervisor.filter((event) => event.message?.includes("(button)")));
    check("forced attempt resets the backoff counter", forcedEvents.at(-1)?.attempt === 1, `attemptBeforeForce=${attemptBeforeForce} forcedAttempt=${forcedEvents.at(-1)?.attempt}`);
    // The forced attempt fails too (gateway still down) and reschedules.
    await page.waitForFunction(() => ["reconnecting", "gateway-down"].includes(document.querySelector("#state").dataset.state), null, { timeout: 10_000 });
    await shot("03-after-forced-attempt");

    // --- 4. Gateway returns; auto-reconnect re-hydrates ------------------------
    // SIGKILL leaves the task-store lock behind; clearing it mirrors the
    // documented `tasks unlock --confirm-no-gateway` runbook step.
    await rm(join(directory, "tasks-v1.json.lock"), { recursive: true, force: true });
    spawnGateway(directory);
    await waitForGatewayHealthy();
    const recovered = await page.waitForFunction(() => document.querySelector("#state").dataset.state === "armed", null, { timeout: 45_000 })
      .then(() => true)
      .catch(async () => {
        console.error("RECOVERY WAIT FAILED — page state:",
          JSON.stringify(await page.evaluate(() => ({
            supervisorState: window.__entity.supervisor.state,
            attempt: window.__entity.supervisor.attempt,
            clientState: window.__entity.client.state,
            micActive: window.__entity.audio.microphoneActive,
            micState: window.__entity.audio.microphoneState,
            audioTrail: window.__drill.audio.slice(-12),
            stateText: document.querySelector("#state").textContent,
          })).catch(() => undefined)));
        return false;
      });
    check("auto-reconnect recovers once the gateway is back", recovered, `#state[data-state=${await stateAttr()}]="${await stateText()}"`);

    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll("#log-transcript p")];
      return rows.some((row) => /Reconnected\. In-flight audio was lost\./.test(row.textContent ?? ""));
    }, null, { timeout: 10_000 })
      .then(() => check("reconnect announcement is logged in the conversation log", true))
      .catch(() => check("reconnect announcement is logged in the conversation log", false));

    const taskLineAfter = await page.locator("#task-line").textContent();
    check("task row survives the reconnect (snapshot re-hydration)", /Running/.test(taskLineAfter ?? ""), JSON.stringify(taskLineAfter));
    const snapshotReasons = await page.evaluate(() => window.__drill.messages.filter((m) => m.type === "task.snapshot").map((m) => m.reason));
    check("client received a reconnect task snapshot from the relaunched gateway",
      snapshotReasons.includes("reconnect"), JSON.stringify(snapshotReasons));
    const attachCount = gatewayLog.filter((line) => line.includes("realtime provider attached")).length;
    check("gateway logged a fresh provider attach after restart", attachCount >= 2, `attach lines=${attachCount}`);
    await shot("04-reconnected-task-intact");

    // --- 5. s2s outage with the gateway alive ----------------------------------
    await s2s.close();
    await page.waitForFunction(() => ["reconnecting", "gateway-down"].includes(document.querySelector("#state").dataset.state), null, { timeout: 15_000 });
    const pipelineHeadlineOk = await page.waitForFunction(() => /Voice pipeline down/.test(document.querySelector("#state").textContent), null, { timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    check("s2s outage is distinguished from a gateway outage", pipelineHeadlineOk, `"${await stateText()}"`);
    await shot("05-voice-pipeline-down");

    s2s = await startFakeS2s();
    await page.waitForFunction(() => document.querySelector("#state").dataset.state === "armed", null, { timeout: 45_000 });
    check("speech pipeline recovery reconnects automatically", true, `#state="${await stateText()}"`);
    const closeLines = gatewayLog.filter((line) => line.includes("realtime provider session closed")).length;
    const attachLinesFinal = gatewayLog.filter((line) => line.includes("realtime provider attached")).length;
    check("gateway logged provider detach and re-attach across the s2s outage",
      closeLines >= 1 && attachLinesFinal >= 3, `closed=${closeLines} attached=${attachLinesFinal}`);
    await shot("06-recovered-after-s2s-restart");

    const hermesLiveConsole = consoleLines.filter((line) => line.includes("[hermes-live]"));
    check("client console carries timestamped reconnect history", hermesLiveConsole.length >= 4, `${hermesLiveConsole.length} lines`);
  } catch (error) {
    console.error("DRILL ERROR:", error);
    process.exitCode = 1;
  } finally {
    await writeFile(join(EVIDENCE_DIR, "evidence.json"), JSON.stringify({
      at: new Date().toISOString(),
      results,
      gatewayLogTail: gatewayLog.slice(-160),
      consoleHermesLive: consoleLines.filter((line) => line.includes("[hermes-live]")),
    }, null, 2)).catch(() => undefined);
    await page.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    await killGateway();
    await rm(join(directory, "tasks-v1.json.lock"), { recursive: true, force: true }).catch(() => undefined);
    await s2s.close().catch(() => undefined);
    hermes.closeAllConnections?.();
    await new Promise((resolve) => hermes.close(() => resolve()));
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }

  await writeFile(join(EVIDENCE_DIR, "evidence.json"), JSON.stringify({
    at: new Date().toISOString(),
    results,
    gatewayLogTail: gatewayLog.slice(-160),
    consoleHermesLive: consoleLines.filter((line) => line.includes("[hermes-live]")),
  }, null, 2));

  const failed = results.filter((result) => !result.ok);
  console.log(`\nDrill complete: ${results.length - failed.length}/${results.length} checks passed.`);
  console.log(`Evidence: ${EVIDENCE_DIR}/ (screenshots + evidence.json)`);
  if (failed.length) {
    console.log("Failed checks:");
    for (const failure of failed) console.log(`  - ${failure.name}: ${failure.detail}`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
