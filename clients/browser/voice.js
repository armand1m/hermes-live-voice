import { HermesLiveClient, HermesLiveAudio } from "./hermes-live-client.js";
import { AgentStateController, SpeechAnalysis, VisemeEstimator } from "./entity-state.js";
import { VoiceEntityScene } from "./entity-scene.js";

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

// The operator can bootstrap a tab with #token=... once. Keep it only in
// sessionStorage so reloads do not require the secret again, while closing
// the tab clears the credential. Never use localStorage or put it in HTML.
const tokenKey = "hermes-live-auth-token";
const conversationKey = "hermes-live-conversation-id";
const hashParams = new URLSearchParams(location.hash.slice(1));
const hashToken = hashParams.get("token")?.trim();
const devMode = hashParams.has("dev") || new URLSearchParams(location.search).get("dev") === "1";
let token;
let rememberedConversation;
try {
  if (hashToken) sessionStorage.setItem(tokenKey, hashToken);
  token = hashToken || sessionStorage.getItem(tokenKey) || undefined;
  const sessionId = sessionStorage.getItem(conversationKey)?.trim();
  if (sessionId) rememberedConversation = { mode: "resume", sessionId };
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
const client = new HermesLiveClient({ url: url.href, token, conversation: rememberedConversation || { mode: "new" } });
const audio = new HermesLiveAudio(client, { workletUrl: `${mountPath}/mic-worklet.js` });

// ---------------------------------------------------------------------------
// Visual state pipeline: voice events → AgentStateController → scene.
// The renderer never touches protocol events; the DOM never touches WebGL.
// ---------------------------------------------------------------------------

const reducedMotionQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)");
const reducedMotion = Boolean(reducedMotionQuery?.matches);
const controller = new AgentStateController({ reducedMotion });
const analysis = new SpeechAnalysis(() => audio.playbackAnalyser);
const visemes = new VisemeEstimator();

// Optional synthetic viseme source installed by the developer playground.
let syntheticVisemes = null;

// Mouth rig targets derived from viseme weights (see entity-head.js).
const mouth = { jaw: 0, wide: 0, round: 0, narrow: 0, press: 0, teeth: 0, energy: 0 };

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

client.on("error", showError);
audio.on("error", showError);
client.on("session.error", showError);
client.on("session.ready", (event) => {
  controller.connectionState("ready");
  const sessionId = event.conversation?.sessionId;
  if (!sessionId) return;
  try { sessionStorage.setItem(conversationKey, sessionId); } catch { /* storage may be blocked */ }
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
  status("offline", "Disconnected");
  detail.textContent = "";
  mute.disabled = true;
});

// --- microphone ------------------------------------------------------------
audio.on("microphone", (event) => {
  controller.microphoneState(event.state);
  mute.textContent = event.active ? "Mute" : "Unmute";
  mute.setAttribute("aria-pressed", String(!event.active));
  if (event.active) {
    controller.resumeRequested();
    status("armed", "Listening");
    detail.textContent = "Talk naturally. I’ll hear when you finish.";
  } else if (event.state === "idle" && controller.paused) {
    status("paused", "Listening paused");
    detail.textContent = "Resume with the microphone control.";
  } else if (event.state === "idle") {
    status("muted", "Microphone muted");
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
client.on("transcript.delta", (event) => {
  if (!current || current.dataset.speaker !== event.speaker || current.dataset.final === "true") {
    current = document.createElement("p");
    current.dataset.speaker = event.speaker;
    transcriptList.append(current);
    while (transcriptList.children.length > 100) transcriptList.firstChild.remove();
    revealIndex = 0;
    revealedText = "";
    agentLine.textContent = "";
  }
  // Final provider transcripts are authoritative, not an additional delta.
  current.textContent = event.final ? event.text : current.textContent + event.text;
  current.dataset.final = String(Boolean(event.final));
  if (event.final && logTranscript) {
    // The full-history drawer keeps finished lines only.
    const logged = current.cloneNode(false);
    logTranscript.append(logged);
    while (logTranscript.children.length > 200) logTranscript.firstChild.remove();
  }
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

client.on("task.updated", ({ task, message }) => {
  const type = message.type;
  if (type === "task.accepted" || type === "task.started") {
    controller.toolStarted();
    scene?.toolPacketStart(task.taskId, toolLabel(task, message));
  } else if (type === "task.progress") {
    controller.toolActivity();
    scene?.pulse(0.3);
    scene?.toolPacketStart(task.taskId, toolLabel(task, message));
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
  }
  renderTaskLine();
});

client.on("tasks.changed", ({ activeTasks }) => {
  controller.taskWaitingChanged(activeTasks.length > 0);
  if (activeTasks.length && !playbackActive && controller.mode !== "listening") {
    status("waiting", "Working in the background");
    detail.textContent = `${activeTasks.length} task${activeTasks.length === 1 ? "" : "s"} still running. You can keep talking.`;
  } else if (!activeTasks.length && state.dataset.state === "waiting") {
    status("armed", "Listening");
    detail.textContent = "";
  }
  renderTaskLine();
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
  taskLine.textContent = `${tasks.length > 1 ? `${tasks.length} · ` : ""}${label}`.slice(0, 64);
}

// --- connection --------------------------------------------------------------
mute.addEventListener("click", async () => {
  mute.disabled = true;
  try {
    if (audio.microphoneActive) await audio.stopMicrophone({ endTurn: true });
    else { await audio.primePlayback(); await audio.startMicrophone(); }
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

function frame(now) {
  requestAnimationFrame(frame);
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

  // Visemes: real outgoing-audio analysis, or the synthetic debug driver.
  const w = syntheticVisemes ? syntheticVisemes() : visemes.update(analysis, dt);
  mouth.jaw = w.open * 0.88 + w.round * 0.4 + w.narrow * 0.12;
  mouth.wide = Math.max(0, w.wide * 0.9 + w.teeth * 0.2 - w.round * 0.3);
  mouth.round = w.round + w.narrow * 0.55;
  mouth.narrow = w.narrow;
  mouth.press = w.teeth * 0.5 + w.closed * 0.35;
  mouth.teeth = w.teeth;
  mouth.energy = analysis.rms;

  // Contract surface for assistive tech and e2e: canvas[data-state].
  if (visual.canvasState !== lastCanvasState) {
    lastCanvasState = visual.canvasState;
    canvas.dataset.state = lastCanvasState;
  }
  if (visual.mode !== lastBodyMode) {
    lastBodyMode = visual.mode;
    document.body.dataset.mode = lastBodyMode;
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
      chip.style.transform = `translate(${Math.round(packet.screen[0])}px, ${Math.round(packet.screen[1])}px)`;
    }
  }

  // Microphone level meter (transform only — no layout).
  meter.style.transform = `scaleX(${Math.min(1, visual.micLevel * (visual.listening > 0.3 ? 1 : 0.25)).toFixed(3)})`;

  // Latency readout while the entity reasons.
  if (visual.mode === "thinking") {
    const { perceive, respond } = visual.latency;
    const parts = [];
    if (perceive !== null) parts.push(`perceive ${perceive}ms`);
    if (respond !== null) parts.push(`respond ${respond}ms`);
    const text = [baseMeta, ...parts].filter(Boolean).join(" · ");
    if (text !== metaLine.textContent) metaLine.textContent = text;
  }

  updateAgentReveal(visual);
  debugFrame?.(dt);
}

// ---------------------------------------------------------------------------
// Developer playground (?dev=1 or #dev) — never present in production.
// ---------------------------------------------------------------------------

if (devMode) {
  // Development introspection handle (never defined in production).
  window.__entity = { controller, scene, audio, client, mouth, analysis };
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
  try {
    await client.connect();
    mute.disabled = false;
    await audio.startMicrophone();
  } catch (e) {
    // A deleted or expired saved chat should not strand the standalone console.
    // Clear only the remembered conversation and start a fresh one once.
    if (rememberedConversation) {
      try { sessionStorage.removeItem(conversationKey); } catch { /* storage may be blocked */ }
      rememberedConversation = undefined;
      try {
        await client.connect({ conversation: { mode: "new" } });
        mute.disabled = false;
        await audio.startMicrophone();
      } catch (retryError) { showError(retryError); mute.textContent = "Unmute"; }
    } else { showError(e); mute.textContent = "Unmute"; }
  }
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

const logToggle = document.querySelector("#log-toggle");
const logDrawer = document.querySelector("#log-drawer");
logToggle?.addEventListener("click", () => {
  logDrawer.hidden = !logDrawer.hidden;
  logToggle.classList.toggle("active", !logDrawer.hidden);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && logDrawer && !logDrawer.hidden) {
    logDrawer.hidden = true;
    logToggle.classList.remove("active");
  }
});

window.addEventListener("pagehide", (event) => {
  if (event.persisted) return;
  cancelAnimationFrame(frameHandle);
  scene?.dispose();
  void audio.dispose();
  void client.disconnect();
}, { once: true });

const frameHandle = requestAnimationFrame(frame);
void boot();
