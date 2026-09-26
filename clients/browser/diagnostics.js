// Always-on voice diagnostics overlay.
//
// A quiet, receding panel in the top-right corner that answers one question
// while the voice console runs: when speech stutters, is that the SERVER
// (gateway / voice-stack CPU), the CLIENT (browser render load, audio queue
// underruns), or the TRANSPORT between them? Client-side metrics are computed
// from the same HermesLiveClient/HermesLiveAudio event stream voice.js
// consumes — nothing here re-derives the wire. Server-side metrics come from
// GET /v1/metrics (same auth, same subpath mount as the page). DOM is built
// through document.createElement (CSP: no inline handlers or styles), the
// panel contains no buttons (the e2e contract allows exactly one), and every
// update path is guarded so diagnostics can never break the voice page.
//
// The panel also carries the active-BRAIN indicator fed by the brain-failover
// controller: GET /brain-status.json (same origin, unauthenticated static
// file the controller rewrites on every state change). It shows which model
// is answering while idle, turns amber on failover, and stamps new transcript
// entries with the brain that produced them. See docs/brain-failover.md.

const CLIENT_REFRESH_MS = 250;
const SERVER_POLL_MS = 1_000;
const SERVER_STALE_MS = 5_000;
const BRAIN_POLL_MS = 5_000;
const BRAIN_STALE_MS = 30_000;
const LATENCY_WINDOW = 30;
const JITTER_WINDOW = 200;
// A frame gap the queued audio cannot absorb becomes an audible stall. Small
// slack so ordinary scheduling jitter (post-decode, microtask ordering) is
// not counted as an underrun.
const UNDERRUN_SLACK_MS = 120;
// Inter-frame gaps above this are pauses between responses, not jitter.
const JITTER_GAP_LIMIT_MS = 4_000;

/** Tunable attribution thresholds, exported for tests. */
export const VERDICT_THRESHOLDS = {
  // A server process eating more than this fraction of all cores (or a host
  // load average above this per core, or a starved gateway event loop) counts
  // as server pressure.
  hostCpuFraction: 0.55,
  loadPerCore: 0.9,
  eventLagMs: 150,
  latencyP95Ms: 2_500,
  jitterP95Ms: 250,
  serverGapP95Ms: 200,
  fps: 45,
  fpsLowDurationMs: 1_500,
  stallMs: 900,
  // A mid-response audio feed that has been silent this long is server-side
  // evidence on its own: the gateway itself stopped emitting, whatever the
  // CPU counters say (another process may be starving the host).
  hardStallMs: 1_500,
  underrunWindowMs: 10_000,
};

const now = () => (typeof performance !== "undefined" && performance.now
  ? performance.now()
  : Date.now());

/** Fixed-size ring of numbers with percentile reads; never allocates per push. */
export class RollingNumbers {
  constructor(capacity) {
    this.samples = new Float64Array(capacity);
    this.capacity = capacity;
    this.length = 0;
    this.next = 0;
    this.sorted = new Float64Array(capacity);
  }

  push(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return;
    this.samples[this.next] = numeric;
    this.next = (this.next + 1) % this.capacity;
    if (this.length < this.capacity) this.length += 1;
  }

  percentile(quantile) {
    if (this.length === 0) return null;
    const view = this.samples.subarray(0, this.length);
    this.sorted.set(view);
    const active = this.sorted.subarray(0, this.length);
    active.sort();
    const index = Math.min(this.length - 1, Math.floor(quantile * (this.length - 1)));
    return active[index];
  }

  worst() {
    if (this.length === 0) return null;
    let worst = this.samples[0];
    for (let i = 1; i < this.length; i++) {
      if (this.samples[i] > worst) worst = this.samples[i];
    }
    return worst;
  }
}

/**
 * Heuristic stutter attribution. Pure so it can be tested without a browser:
 * the caller collects the signals, this decides what they mean. Numbers stay
 * visible in the panel next to the verdict so every call is verifiable.
 *
 * @returns {{ verdict: "server"|"client"|"transport"|"nominal"|"sparse", reason: string }}
 */
/** Past this age the reading no longer describes the user (matches the gateway). */
const MOOD_FRESH_MS = 3 * 60_000;

/**
 * One diagnostics line for LAYA's read of the user's last message:
 * "frustrated · 2.1/3 · 12s". Stale readings are marked; absent ones dash.
 */
export function formatUserMood(mood) {
  if (!mood || typeof mood.mood !== "string" || !Number.isFinite(mood.frustration)) return "—";
  const age = Number.isFinite(mood.ageMs) ? mood.ageMs : 0;
  const ageText = age < 60_000 ? `${Math.round(age / 1_000)}s` : `${Math.round(age / 60_000)}m`;
  const line = `${mood.mood} · ${mood.frustration.toFixed(1)}/3 · ${ageText}`;
  return age > MOOD_FRESH_MS ? `(${line})` : line;
}

export function computeVerdict(input) {
  const t = VERDICT_THRESHOLDS;
  const cores = input.cores && input.cores > 0 ? input.cores : 1;
  const serverCpuPct = Math.max(input.gatewayCpuPct ?? 0, input.voiceStackCpuPct ?? 0);
  const hostFraction = serverCpuPct / (cores * 100);
  const loadFraction = (input.load1 ?? 0) / cores;
  const serverHot = input.serverFresh
    && (hostFraction > t.hostCpuFraction
      || loadFraction > t.loadPerCore
      || (input.eventLagMs ?? 0) > t.eventLagMs);
  const latencyHigh = input.latencyP95Ms !== null && input.latencyP95Ms !== undefined
    && input.latencyP95Ms > t.latencyP95Ms;
  const jitterWide = input.jitterP95Ms !== null && input.jitterP95Ms !== undefined
    && input.jitterP95Ms > t.jitterP95Ms;
  const serverGapGrowing = Boolean(input.expectingSpeech)
    && input.lastAudioOutputMsAgo !== null && input.lastAudioOutputMsAgo !== undefined
    && input.lastAudioOutputMsAgo > t.stallMs;
  const hardServerStall = Boolean(input.expectingSpeech)
    && input.lastAudioOutputMsAgo !== null && input.lastAudioOutputMsAgo !== undefined
    && input.lastAudioOutputMsAgo > t.hardStallMs;
  const serverGapsTight = input.gatewayAudioGapP95Ms !== null && input.gatewayAudioGapP95Ms !== undefined
    && input.gatewayAudioGapP95Ms <= t.serverGapP95Ms;
  const fpsLow = input.fpsLowMs !== null && input.fpsLowMs !== undefined
    && input.fpsLowMs > t.fpsLowDurationMs;
  const underrunsRecent = input.underrunMsAgo !== null && input.underrunMsAgo !== undefined
    && input.underrunMsAgo >= 0 && input.underrunMsAgo < t.underrunWindowMs;

  const voiceSymptoms = latencyHigh || jitterWide || serverGapGrowing;
  const clientSymptoms = jitterWide || fpsLow || underrunsRecent;

  if ((serverHot && voiceSymptoms) || hardServerStall) {
    const parts = [];
    if (input.voiceStackCpuPct !== null && input.voiceStackCpuPct !== undefined && input.voiceStackCpuPct > 0) {
      parts.push(`stack ${Math.round(input.voiceStackCpuPct)}% of ${cores}c`);
    } else if (serverHot) {
      parts.push(`gateway ${Math.round(input.gatewayCpuPct ?? 0)}%`);
    }
    if (loadFraction > t.loadPerCore) parts.push(`load ${input.load1}`);
    if ((input.eventLagMs ?? 0) > t.eventLagMs) parts.push(`loop ${Math.round(input.eventLagMs)}ms`);
    if (hardServerStall) parts.push(`audio feed ${Math.round(input.lastAudioOutputMsAgo)}ms`);
    return { verdict: "server", reason: parts.join(" · ") };
  }
  if (!serverHot && jitterWide && !fpsLow && !underrunsRecent && serverGapsTight) {
    return {
      verdict: "transport",
      reason: `arrivals ${Math.round(input.jitterP95Ms)}ms vs server ${Math.round(input.gatewayAudioGapP95Ms)}ms`,
    };
  }
  if (!serverHot && clientSymptoms) {
    const parts = [];
    if (fpsLow) parts.push(`fps ${Math.round(input.fps ?? 0)}`);
    if (underrunsRecent) parts.push("underruns");
    if (jitterWide) parts.push(`jitter ${Math.round(input.jitterP95Ms)}ms`);
    return { verdict: "client", reason: parts.join(" · ") };
  }
  return { verdict: "nominal", reason: "" };
}

const fmtMs = (value) => (value === null || value === undefined || !Number.isFinite(value)
  ? "—"
  : value >= 10_000
    ? `${Math.round(value / 1_000)}s`
    : `${Math.round(value)}ms`);
const fmtPct = (value) => (value === null || value === undefined || !Number.isFinite(value)
  ? "—"
  : `${Math.round(value)}%`);

/**
 * Active-brain view for the failover indicator. Pure so it can be tested
 * without a browser. `status` is the parsed /brain-status.json (or null when
 * the file is missing/invalid — deploys without the failover controller).
 *
 * @returns {{ kind: "primary"|"failover"|"unknown", label: string, stale: boolean, brain: string }}
 */
export function computeBrainView(status, nowMs = Date.now()) {
  if (!status || typeof status !== "object") {
    return { kind: "unknown", label: "—", stale: true, brain: "" };
  }
  const ts = typeof status.ts === "string" ? Date.parse(status.ts) : Number.NaN;
  const stale = !Number.isFinite(ts) || nowMs - ts > BRAIN_STALE_MS;
  const kind = status.kind === "failover" || status.kind === "primary" ? status.kind : "unknown";
  const brain = typeof status.brain === "string" && status.brain.trim() ? status.brain.trim() : "?";
  const kindLabel = kind === "failover" ? "FAILOVER" : kind === "primary" ? "primary" : "?";
  return {
    kind,
    label: `${brain} · ${kindLabel}${stale ? " · stale" : ""}`,
    stale,
    brain,
  };
}

/**
 * Mount the diagnostics overlay.
 *
 * @param {object} options
 *   - client: HermesLiveClient instance (event stream; required)
 *   - audio: HermesLiveAudio instance (playback queue introspection; optional)
 *   - metricsUrl: gateway /v1/metrics URL, already mount-path aware
 *   - getToken: () => string | undefined bearer token for the metrics poll
 *   - getFps: () => number from the page's RAF loop (reuses voice.js's counter)
 * @returns {{ dispose: () => void }}
 */
export function createDiagnosticsOverlay(options = {}) {
  const host = typeof document !== "undefined" ? document.body : null;
  if (!host || !options.client?.on) return { dispose() {} };

  const client = options.client;
  const audio = options.audio && typeof options.audio.on === "function" ? options.audio : null;
  const metricsUrl = options.metricsUrl;
  // /brain-status.json sits next to /v1/metrics under the same mount path.
  const brainUrl = typeof metricsUrl === "string" && metricsUrl.endsWith("/v1/metrics")
    ? `${metricsUrl.slice(0, -"/v1/metrics".length)}/brain-status.json`
    : null;
  const getToken = typeof options.getToken === "function" ? options.getToken : () => undefined;
  const getFps = typeof options.getFps === "function" ? options.getFps : () => null;

  // --- client-side metric state -------------------------------------------
  const latency = new RollingNumbers(LATENCY_WINDOW);
  const jitter = new RollingNumbers(JITTER_WINDOW);
  const turn = { vadStopAt: null, firstFrameSeen: false };
  let lastFrameAt = null;
  let previousFrameAt = null;
  let responseActive = false;
  let playbackSeenInResponse = false;
  let underruns = 0;
  let lastUnderrunAt = null;
  let lowFpsMs = 0;
  let lastRenderAt = now();
  let server = null;
  let serverAt = 0;
  let serverFailures = 0;
  let polling = false;
  let brainStatus = null;
  let brainAt = 0;
  let brainFailures = 0;
  let pollingBrain = false;

  const offs = [];
  const on = (emitter, type, listener) => {
    const off = emitter.on(type, listener);
    if (typeof off === "function") offs.push(off);
  };

  function speechStarted() {
    turn.vadStopAt = null;
    turn.firstFrameSeen = false;
  }

  function vadStopped() {
    if (turn.vadStopAt === null) turn.vadStopAt = now();
  }

  function queuedPlaybackMs() {
    if (!audio) return 0;
    try {
      const context = audio.playbackContext;
      if (!context || typeof audio.calculateQueuedPlaybackMs !== "function") return 0;
      return audio.calculateQueuedPlaybackMs(context.currentTime) + (audio.pendingPlaybackMs || 0);
    } catch {
      return 0;
    }
  }

  function ttsFrame() {
    const at = now();
    if (turn.vadStopAt !== null && !turn.firstFrameSeen) {
      turn.firstFrameSeen = true;
      latency.push(at - turn.vadStopAt);
    }
    if (previousFrameAt !== null) {
      const gap = at - previousFrameAt;
      if (gap > 0 && gap <= JITTER_GAP_LIMIT_MS) {
        jitter.push(gap);
        // The arrival gap exceeded what the audio queue can absorb: the
        // buffer drains before the next frame lands — an audible stall.
        if (responseActive && playbackSeenInResponse && gap > queuedPlaybackMs() + UNDERRUN_SLACK_MS) {
          underruns += 1;
          lastUnderrunAt = at;
        }
      }
    }
    previousFrameAt = at;
    lastFrameAt = at;
  }

  function responseStarted() {
    responseActive = true;
    playbackSeenInResponse = false;
  }

  function responseEnded() {
    responseActive = false;
  }

  on(client, "input.speech_started", speechStarted);
  on(client, "input.speech_stopped", vadStopped);
  on(client, "audio.output", ttsFrame);
  on(client, "response.started", responseStarted);
  on(client, "response.completed", responseEnded);
  on(client, "response.cancelled", responseEnded);
  on(client, "response.failed", responseEnded);
  if (audio) {
    on(audio, "input.speech_started", speechStarted);
    on(audio, "input.speech_stopped", vadStopped);
    on(audio, "playback", (event) => {
      if (event?.active) playbackSeenInResponse = true;
    });
  }

  // --- server metrics poll -------------------------------------------------
  async function pollServer() {
    if (typeof fetch !== "function" || !metricsUrl || document.hidden || polling) return;
    polling = true;
    try {
      const headers = { accept: "application/json" };
      const token = getToken();
      if (token) headers.authorization = `Bearer ${token}`;
      const response = await fetch(metricsUrl, { headers, cache: "no-store" });
      if (!response.ok) throw new Error(`metrics ${response.status}`);
      server = await response.json();
      serverAt = Date.now();
      serverFailures = 0;
    } catch {
      serverFailures += 1;
      if (serverFailures >= 3) server = null;
    } finally {
      polling = false;
    }
  }

  // --- active-brain poll (failover controller mirror) ----------------------
  async function pollBrain() {
    if (typeof fetch !== "function" || !brainUrl || document.hidden || pollingBrain) return;
    pollingBrain = true;
    try {
      // Static, unauthenticated, same-origin; no token needed.
      const response = await fetch(brainUrl, { headers: { accept: "application/json" }, cache: "no-store" });
      if (!response.ok) throw new Error(`brain-status ${response.status}`);
      brainStatus = await response.json();
      brainAt = Date.now();
      brainFailures = 0;
    } catch {
      brainFailures += 1;
      if (brainFailures >= 3) brainStatus = null;
    } finally {
      pollingBrain = false;
    }
  }

  function brainView() {
    const fresh = brainStatus !== null && Date.now() - brainAt <= BRAIN_STALE_MS;
    return computeBrainView(fresh ? brainStatus : null);
  }

  // --- panel DOM (createElement only; no buttons; CSP-clean) ----------------
  const panel = document.createElement("section");
  panel.className = "diagnostics";
  panel.setAttribute("aria-label", "Voice diagnostics");
  panel.dataset.verdict = "sparse";

  const head = document.createElement("div");
  head.className = "diag-head";
  const title = document.createElement("span");
  title.className = "rail-label";
  title.textContent = "Diagnostics";
  const verdictEl = document.createElement("strong");
  verdictEl.className = "diag-verdict";
  verdictEl.textContent = "warming up";
  head.append(title, verdictEl);

  const grid = document.createElement("div");
  grid.className = "diag-grid";
  const rows = {};
  for (const key of ["brain", "mood", "lat", "eot", "jit", "stall", "fps", "gw", "stack", "load", "ago", "sgap", "tool", "ann"]) {
    const label = document.createElement("span");
    label.className = "diag-k";
    label.textContent = key;
    const value = document.createElement("span");
    value.className = "diag-v";
    value.textContent = "—";
    grid.append(label, value);
    rows[key] = value;
  }
  rows.brain.setAttribute("data-brain-value", "");

  panel.append(head, grid);
  host.append(panel);
  if (host.dataset) host.dataset.diagnostics = "on";

  // Failover emphasis + per-turn transcript tags. Constructed stylesheets are
  // CSSOM (not <style> markup), so the strict CSP allows them; the ::after
  // marker keeps transcript textContent untouched (e2e asserts on it).
  let brainSheet = null;
  try {
    if (typeof CSSStyleSheet === "function" && document.adoptedStyleSheets) {
      brainSheet = new CSSStyleSheet();
      brainSheet.replaceSync([
        '.diagnostics[data-brain="failover"] [data-brain-value] { color: #ffb454; }',
        '.diagnostics[data-brain="failover"] .diag-head .diag-verdict { color: #ffb454; }',
        '#transcript [data-speaker][data-brain="failover"]::after,',
        '#log-transcript [data-speaker][data-brain="failover"]::after {',
        '  content: " ·glm"; opacity: 0.6; font-size: 0.82em; letter-spacing: 0.04em;',
        '}',
      ].join("\n"));
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, brainSheet];
    }
  } catch {
    brainSheet = null;
  }

  // Stamp each new transcript entry with the brain that was active when the
  // turn happened, so the session log shows who answered (voice.js owns the
  // transcript DOM; this only adds a data attribute).
  let transcriptObserver = null;
  try {
    if (typeof MutationObserver === "function" && typeof document.querySelector === "function") {
      const stamp = (nodes) => {
        const kind = brainView().kind;
        if (kind === "unknown") return;
        for (const node of nodes) {
          if (!(node instanceof Element)) continue;
          const targets = node.hasAttribute?.("data-speaker") ? [node] : [...node.querySelectorAll?.("[data-speaker]") ?? []];
          for (const target of targets) target.dataset.brain = kind;
        }
      };
      transcriptObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) stamp(mutation.addedNodes);
      });
      for (const selector of ["#transcript", "#log-transcript"]) {
        const container = document.querySelector(selector);
        if (container) transcriptObserver.observe(container, { childList: true, subtree: true });
      }
    }
  } catch {
    transcriptObserver = null;
  }

  const setText = (element, text) => {
    if (element.textContent !== text) element.textContent = text;
  };

  function render() {
    const at = now();
    const dt = Math.min(1, (at - lastRenderAt) / 1_000);
    lastRenderAt = at;
    const fps = getFps();
    if (fps !== null && Number.isFinite(fps)) {
      lowFpsMs = fps < VERDICT_THRESHOLDS.fps ? lowFpsMs + dt * 1_000 : 0;
    } else {
      lowFpsMs = 0;
    }

    const serverFresh = server !== null && Date.now() - serverAt <= SERVER_STALE_MS;
    const expectingSpeech = responseActive || (audio?.playbackSources?.size ?? 0) > 0;
    const sinceLastFrame = lastFrameAt !== null && expectingSpeech ? at - lastFrameAt : null;
    const latencyP50 = latency.percentile(0.5);
    const latencyP95 = latency.percentile(0.95);
    const jitterP50 = jitter.percentile(0.5);
    const jitterP95 = jitter.percentile(0.95);
    const jitterWorst = jitter.worst();

    const { verdict, reason } = computeVerdict({
      serverFresh,
      cores: serverFresh ? server.cores : undefined,
      load1: serverFresh ? server.loadAvg?.[0] : undefined,
      gatewayCpuPct: serverFresh ? server.gatewayCpuPct : undefined,
      voiceStackCpuPct: serverFresh ? server.voiceStackCpuPct : undefined,
      eventLagMs: serverFresh ? server.eventLagMs : undefined,
      gatewayAudioGapP95Ms: serverFresh ? server.gatewayAudioGapP95Ms : undefined,
      lastAudioOutputMsAgo: serverFresh ? server.lastAudioOutputMsAgo : undefined,
      expectingSpeech,
      latencyP95Ms: latencyP95,
      jitterP95Ms: jitterP95,
      fps,
      fpsLowMs: lowFpsMs,
      underrunMsAgo: lastUnderrunAt !== null ? at - lastUnderrunAt : null,
    });

    const sparse = latency.length === 0 && jitter.length === 0 && !serverFresh;
    if (panel.dataset.verdict !== verdict) panel.dataset.verdict = sparse ? "sparse" : verdict;
    const verdictText = sparse
      ? "warming up"
      : `${verdict}${reason ? ` · ${reason}` : ""}`;
    setText(verdictEl, verdictText);

    const activeBrain = brainView();
    if (panel.dataset.brain !== activeBrain.kind) panel.dataset.brain = activeBrain.kind;
    setText(rows.brain, activeBrain.label);

    setText(rows.lat, `${fmtMs(latencyP50)} / ${fmtMs(latencyP95)} p95`);
    setText(rows.jit, `${fmtMs(jitterP50)} / ${fmtMs(jitterP95)} / ${fmtMs(jitterWorst)}`);
    setText(rows.stall, sinceLastFrame !== null ? `${fmtMs(sinceLastFrame)} · ${underruns} drop` : `idle · ${underruns} drop`);
    setText(rows.fps, fps !== null && Number.isFinite(fps) ? String(Math.round(fps)) : "—");
    setText(rows.gw, `${fmtPct(serverFresh ? server.gatewayCpuPct : null)} · loop ${fmtMs(serverFresh ? server.eventLagMs : null)}`);
    setText(rows.stack, `${fmtPct(serverFresh ? server.voiceStackCpuPct : null)}`);
    setText(rows.load, serverFresh && Array.isArray(server.loadAvg)
      ? `${server.loadAvg[0].toFixed(1)} / ${server.cores}c`
      : "—");
    setText(rows.ago, fmtMs(serverFresh ? server.lastAudioOutputMsAgo : null));
    setText(rows.sgap, fmtMs(serverFresh ? server.gatewayAudioGapP95Ms : null));
    setText(rows.tool, `${fmtMs(serverFresh ? server.toolSpeechP50Ms : null)} / ${fmtMs(serverFresh ? server.toolSpeechP95Ms : null)}`);
    setText(rows.ann, `${fmtMs(serverFresh ? server.announcementDelayP50Ms : null)} / ${fmtMs(serverFresh ? server.announcementDelayP95Ms : null)}`);
    // LAYA's read of the user's last message, and the silence each turn end waited.
    setText(rows.mood, serverFresh ? formatUserMood(server.userMood) : "—");
    setText(rows.eot, serverFresh && server.silenceWait
      ? `${fmtMs(server.silenceWait.p50Ms)} / ${fmtMs(server.silenceWait.p95Ms)}`
      : "—");
  }

  // --- timers, paused while the tab is hidden ------------------------------
  let clientTimer = null;
  let serverTimer = null;
  let brainTimer = null;

  function startTimers() {
    if (clientTimer === null) clientTimer = setInterval(render, CLIENT_REFRESH_MS);
    if (serverTimer === null) serverTimer = setInterval(() => void pollServer(), SERVER_POLL_MS);
    if (brainTimer === null) brainTimer = setInterval(() => void pollBrain(), BRAIN_POLL_MS);
  }

  function stopTimers() {
    if (clientTimer !== null) clearInterval(clientTimer);
    if (serverTimer !== null) clearInterval(serverTimer);
    if (brainTimer !== null) clearInterval(brainTimer);
    clientTimer = null;
    serverTimer = null;
    brainTimer = null;
  }

  function onVisibilityChange() {
    if (document.hidden) {
      stopTimers();
    } else {
      startTimers();
      void pollServer();
      void pollBrain();
      render();
    }
  }
  document.addEventListener("visibilitychange", onVisibilityChange);
  if (!document.hidden) startTimers();

  return {
    dispose() {
      stopTimers();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (transcriptObserver) {
        try {
          transcriptObserver.disconnect();
        } catch {
          // Best-effort teardown.
        }
        transcriptObserver = null;
      }
      if (brainSheet && document.adoptedStyleSheets) {
        try {
          document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== brainSheet);
        } catch {
          // Best-effort teardown.
        }
        brainSheet = null;
      }
      for (const off of offs) {
        try {
          off();
        } catch {
          // Emitter already cleared; teardown stays best-effort.
        }
      }
      offs.length = 0;
      panel.remove();
      if (host.dataset && host.dataset.diagnostics === "on") delete host.dataset.diagnostics;
    },
  };
}
