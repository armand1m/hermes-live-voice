import { HermesLiveClient, HermesLiveAudio } from "./hermes-live-client.js";
import { ConnectionSupervisor, formatSeconds, isConnectionErrorCode } from "./connection-supervisor.js";
import { AgentStateController, SpeechAnalysis, TextVisemeScheduler, VisemeEstimator } from "./entity-state.js";
import { VoiceEntityScene } from "./entity-scene.js";
import { createDiagnosticsOverlay } from "./diagnostics.js";
import { createSfx, loadAudioPrefs, saveAudioPrefs, resolveModeCue, DEFAULT_MASTER_VOLUME } from "./sfx.js";
import { renderMarkdown } from "./markdown.js";
import { createTaskNarrator } from "./task-narrator.js";

const state = document.querySelector("#state");
const detail = document.querySelector("#detail");
const mute = document.querySelector("#mute");
const meter = document.querySelector("#meter i");
const canvas = document.querySelector("#field");
const transcriptList = document.querySelector("#transcript");
const agentLine = document.querySelector("#agent-line");
const metaLine = document.querySelector("#meta-line");
const notice = document.querySelector("#notice");
const taskLine = document.querySelector("#task-line");
const presenceLabel = document.querySelector("#presence-label");
const presenceDetail = document.querySelector("#presence-detail");
const inputSignal = document.querySelector("#signal-input");
const outputSignal = document.querySelector("#signal-output");
const reconnectButton = document.querySelector("#reconnect");
const takeoverButton = document.querySelector("#takeover");

// The operator can bootstrap a tab with #token=... once. Keep it only in
// sessionStorage so reloads do not require the secret again, while closing
// the tab clears the credential. Never use localStorage or put it in HTML.
const tokenKey = "hermes-live-auth-token";
const conversationKey = "hermes-live-conversation-id";
const hashParams = new URLSearchParams(location.hash.slice(1));
const hashToken = hashParams.get("token")?.trim();
const devMode = hashParams.has("dev") || new URLSearchParams(location.search).get("dev") === "1";
const noDiagnostics = hashParams.has("no-diagnostics")
  || new URLSearchParams(location.search).get("no-diagnostics") === "1";
const noSfx = hashParams.has("no-sfx")
  || new URLSearchParams(location.search).get("no-sfx") === "1";
// Gateway task-log narration is pure enhancement; this keeps the drawer on
// raw gateway text per tab.
const noTaskAi = hashParams.has("no-ai")
  || new URLSearchParams(location.search).get("no-ai") === "1";
const noReconnect = hashParams.has("no-reconnect")
  || new URLSearchParams(location.search).get("no-reconnect") === "1";
let token;
try {
  if (hashToken) sessionStorage.setItem(tokenKey, hashToken);
  token = hashToken || sessionStorage.getItem(tokenKey) || undefined;
} catch {
  token = hashToken || undefined;
}
if (location.hash) history.replaceState(null, "", location.pathname + location.search);

// The bundled page may be mounted at /voice (for example through Tailscale
// Serve). Keep the WebSocket on that same mount instead of falling back to
// the host's unrelated root service.
const mountPath = location.pathname.endsWith("/")
  ? location.pathname.slice(0, -1)
  : location.pathname;
const url = new URL(`${mountPath}/v1/live`, location.href);
url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
// Persistent mode lets the gateway resolve the durable per-user voice thread,
// so every tab, browser restart, and device continues the same conversation.
const client = new HermesLiveClient({ url: url.href, token, conversation: { mode: "persistent" } });
// disposeOnClientClose keeps the microphone warm across reconnects: capture
// frames buffer in preroll while the link is down and resume without a new
// getUserMedia once it returns. Without auto-reconnect, a close still tears
// the audio pipeline down as before.
const audio = new HermesLiveAudio(client, {
  workletUrl: `${mountPath}/mic-worklet.js`,
  disposeOnClientClose: noReconnect,
});

// Connection supervision: the client SDK reports loss; this layer retries
// with exponential backoff and keeps the loss visible. `#no-reconnect` /
// `?no-reconnect=1` restores the previous single-shot connect behavior.
const supervisor = new ConnectionSupervisor(client, {
  conversation: { mode: "persistent" },
  fetchStatus: () => fetch(`${mountPath}/status.json`, { headers: { Accept: "application/json" } })
    .then(async (response) => {
      if (!response.ok) return null;
      const parsed = await response.json();
      return {
        reachable: true,
        provider: parsed.provider?.name ?? null,
        model: parsed.provider?.model ?? null,
        providerReachable: typeof parsed.providerProbe?.reachable === "boolean"
          ? parsed.providerProbe.reachable
          : null,
      };
    })
    .catch(() => null),
});

// ---------------------------------------------------------------------------
// Visual state pipeline: voice events → AgentStateController → scene.
// The renderer never touches protocol events; the DOM never touches WebGL.
// ---------------------------------------------------------------------------

const reducedMotionQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)");
const reducedMotion = Boolean(reducedMotionQuery?.matches);
const controller = new AgentStateController({ reducedMotion });
const analysis = new SpeechAnalysis(() => audio.playbackAnalyser);
const visemes = new VisemeEstimator();
// Text-synchronized lipsync: the words being revealed feed a viseme queue
// whose playback is amplitude-gated by the real audio envelope.
const textVisemes = new TextVisemeScheduler();

// Optional synthetic viseme source installed by the developer playground.
let syntheticVisemes = null;

// Always-on diagnostics overlay (top-right corner, recedes with the mode).
// Opt out with ?no-diagnostics=1 / #no-diagnostics. It reads the same client
// and audio event stream as the visual pipeline and polls the gateway's
// /v1/metrics on the page's mount path.
if (!noDiagnostics) {
  const diagnostics = createDiagnosticsOverlay({
    client,
    audio,
    metricsUrl: `${mountPath}/v1/metrics`,
    getToken: () => token,
    getFps: () => fps,
  });
  window.addEventListener("pagehide", () => diagnostics.dispose(), { once: true });
}

// Interface sound cues: every entity state, task transition and mic toggle
// gets a short synthesized signature (see sfx.js). Preferences persist across
// sessions; ?no-sfx=1 forces silence for this tab only. The controller names
// what happened; the cue palette decides how it sounds.
const audioPrefs = loadAudioPrefs();
const sfx = createSfx({
  enabled: !noSfx && audioPrefs.effects !== false,
  volume: audioPrefs.effectsVolume ?? DEFAULT_MASTER_VOLUME,
  isSpeaking: () => playbackActive,
});
controller.onCue = (cue) => sfx.play(cue);

// Mouth rig targets derived from viseme weights (see entity-facekit.js).
const mouth = { jaw: 0, wide: 0, round: 0, narrow: 0, press: 0, teeth: 0, energy: 0 };
const VISEME_KEYS = ["closed", "open", "wide", "round", "narrow", "teeth"];
// In-place blend of audio and text visemes (no per-frame allocation).
const blended = { closed: 1, open: 0, wide: 0, round: 0, narrow: 0, teeth: 0 };

let scene = null;
let webglFailed = false;
try {
  scene = new VoiceEntityScene(canvas, { reducedMotion });
} catch (error) {
  webglFailed = true;
  window.__entityError = String(error && error.stack || error);
  document.body.classList.add("no-webgl");
}

function status(value, text) {
  state.dataset.state = value;
  state.textContent = text;
}

function showError(event) {
  status("error", "Voice needs attention");
  detail.textContent = event.error?.message || event.message || String(event);
  controller.error();
  notice.textContent = detail.textContent;
  notice.hidden = false;
  window.clearTimeout(showError.noticeTimer);
  showError.noticeTimer = window.setTimeout(() => { notice.hidden = true; }, 5200);
}

function handleClientError(event) {
  if (!noReconnect) {
    // While the supervisor owns the link, connection-class failures and
    // mid-attempt session errors are retry outcomes, not new alarms: the
    // reconnect status line is the honest display for them.
    if (isConnectionErrorCode(event.code)) return;
    if (!client.connected) return;
  }
  showError(event);
}

client.on("error", handleClientError);
audio.on("error", (event) => {
  // Speech that starts while disconnected cannot be sent; the reconnect
  // status line already explains the outage, so do not alarm for it.
  if (!noReconnect && event.code === "audio_send_failed" && !client.connected) return;
  showError(event);
});
client.on("session.error", handleClientError);
client.on("session.ready", (event) => {
  controller.connectionState("ready");
  const sessionId = event.conversation?.sessionId;
  if (sessionId) {
    try { sessionStorage.setItem(conversationKey, sessionId); } catch { /* storage may be blocked */ }
  }
  const provider = event.realtime?.provider;
  const model = event.realtime?.model || event.model;
  baseMeta = [provider, model].filter(Boolean).join(" · ");
  metaLine.textContent = baseMeta;
});

client.on("statechange", (event) => {
  const map = { ready: "ready", connecting: "connecting", failed: "failed", closed: "closed", closing: "closed", idle: "closed" };
  controller.connectionState(map[event.state] || "connecting");
});
client.on("close", () => {
  mute.disabled = true;
});

// --- reconnect status surface -------------------------------------------------
// One renderer for both the supervisor's change events and the frame loop's
// countdown ticks: the headline must stay truthful second by second.
function reconnectCopy(snapshot) {
  const attempt = Math.max(1, Number(snapshot.attempt) || 1);
  if (snapshot.state === "connecting") {
    return snapshot.everConnected
      ? ["reconnecting", `Reconnecting — attempt ${attempt} in progress…`, "The voice link dropped. Reconnecting now."]
      : ["connecting", "Connecting…", "Allow microphone access to listen continuously."];
  }
  const next = formatSeconds(snapshot.nextAttemptInMs ?? 0);
  if (snapshot.everConnected && snapshot.gateway === null) {
    return [
      "gateway-down",
      `Gateway not reachable — retrying; press Reconnect now to force (attempt ${attempt}, next in ${next})`,
      "The gateway did not answer. Attempts continue automatically.",
    ];
  }
  if (snapshot.gateway?.providerReachable === false) {
    return [
      "reconnecting",
      `Voice pipeline down — reconnecting (attempt ${attempt}, next in ${next})`,
      "The gateway is up, but its speech-to-speech link is not answering yet.",
    ];
  }
  return snapshot.everConnected
    ? [
        "reconnecting",
        `Connection lost — reconnecting (attempt ${attempt}, next in ${next})`,
        "The voice link dropped. In-flight audio was lost.",
      ]
    : [
        "connecting",
        `Connecting — attempt ${attempt}, next in ${next}`,
        "The voice gateway is not answering yet.",
      ];
}

let micRequested = false;
function renderReconnectStatus(change) {
  const snapshot = supervisor.status;
  if (snapshot.state === "connected") {
    reconnectButton.hidden = true;
    mute.disabled = false;
    // A recovery must not leave a stale reconnect headline behind when the
    // presence mode happened not to change across the outage.
    if (["reconnecting", "gateway-down"].includes(state.dataset.state)) {
      if (audio.microphoneActive) {
        status("armed", "Listening");
        detail.textContent = "Reconnected. You can keep talking.";
      } else {
        status("muted", "Reconnected");
        detail.textContent = "The voice link is back. Unmute when you’re ready.";
      }
    }
    if (!micRequested) {
      // Auto-arm continuous capture on first connect (previous boot behavior).
      micRequested = true;
      audio.startMicrophone().catch(() => { micRequested = false; mute.textContent = "Unmute"; });
    } else if (!audio.microphoneActive) {
      audio.startMicrophone().catch(() => undefined);
    }
    if (change?.message) logSystemLine(change.message);
    return;
  }
  if (snapshot.state !== "reconnecting" && snapshot.state !== "connecting") return;
  const [stateValue, headline, detailText] = reconnectCopy(snapshot);
  status(stateValue, headline);
  detail.textContent = detailText;
  const offerButton = snapshot.state === "reconnecting" || snapshot.attempt > 1;
  reconnectButton.hidden = !offerButton;
  notice.hidden = true;
  if (change?.message) logSystemLine(change.message);
}

/** Timestamped system row in both transcript views + console, for connection history. */
function logSystemLine(text) {
  const clock = new Date().toTimeString().slice(0, 8);
  addTaskRow(`⟳ ${clock} ${text}`);
  console.info(`[hermes-live] ${clock} ${text}`);
}

reconnectButton.addEventListener("click", () => {
  logSystemLine("Reconnect requested now.");
  void supervisor.forceReconnect("button");
});

supervisor.on("change", renderReconnectStatus);

// --- voice ownership (newest page wins) ----------------------------------------
// A newer tab claimed this owner's voice: this page becomes view-only. Turns
// are already dropped server-side; stop the mic so we neither transcribe nor
// answer, and offer a one-click take-over that reconnects as the newest page.
client.on("session.demoted", () => {
  logSystemLine("Voice is active in a newer tab — this page is view-only.");
  status("muted", "Voice active elsewhere");
  detail.textContent = "A newer tab owns the microphone. This page stays view-only; take over to bring the voice here.";
  takeoverButton.hidden = false;
  void audio.stopMicrophone({ endTurn: false }).catch(() => undefined);
});
client.on("session.ready", () => {
  takeoverButton.hidden = true;
});
takeoverButton.addEventListener("click", () => {
  logSystemLine("Take-over requested: reconnecting as the newest session.");
  void supervisor.forceReconnect("takeover");
});

// --- microphone ------------------------------------------------------------
audio.on("microphone", (event) => {
  controller.microphoneState(event.state);
  mute.textContent = event.active ? "Mute" : "Unmute";
  mute.setAttribute("aria-pressed", String(!event.active));
  if (event.active) {
    controller.resumeRequested();
    sfx.play("unmute");
    status("armed", "Listening");
    detail.textContent = "Talk naturally. I’ll hear when you finish.";
    syncStatusDetail();
  } else if (event.state === "idle" && controller.paused) {
    status("paused", "Listening paused");
    detail.textContent = "Resume with the microphone control.";
  } else if (event.state === "idle") {
    // Disconnect teardown also emits a trailing idle microphone event; only
    // a live session means the user actually muted.
    if (client.connected) sfx.play("mute");
    status("muted", "Microphone muted");
    detail.textContent = "Unmute when you’re ready to continue.";
  }
});

// --- user speech (local VAD + provider VAD) ---------------------------------
audio.on("input.level", (event) => controller.userLevel(event.level));
audio.on("input.speech_started", () => controller.userSpeechStarted());
audio.on("input.speech_stopped", () => {
  controller.userSpeechEnded();
  // The utterance was captured: a distinct inward pulse through the field.
  scene?.pulse(0.45);
});
client.on("input.speech_started", () => controller.userSpeechStarted());

client.on("input.pause_requested", () => {
  controller.pauseRequested();
  void audio.stopMicrophone({ endTurn: false }).catch(() => undefined);
});

// Agent-requested audio settings: the gateway relays explicit voice commands
// ("unmute me", "turn the sound effects off") as advisory requests. The
// client stays in charge of its own hardware — and a tab booted with
// ?no-sfx=1 stays silent no matter what is requested, while normal sessions
// honor and persist the preferences.
client.on("client.audio_settings", (event) => {
  if (event.microphone === "paused") {
    controller.pauseRequested();
    void audio.stopMicrophone({ endTurn: false }).catch(() => undefined);
  } else if (event.microphone === "active" && client.connected) {
    void audio.startMicrophone().catch(showError);
  }
  if (event.effects !== undefined || event.effectsVolume !== undefined) {
    if (!noSfx) {
      // An "off" confirmation must sound while the cues still can.
      if (event.effects === false) sfx.play("mute");
      if (event.effects !== undefined) sfx.setEnabled(event.effects);
      if (event.effectsVolume !== undefined) {
        sfx.setVolume(event.effectsVolume);
        sfx.play("taskTick");
      }
      if (event.effects === true) sfx.play("satisfied");
    }
    saveAudioPrefs({
      ...(event.effects !== undefined ? { effects: event.effects } : {}),
      ...(event.effectsVolume !== undefined ? { effectsVolume: event.effectsVolume } : {}),
    });
    const soundBits = [];
    if (event.effects !== undefined) soundBits.push(event.effects ? "on" : "off");
    if (event.effectsVolume !== undefined) soundBits.push(`volume ${Math.round(event.effectsVolume * 100)}%`);
    addTaskRow(`♪ interface sounds — ${soundBits.join(", ")}`);
  }
});

// --- agent pipeline ----------------------------------------------------------
client.on("response.started", () => {
  controller.responseStarted();
  scene?.pulse(0.8);
});
client.on("response.completed", () => {
  controller.responseCompleted();
  scene?.pulse(0.6);
});
client.on("response.cancelled", () => controller.responseCancelled());
client.on("response.failed", () => controller.responseCancelled());

let playbackActive = false;
client.on("audio.output", (event) => {
  controller.ttsFrame();
  return audio.play(event).catch(showError);
});
audio.on("playback", (event) => {
  playbackActive = event.active;
});

// --- transcript (kinetic, but the accumulation contract is unchanged) -------
const logTranscript = document.querySelector("#log-transcript");
let current;
let currentLog;
client.on("transcript.delta", (event) => {
  if (!current || current.dataset.speaker !== event.speaker || current.dataset.final === "true") {
    current = document.createElement("p");
    current.dataset.speaker = event.speaker;
    transcriptList.append(current);
    currentLog = document.createElement("p");
    currentLog.dataset.speaker = event.speaker;
    logTranscript.append(currentLog);
    while (logTranscript.children.length > 200) logTranscript.firstChild.remove();
    while (transcriptList.children.length > 100) transcriptList.firstChild.remove();
    revealIndex = 0;
    revealedText = "";
    lipsyncCursor = 0;
    agentLine.textContent = "";
    // A new utterance invalidates any queued lipsync articulation.
    textVisemes.reset();
  }
  // Final provider transcripts are authoritative, not an additional delta.
  current.textContent = event.final ? event.text : current.textContent + event.text;
  current.dataset.final = String(Boolean(event.final));
  // One history row follows interim text through its authoritative final.
  currentLog.textContent = current.textContent;
  currentLog.dataset.final = current.dataset.final;
  // Textual cues add expression, without claiming to measure emotion.
  if (event.final && event.speaker === "assistant") {
    if (/\b(sorry|unfortunately|failed|unable)\b/i.test(event.text)) controller.pulseExpression("concerned", 2.8);
    else if (/\b(done|completed|fixed|successfully|glad)\b/i.test(event.text)) controller.pulseExpression("satisfied", 2.4);
    else if (/\b(uncertain|not sure|might|perhaps)\b/i.test(event.text)) controller.pulseExpression("uncertain", 2.4);
    else if (event.text.trim().endsWith("?")) controller.pulseExpression("curious", 2.0);
  }
  document.querySelector("#log-empty")?.setAttribute("hidden", "");
  const count = document.querySelector("#log-count");
  if (count) count.textContent = String(logTranscript.children.length).padStart(2, "0");
  if (event.speaker === "user") controller.transcribing();
  current.scrollIntoView({ block: "nearest" });
});

// Word-by-word reveal of the agent line, loosely paced by live speech energy
// rather than text arrival, then completed when speech ends.
let revealIndex = 0;
let revealedText = "";
function updateAgentReveal(visual) {
  if (!current || current.dataset.speaker !== "assistant") return;
  const full = current.textContent;
  if (revealIndex >= full.length) return;
  const speaking = visual.speechActivity > 0.02;
  if (speaking) {
    // Advance over word boundaries at a rate driven by audio energy.
    let next = revealIndex + Math.max(1, Math.round(2 + visual.speechActivity * 26));
    while (next < full.length && full[next] !== " ") next += 1;
    revealIndex = Math.min(full.length, next);
  } else if (visual.mode !== "speaking") {
    revealIndex = full.length;
  }
  const text = full.slice(0, revealIndex);
  if (text !== revealedText) {
    revealedText = text;
    agentLine.textContent = text;
  }
}

// Lipsync owns its own cursor over the utterance, paced like real speech
// (roughly 11–20 characters per second, nudged by the speech envelope). The
// UI reveal above is a quick kinetic cascade — far faster than the voice —
// so feeding the mouth from it would articulate whole sentences in a blink.
let lipsyncCursor = 0;
function feedLipsync(dt, visual) {
  if (!current || current.dataset.speaker !== "assistant") return;
  const full = current.textContent;
  if (lipsyncCursor > full.length) lipsyncCursor = full.length;
  if (visual.speechActivity <= 0.02) return;
  const cps = 11 + 9 * Math.min(1, Math.max(0, visual.speechActivity));
  const next = lipsyncCursor + dt * cps;
  if (Math.floor(next) > Math.floor(lipsyncCursor)) {
    textVisemes.feed(full.slice(Math.floor(lipsyncCursor), Math.floor(next)));
  }
  lipsyncCursor = next;
}

// --- tasks / tools -----------------------------------------------------------
const toolChips = [0, 1, 2].map((i) => document.querySelector(`#tool-chip-${i}`));
const TOOL_TERMS = /terminal|bash|shell|read|write|edit|search|file|browser|code|git|python|node/i;
function toolLabel(task, message) {
  const progress = message?.progress?.message || task.progress?.message;
  if (progress) {
    const match = progress.match(/using\s+([A-Za-z ]{3,28}):/);
    if (match) return match[1].trim().toLowerCase();
    return progress.length > 42 ? progress.slice(0, 40).trimEnd() + "…" : progress;
  }
  return task.title || "task";
}

// Deferred answers: the receipt completed the response, but Hermes' answer is
// still computing. Keep the "making sense of it" presence alive until it lands
// (entity-state's thinking would otherwise decay after ~30 s).
let deferredPendingCount = 0;
client.on("deferred.pending", () => {
  deferredPendingCount += 1;
  controller.responseActivity();
});
client.on("deferred.delivered", () => {
  deferredPendingCount = Math.max(0, deferredPendingCount - 1);
});

client.on("task.updated", ({ task, message }) => {
  const type = message.type;
  if (type === "task.accepted" || type === "task.started") {
    controller.toolStarted();
    scene?.toolPacketStart(task.taskId, toolLabel(task, message));
    // "accepted" can precede "started" by seconds: cue the start only, like
    // the transcript row does.
    if (type === "task.started") sfx.play("taskStarted");
  } else if (type === "task.progress") {
    controller.toolActivity();
    controller.responseActivity();
    scene?.pulse(0.3);
    scene?.toolPacketStart(task.taskId, toolLabel(task, message));
    sfx.play("taskTick");
  } else if (type === "task.completed") {
    controller.toolEnded(true);
    controller.taskTerminal("completed");
    scene?.toolPacketEnd(task.taskId, true);
  } else if (type === "task.failed" || type === "task.unknown") {
    controller.toolEnded(false);
    controller.taskTerminal(type === "task.failed" ? "failed" : "unknown");
    scene?.toolPacketEnd(task.taskId, false);
  } else if (type === "task.cancelled" || type === "task.stopping") {
    scene?.toolPacketEnd(task.taskId, true);
    addTaskRow(`◇ ${toolLabel(task, message)} — ${type === "task.stopping" ? "stopping" : "cancelled"}`);
  }
  if (type === "task.started") addTaskRow(`▸ ${toolLabel(task, message)} — started`);
  else if (type === "task.completed") addTaskRow(`✓ ${toolLabel(task, message)} — done`);
  else if (type === "task.failed") addTaskRow(`✕ ${toolLabel(task, message)} — failed`);
  else if (type === "task.unknown") addTaskRow(`? ${toolLabel(task, message)} — unknown`);
  renderTaskLine();
  syncStatusDetail();
});

client.on("tasks.changed", ({ activeTasks }) => {
  controller.taskWaitingChanged(activeTasks.length > 0);
  if (!activeTasks.length && state.dataset.state === "waiting") {
    status("armed", "Listening");
    detail.textContent = "";
  }
  renderTaskLine();
  syncStatusDetail();
});

function renderTaskLine() {
  const tasks = client.activeTasks || [];
  if (!tasks.length) {
    taskLine.textContent = "";
    taskLine.hidden = true;
    return;
  }
  taskLine.hidden = false;
  const first = tasks[0];
  const label = first.progress?.message || first.title || first.state;
  taskLine.textContent = `Running · ${tasks.length > 1 ? `${tasks.length} · ` : ""}${label}`.slice(0, 72);
}

/** Compact task-lifecycle row in both transcript views; never disturbs streaming utterances. */
function addTaskRow(text) {
  for (const list of [transcriptList, logTranscript]) {
    const row = document.createElement("p");
    row.dataset.speaker = "system";
    row.dataset.final = "true";
    row.textContent = text;
    list.append(row);
    while (list.children.length > (list === logTranscript ? 200 : 100)) list.firstChild.remove();
  }
}

/** One place for the status detail line: listening never hides running work. */
function syncStatusDetail() {
  const tasks = client.activeTasks || [];
  if (!tasks.length) return;
  const count = `${tasks.length} task${tasks.length === 1 ? "" : "s"} running`;
  if (audio.microphoneActive) {
    detail.textContent = `Listening · ${count} — keep talking`;
  } else {
    detail.textContent = `${count}. You can keep talking.`;
  }
}

// --- connection --------------------------------------------------------------
mute.addEventListener("click", async () => {
  // Resume the cue context synchronously inside the gesture, before any
  // await — the browser only unlocks audio from the gesture task itself.
  sfx.prime();
  mute.disabled = true;
  try {
    if (audio.microphoneActive) { micRequested = false; await audio.stopMicrophone({ endTurn: true }); }
    else { await audio.primePlayback(); micRequested = true; await audio.startMicrophone(); }
  } catch (e) { showError(e); } finally { mute.disabled = !client.connected; }
});

// ---------------------------------------------------------------------------
// Frame loop: one RAF drives controller, scene and the few per-frame DOM
// touches. Nothing here allocates beyond small strings at event cadence.
// ---------------------------------------------------------------------------

let lastCanvasState = "";
let lastBodyMode = "";
let lastAccentCss = "";
let fps = 60;
let debugFrame = null;
let baseMeta = "";
let lastPresence = "";
const presenceCopy = {
  dormant: ["Establishing connection", "Preparing your voice session."],
  offline: ["Connection offline", "Your conversation remains visible."],
  idle: ["Ready when you are", "Talk naturally. You can interrupt a reply."],
  listening: ["I’m listening", "Your speech is being captured in real time."],
  thinking: ["Making sense of it", "Preparing a response from your conversation."],
  tool: ["Working with Hermes", "Your agents are at work. You can keep talking."],
  waiting: ["Hermes is on it", "Background tasks are running. You can keep talking."],
  speaking: ["Speaking with you", "Speak at any time to interrupt."],
  paused: ["Listening paused", "Unmute when you’re ready to continue."],
  error: ["Voice needs attention", "Check the connection notice for details."],
};

function frame(now) {
  frameHandle = requestAnimationFrame(frame);
  if (document.hidden) return;
  const dt = Math.min(0.05, (now - (frame.last || now)) / 1000);
  frame.last = now;
  if (dt <= 0) return;
  fps = fps * 0.95 + (1 / dt) * 0.05;

  const speakingNow = audio.playbackSources.size > 0;
  analysis.update(dt, speakingNow);
  controller.speechRaw = analysis.rms;
  controller.update(dt, { speakingNow, micActive: audio.microphoneActive });
  const visual = controller.readout();
  const presenceMode = visual.mode === "idle" && !audio.microphoneActive ? "paused" : visual.mode;
  const deferredWaiting = deferredPendingCount > 0 && !["speaking", "tool"].includes(presenceMode);
  const presenceKey = presenceMode + (deferredWaiting ? "+deferred" : "");
  if (presenceKey !== lastPresence) {
    lastPresence = presenceKey;
    const copy = deferredWaiting
      ? ["Making sense of it", "Hermes is preparing your answer."]
      : (presenceCopy[presenceMode] || presenceCopy.idle);
    if (presenceLabel) presenceLabel.textContent = copy[0];
    if (presenceDetail) presenceDetail.textContent = copy[1];
    if (client.connected && presenceMode !== "error") {
      if (state.dataset.state === "error") state.dataset.state = audio.microphoneActive ? "armed" : "muted";
      state.textContent = copy[0];
      detail.textContent = copy[1];
    }
  }

  // Live "next attempt in Xs" countdown while a reconnect is scheduled.
  if (!noReconnect && !client.connected
    && (supervisor.state === "reconnecting" || supervisor.state === "connecting")) {
    const [stateValue, headline] = reconnectCopy(supervisor.status);
    if (state.dataset.state !== stateValue) state.dataset.state = stateValue;
    if (headline && headline !== state.textContent) state.textContent = headline;
  }

  // Visemes: real outgoing-audio analysis, overridden by the synthetic debug
  // driver, articulation-corrected by the text scheduler when it is actively
  // tracking revealed speech. Text shapes the mouth; audio paces it.
  const w = syntheticVisemes ? syntheticVisemes() : visemes.update(analysis, dt);
  const tw = textVisemes.update(dt, analysis.rms);
  const textMix = syntheticVisemes ? 0 : textVisemes.active;
  for (const key of VISEME_KEYS) {
    blended[key] = w[key] + (tw[key] - w[key]) * textMix;
  }
  // Jaw aperture is deliberately restrained: vowels part the lips, they
  // don't gape. Most articulation reads through the lip shape channels.
  mouth.jaw = blended.open * 0.6 + blended.round * 0.3 + blended.narrow * 0.08;
  mouth.wide = Math.max(0, blended.wide * 0.9 + blended.teeth * 0.2 - blended.round * 0.3);
  mouth.round = blended.round + blended.narrow * 0.55;
  mouth.narrow = blended.narrow;
  mouth.press = blended.teeth * 0.5 + blended.closed * 0.35;
  mouth.teeth = blended.teeth;
  mouth.energy = analysis.rms;

  // Contract surface for assistive tech and e2e: canvas[data-state].
  if (visual.canvasState !== lastCanvasState) {
    lastCanvasState = visual.canvasState;
    canvas.dataset.state = lastCanvasState;
  }
  if (visual.mode !== lastBodyMode) {
    const previousMode = lastBodyMode;
    lastBodyMode = visual.mode;
    document.body.dataset.mode = lastBodyMode;
    // Mode changes are the entity's own vocabulary, so they carry the state
    // cues (connected/disconnected/error/thinking/tool/waiting/speaking/
    // paused/idle-return). Dev-pinned modes sound exactly like live ones.
    const cue = resolveModeCue(previousMode, lastBodyMode, {
      micActive: audio.microphoneActive,
      connected: client.connected,
    });
    if (cue) sfx.play(cue);
  }

  if (scene) {
    scene.render(dt, visual, mouth);
    // Accent as a CSS variable for the overlay's state tint.
    if (scene.accent.cssPrimary !== lastAccentCss) {
      lastAccentCss = scene.accent.cssPrimary;
      document.documentElement.style.setProperty("--accent-live", lastAccentCss);
    }
    // Peripheral tool chips ride on projected packet anchors.
    for (let i = 0; i < toolChips.length; i++) {
      const chip = toolChips[i];
      const packet = scene.packets[i];
      if (!chip || !packet) continue;
      if (packet.phase === "idle" || packet.screen[3] <= 0) {
        chip.hidden = true;
        continue;
      }
      if (chip.hidden || chip.textContent !== packet.label) {
        chip.textContent = packet.label;
        chip.hidden = false;
      }
      // Clamp into the viewport so labels stay readable beside the head on
      // any aspect ratio. The reserved width tracks the CSS chip max-width,
      // which shrinks on narrow viewports (240px desktop, 145px mobile).
      const chipBudget = Math.min(250, Math.max(120, window.innerWidth * 0.45));
      const chipX = Math.min(Math.max(4, packet.screen[0]), window.innerWidth - chipBudget);
      const chipY = Math.min(Math.max(4, packet.screen[1]), window.innerHeight - 44);
      chip.style.transform = `translate(${Math.round(chipX)}px, ${Math.round(chipY)}px)`;
    }
  }

  // Microphone level meter (transform only — no layout).
  meter.style.transform = `scaleX(${Math.min(1, visual.micLevel * (visual.listening > 0.3 ? 1 : 0.25)).toFixed(3)})`;
  if (inputSignal) inputSignal.style.transform = `scaleX(${Math.min(1, visual.micLevel).toFixed(3)})`;
  if (outputSignal) outputSignal.style.transform = `scaleX(${Math.min(1, analysis.rms).toFixed(3)})`;

  // Latency readout while the entity reasons.
  {
    const { perceive, respond } = visual.latency;
    const parts = [];
    if (perceive !== null) parts.push(`perceive ${perceive}ms`);
    if (respond !== null) parts.push(`respond ${respond}ms`);
    const text = [baseMeta, ...parts].filter(Boolean).join(" · ");
    if (text !== metaLine.textContent) metaLine.textContent = text;
  }

  updateAgentReveal(visual);
  feedLipsync(dt, visual);
  debugFrame?.(dt);
}

// ---------------------------------------------------------------------------
// Developer playground (?dev=1 or #dev) — never present in production.
// ---------------------------------------------------------------------------

if (devMode) {
  // Development introspection handle (never defined in production).
  window.__entity = { controller, scene, audio, client, supervisor, mouth, analysis, sfx };
}
if (devMode && !webglFailed) {
  import("./entity-debug.js").then(({ createDebugPanel }) => {
    const panel = createDebugPanel({
      controller,
      scene,
      getStats: () => ({ fps: Math.round(fps), drawCalls: scene.renderer.drawCalls }),
      onSyntheticVisemes(getWeights) {
        syntheticVisemes = getWeights;
      },
    }, false);
    debugFrame = (dt) => panel.frame(dt);
    window.addEventListener("pagehide", () => panel.dispose(), { once: true });
  }).catch(() => { /* debug tooling is optional */ });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  if (noReconnect) {
    // Escape hatch: single-shot connect with the historical one-retry fallback.
    try {
      await client.connect();
      mute.disabled = false;
      await audio.startMicrophone();
    } catch (e) {
      try {
        await client.connect({ conversation: { mode: "persistent" } });
        mute.disabled = false;
        await audio.startMicrophone();
      } catch (retryError) { showError(retryError); mute.textContent = "Unmute"; }
    }
    return;
  }
  supervisor.start();
}

// Pointer parallax: secondary to voice, ignored entirely for reduced motion.
if (!reducedMotion) {
  window.addEventListener("pointermove", (event) => {
    scene?.setPointer(
      (event.clientX / window.innerWidth) * 2 - 1,
      (event.clientY / window.innerHeight) * 2 - 1,
    );
  }, { passive: true });
}

if (reducedMotionQuery) {
  reducedMotionQuery.addEventListener?.("change", (event) => {
    // Respect the preference changing mid-session for future states.
    controller.reducedMotion = Boolean(event.matches);
    if (scene) scene.reducedMotion = Boolean(event.matches);
  });
}

// --- minimal chrome (wordmark toggle) -----------------------------------------
// Clicking the wordmark folds the caption box and the diagnostics panel away
// for an unobstructed view of the entity. Presence, channel state and the
// mute control stay; the preference persists per browser like audio prefs.
const chromeToggle = document.querySelector("#chrome-toggle");
const chromePrefKey = "hermes-live-chrome";
function setChromeMinimal(minimal) {
  document.body.dataset.chrome = minimal ? "minimal" : "full";
  chromeToggle?.setAttribute("aria-pressed", String(minimal));
  try { localStorage.setItem(chromePrefKey, document.body.dataset.chrome); } catch { /* storage may be blocked */ }
}
chromeToggle?.addEventListener("click", () => setChromeMinimal(document.body.dataset.chrome !== "minimal"));
chromeToggle?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    setChromeMinimal(document.body.dataset.chrome !== "minimal");
  }
});
try {
  if (localStorage.getItem(chromePrefKey) === "minimal") setChromeMinimal(true);
} catch { /* storage may be blocked */ }

const logToggle = document.querySelector("#log-toggle");
const logDrawer = document.querySelector("#log-drawer");
function setLogOpen(open) {
  if (open) setTaskOpen(false);
  logDrawer.hidden = !open;
  logToggle.classList.toggle("active", open);
  logToggle.setAttribute("aria-expanded", String(open));
}
logToggle?.addEventListener("click", () => setLogOpen(logDrawer.hidden));
logToggle?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    setLogOpen(logDrawer.hidden);
  }
});

// --- task log drawer ----------------------------------------------------------
// The conversation archive and the task record share the right rail, so only
// one drawer is open at a time and neither toggle ever moves.
const taskToggle = document.querySelector("#task-toggle");
const taskDrawer = document.querySelector("#task-drawer");
const taskListEl = document.querySelector("#task-list");
const taskCount = document.querySelector("#task-count");
const taskEmpty = document.querySelector("#task-empty");
// Retained-output fetches in flight; guards double clicks across re-renders.
const taskOutputPending = new Set();
// Terminal states: the record is final, so narration is worth a model pass.
const TASK_TERMINAL = new Set(["completed", "failed", "cancelled", "unknown"]);
// Markdown narration through the gateway's configured LLM (POST
// /v1/task-narration, cached server-side per task revision). Every path is
// null-safe, so the drawer never depends on it being present.
const taskNarrator = noTaskAi ? null : createTaskNarrator({
  endpoint: `${mountPath}/v1/task-narration`,
  getToken: () => token,
});
// Narration only pays off on terminal records with real content to organize.
function narratableTask(task) {
  return TASK_TERMINAL.has(task.state)
    && Boolean(task.result?.summary || task.result?.output || task.error);
}
const TASK_GLYPHS = {
  accepted: "…",
  queued: "…",
  running: "▸",
  stopping: "○",
  completed: "✓",
  failed: "✕",
  cancelled: "◇",
  unknown: "?",
};
// "stopping" already had its stop requested; offer no second one.
const TASK_STOPPABLE = new Set(["accepted", "queued", "running"]);

function setTaskOpen(open) {
  if (open) setLogOpen(false);
  taskDrawer.hidden = !open;
  taskToggle.classList.toggle("active", open);
  taskToggle.setAttribute("aria-expanded", String(open));
  if (open) renderTaskLog();
}
taskToggle?.addEventListener("click", () => setTaskOpen(taskDrawer.hidden));
taskToggle?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    setTaskOpen(taskDrawer.hidden);
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (logDrawer && !logDrawer.hidden) {
    setLogOpen(false);
    logToggle.focus();
  } else if (taskDrawer && !taskDrawer.hidden) {
    setTaskOpen(false);
    taskToggle.focus();
  }
});

function formatClock(epoch) {
  const date = new Date(epoch);
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
function taskDuration(task) {
  return formatDuration((task.finishedAt ?? Date.now()) - (task.startedAt ?? task.createdAt));
}

function taskMeta(task) {
  const parts = [formatClock(task.createdAt), taskDuration(task)];
  if (task.kind === "follow_up") {
    parts.push(task.parentTaskId ? `follow-up of …${task.parentTaskId.slice(-4)}` : "follow-up");
  }
  return parts.filter(Boolean).join(" · ");
}

function taskActionButton(label, className, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", () => onClick(button));
  return button;
}

function renderTaskEntry(task) {
  const entry = document.createElement("article");
  entry.className = "task-entry";
  entry.dataset.state = task.state;

  const head = document.createElement("div");
  head.className = "task-head";
  const glyph = document.createElement("span");
  glyph.className = "task-glyph";
  glyph.textContent = TASK_GLYPHS[task.state] ?? "·";
  const title = document.createElement("h3");
  title.textContent = task.title || `task …${task.taskId.slice(-4)}`;
  const stateLabel = document.createElement("span");
  stateLabel.className = "task-state";
  stateLabel.textContent = task.state;
  head.append(glyph, title, stateLabel);
  entry.append(head);

  const meta = document.createElement("p");
  meta.className = "task-meta";
  meta.textContent = taskMeta(task);
  entry.append(meta);

  // Latest live progress while the worker is still out there.
  const active = !TASK_TERMINAL.has(task.state);
  if (active && task.progress?.message) {
    const progress = document.createElement("p");
    progress.className = "task-progress";
    progress.textContent = task.progress.message;
    entry.append(progress);
  }

  // Terminal records: prefer the gateway's markdown narration once it exists;
  // the raw fields below are the pre-narration and fallback view.
  const narration = taskNarrator?.cached(task);
  if (narration && narration.markdown) {
    entry.append(renderMarkdown(narration.markdown));
    meta.append(` · restructured by ${narration.model}`);
  } else {
    if (task.error) {
      const error = document.createElement("p");
      error.className = "task-error";
      error.textContent = `${task.error.code}: ${task.error.message}`;
      entry.append(error);
    }
    if (task.result?.summary) {
      const summary = document.createElement("p");
      summary.className = "task-summary";
      summary.textContent = task.result.summary;
      entry.append(summary);
    }
    if (task.result?.output) {
      const output = document.createElement("div");
      output.className = "task-output";
      output.textContent = task.result.output;
      entry.append(output);
    }
    if (taskNarrator && !taskNarrator.disabled && narration === undefined && narratableTask(task)) {
      const pending = document.createElement("p");
      pending.className = "task-md-pending";
      pending.textContent = "restructuring…";
      entry.append(pending);
      // Resolves with the outcome cached (markdown or the brief negative
      // entry) — exactly one repaint, never a loop.
      taskNarrator.narrate(task).then(() => {
        if (taskDrawer && !taskDrawer.hidden) renderTaskLog();
      });
    }
  }

  const actions = document.createElement("div");
  actions.className = "task-actions";
  if (TASK_STOPPABLE.has(task.state)) {
    actions.append(taskActionButton("Stop", "stop", (button) => {
      button.disabled = true;
      // stopTask throws synchronously when the state moved on since render.
      try {
        client.stopTask(task.taskId).catch(showError);
      } catch (error) {
        showError(error);
      }
    }));
  }
  // Snapshots omit retained output; the live completed event and task.get
  // carry it. Offer the fetch only when it is still missing.
  if (!active && task.result?.truncated && !task.result.output && !taskOutputPending.has(task.taskId)) {
    actions.append(taskActionButton("Load output", "", (button) => {
      button.disabled = true;
      taskOutputPending.add(task.taskId);
      try {
        client.getTask(task.taskId)
          .catch(showError)
          .finally(() => taskOutputPending.delete(task.taskId));
      } catch (error) {
        taskOutputPending.delete(task.taskId);
        showError(error);
      }
    }));
  }
  if (actions.children.length) entry.append(actions);
  return entry;
}

function renderTaskLog() {
  if (!taskListEl) return;
  const tasks = client.tasks;
  if (taskCount) taskCount.textContent = String(tasks.length).padStart(2, "0");
  if (taskEmpty) taskEmpty.hidden = tasks.length > 0;
  // Full rebuild on every bounded snapshot tick; keep the reader's scroll.
  const scrollTop = taskListEl.scrollTop;
  taskListEl.textContent = "";
  for (const task of tasks) taskListEl.append(renderTaskEntry(task));
  taskListEl.scrollTop = scrollTop;
}

client.on("tasks.changed", () => {
  if (taskToggle) taskToggle.dataset.running = String(client.activeTasks.length > 0);
  if (taskDrawer && !taskDrawer.hidden) renderTaskLog();
});

window.addEventListener("pagehide", (event) => {
  if (event.persisted) return;
  cancelAnimationFrame(frameHandle);
  scene?.dispose();
  // Silence cues before the audio pipeline tears down: dispose() emits a
  // trailing idle microphone event that must not chirp on the way out.
  sfx.dispose();
  supervisor.stop();
  void audio.dispose();
  void client.disconnect();
}, { once: true });

let frameHandle = requestAnimationFrame(frame);
void boot();
