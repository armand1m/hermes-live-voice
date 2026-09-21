// Developer playground for the synthetic entity's visual state.
//
// This panel pins modes, clamps springs and drives synthetic visemes by hand
// so the renderer can be tuned without an agent, microphone or TTS involved.
// voice.js mounts it only when the page opens with ?dev=1, so production
// never sees the DOM built here. Everything is created through
// document.createElement (no markup strings) and every external call is
// guarded: a missing controller or scene degrades into an inert panel
// instead of an exception.

const clamp = (value, min = 0, max = 1) => value < min ? min : value > max ? max : value;

/** Viseme channels, mirroring VisemeEstimator.names. */
const VISEMES = ["closed", "open", "wide", "round", "narrow", "teeth"];

/**
 * Scripted mouth sequence for the synthetic speech driver: [viseme, ms] key
 * frames that read like a sentence — opening vowels, closing consonants,
 * spreads, rounds and the occasional teeth flash. Durations sum to the
 * 3.5 s loop exactly.
 */
const SYNTH_KEYS = [
  ["open", 180], ["closed", 60], ["wide", 200], ["narrow", 140],
  ["round", 220], ["teeth", 120], ["open", 260], ["closed", 80],
  ["wide", 160], ["round", 200], ["narrow", 120], ["teeth", 140],
  ["open", 300], ["narrow", 160], ["wide", 180], ["closed", 90],
  ["round", 240], ["teeth", 130], ["open", 220], ["narrow", 150],
  ["wide", 90], ["closed", 60],
];
const SYNTH_LOOP_MS = SYNTH_KEYS.reduce((sum, [, ms]) => sum + ms, 0);

/** Debug modes the controller can be pinned to (tool_call maps to "tool"). */
const PINNED_MODES = {
  idle: "idle",
  listening: "listening",
  thinking: "thinking",
  tool_call: "tool",
  speaking: "speaking",
};

/** Springs exposed as sliders, in display order. */
const SPRING_KEYS = [
  "attention", "energy", "confidence", "speechActivity", "thinkingIntensity",
  "uncertainty", "errorIntensity", "listening", "toolActivity",
];

/** Chip labels for the modes row, ending with the escape hatch to real events. */
const MODE_CHIPS = [...Object.keys(PINNED_MODES), "success", "uncertain", "error", "live"];

const now = () => (typeof performance !== "undefined" && performance.now)
  ? performance.now()
  : Date.now();

/**
 * Build the visual state playground.
 *
 * @param {object} options
 *   - controller: AgentStateController instance (optional, guarded)
 *   - scene: VoiceEntityScene instance (optional, guarded)
 *   - onSyntheticVisemes(getWeights | null): installs/removes a synthetic
 *     viseme source; voice.js swaps the audio-driven estimator for it
 *   - getStats(): -> { fps, drawCalls } for the footer readout; without it
 *     fps is smoothed internally from the frame dt
 * @param {boolean} [visible=false] whether the panel starts open
 * @returns {{ frame: (dt: number) => void, dispose: () => void }}
 */
export function createDebugPanel(options = {}, visible = false) {
  const host = typeof document !== "undefined" ? document.body : null;
  if (!host) return { frame() {}, dispose() {} };

  const controller = options.controller || null;
  const scene = options.scene || null;
  const visemeSwap = options.onSyntheticVisemes || options.onSyntheticVisenes || null;
  const onSyntheticVisemes = typeof visemeSwap === "function" ? visemeSwap : null;
  const getStats = typeof options.getStats === "function" ? options.getStats : null;

  const timers = new Set();
  const chips = new Map();
  const sliderRows = new Map();

  // The synthetic viseme state: one shared object mutated in place so the
  // per-frame getter allocates nothing, matching VisemeEstimator.weights.
  const synthWeights = { closed: 1, open: 0, wide: 0, round: 0, narrow: 0, teeth: 0 };

  let synthChip = null;
  let statsEl = null;
  let panelVisible = false;
  let activeChip = null;
  let synthActive = false;
  let synthStart = now();
  let toolTimer = null;
  let recoverTimer = null;
  let fps = 0;
  let valueClock = 0;
  let statsClock = 0;

  /** Element helper — the panel never touches markup strings. */
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  /** Invoke an optional method on an optional target. */
  const call = (target, method, ...args) => {
    if (target && typeof target[method] === "function") target[method](...args);
  };

  /** setTimeout that dispose() can always revoke. */
  const later = (ms, fn) => {
    const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
    timers.add(id);
    return id;
  };

  const cancel = (id) => {
    if (id === null) return;
    clearTimeout(id);
    timers.delete(id);
  };

  const springValue = (key) => {
    const spring = controller && controller.springs ? controller.springs[key] : null;
    return spring ? spring.value : 0;
  };

  // ------------------------------------------------------------------
  // Synthetic visemes
  // ------------------------------------------------------------------

  /**
   * Advance the scripted loop and return the interpolated weights. Poses are
   * one-hot per key frame; consecutive poses blend with cosine easing so the
   * mouth lingers on each shape and moves fastest mid-transition. Two slow
   * amplitude sines keep consecutive loops from looking identical.
   */
  function sampleSynth() {
    const loop = ((now() - synthStart) % SYNTH_LOOP_MS + SYNTH_LOOP_MS) % SYNTH_LOOP_MS;
    let index = 0;
    let cursor = loop;
    while (index < SYNTH_KEYS.length - 1 && cursor >= SYNTH_KEYS[index][1]) {
      cursor -= SYNTH_KEYS[index][1];
      index += 1;
    }
    const [nameA, duration] = SYNTH_KEYS[index];
    const nameB = SYNTH_KEYS[(index + 1) % SYNTH_KEYS.length][0];
    const blend = 0.5 - 0.5 * Math.cos(clamp(cursor / duration) * Math.PI);
    for (const key of VISEMES) synthWeights[key] = 0;
    synthWeights[nameA] += 1 - blend;
    synthWeights[nameB] += blend;
    const t = loop / SYNTH_LOOP_MS;
    const amp = 0.86 + 0.1 * Math.sin(t * Math.PI * 2 * 2.7 + 1.1)
      + 0.04 * Math.sin(t * Math.PI * 2 * 9.3);
    let openSum = 0;
    for (const key of VISEMES) {
      if (key === "closed") continue;
      synthWeights[key] *= amp;
      openSum += synthWeights[key];
    }
    synthWeights.closed = clamp(1 - openSum);
    return synthWeights;
  }

  /** Total mouth opening, reused as the speechActivity override. */
  const synthOpenness = () => clamp(
    synthWeights.open + 0.5 * synthWeights.round + 0.3 * synthWeights.wide,
  );

  function setSynth(active) {
    if (active === synthActive) return;
    synthActive = active;
    if (synthChip) synthChip.classList.toggle("dev-btn-active", active);
    // The driver owns speechActivity while installed; the slider sleeps.
    const speechRow = sliderRows.get("speechActivity");
    if (speechRow) speechRow.input.disabled = active;
    const debug = controller ? controller.debug : null;
    if (active) {
      synthStart = now();
      if (debug) { debug.active = true; delete debug.params.speechActivity; }
      if (onSyntheticVisemes) onSyntheticVisemes(() => sampleSynth());
    } else {
      if (debug) delete debug.params.speechActivity;
      if (onSyntheticVisemes) onSyntheticVisemes(null);
    }
  }

  // ------------------------------------------------------------------
  // Mode chips
  // ------------------------------------------------------------------

  /** Set the primitive trackers so continuous values match the pinned mode. */
  function setTrackers(speaking, thinking, listening) {
    if (!controller) return;
    controller.speakingActive = speaking;
    controller.thinkingActive = thinking;
    controller.listeningActive = listening;
  }

  /** Drop slider positions back onto the live springs (after params clear). */
  function syncSliders() {
    const params = controller && controller.debug ? controller.debug.params : null;
    for (const [key, row] of sliderRows) {
      if (params && params[key] !== undefined) continue;
      row.input.value = String(clamp(springValue(key)));
    }
  }

  function selectChip(name) {
    const wasPinned = activeChip !== null && activeChip !== "live";
    activeChip = name;
    for (const [key, chip] of chips) {
      chip.classList.toggle("dev-btn-active", key === name && name !== "live");
    }
    const debug = controller ? controller.debug : null;
    if (name === "live") {
      if (debug) { debug.active = false; debug.mode = null; debug.params = {}; }
      // Release any trackers the pins held so real events take over cleanly.
      if (wasPinned) setTrackers(false, false, false);
      syncSliders();
      return;
    }
    if (debug) debug.active = true;
    switch (name) {
      case "idle":
        setTrackers(false, false, false);
        break;
      case "listening":
        setTrackers(false, false, true);
        call(controller, "userSpeechStarted");
        break;
      case "thinking":
        setTrackers(false, true, false);
        call(controller, "responseStarted");
        break;
      case "speaking":
        setTrackers(true, false, false);
        call(controller, "ttsStarted");
        break;
      case "tool_call":
        setTrackers(false, false, false);
        call(controller, "toolStarted");
        cancel(toolTimer);
        call(scene, "toolPacketStart", "debug_tool", "demo tool");
        toolTimer = later(2800, () => {
          toolTimer = null;
          call(scene, "toolPacketEnd", "debug_tool", true);
          call(controller, "toolEnded", true);
        });
        break;
      case "success":
        call(controller, "pulseExpression", "satisfied", 3);
        call(scene, "pulse", 1);
        break;
      case "uncertain":
        call(controller, "pulseExpression", "uncertain", 3);
        break;
      case "error":
        call(controller, "error");
        cancel(recoverTimer);
        recoverTimer = later(3000, () => {
          recoverTimer = null;
          call(controller, "recover");
        });
        break;
      default:
        break;
    }
    // The five real pins hold their mode; success/uncertain/error are
    // transient events, so let deriveMode() react to what they fired.
    if (debug) debug.mode = PINNED_MODES[name] || null;
  }

  // ------------------------------------------------------------------
  // DOM construction
  // ------------------------------------------------------------------

  const root = el("div", "dev-panel dev-panel-hidden");

  const modesSection = el("div", "dev-section");
  modesSection.append(el("div", "dev-title", "modes"));
  const modesRow = el("div", "dev-row");
  for (const name of MODE_CHIPS) {
    const chip = el("div", "dev-btn", name);
    chip.addEventListener("click", () => selectChip(name));
    chips.set(name, chip);
    modesRow.append(chip);
  }
  modesSection.append(modesRow);

  const speechSection = el("div", "dev-section");
  speechSection.append(el("div", "dev-title", "speech"));
  const speechRow = el("div", "dev-row");
  synthChip = el("div", "dev-btn", "synth speech");
  synthChip.addEventListener("click", () => setSynth(!synthActive));
  const pulseChip = el("div", "dev-btn", "pulse");
  pulseChip.addEventListener("click", () => call(scene, "pulse", 1));
  speechRow.append(synthChip, pulseChip);
  speechSection.append(speechRow);

  const springsSection = el("div", "dev-section");
  springsSection.append(el("div", "dev-title", "springs"));
  for (const key of SPRING_KEYS) {
    const row = el("div", "dev-slider-row");
    const label = el("div", "dev-slider-label", key);
    const input = document.createElement("input");
    input.type = "range";
    input.min = "0";
    input.max = "1";
    input.step = "0.01";
    input.value = String(clamp(springValue(key)));
    const value = el("div", "dev-value", "0.00");
    const reset = el("div", "dev-reset", "×");
    input.addEventListener("input", () => {
      const debug = controller ? controller.debug : null;
      if (!debug) return;
      // A slider only bites once the debug layer is armed; arm it quietly so
      // the playground works without a warm-up chip click.
      debug.active = true;
      debug.params[key] = Number(input.value);
    });
    reset.addEventListener("click", () => {
      const debug = controller ? controller.debug : null;
      if (debug) delete debug.params[key];
      input.value = String(clamp(springValue(key)));
    });
    row.append(label, input, value, reset);
    sliderRows.set(key, { key, input, value });
    springsSection.append(row);
  }

  statsEl = el("div", "dev-stats", "");
  root.append(modesSection, speechSection, springsSection, statsEl);
  host.append(root);

  // Always-rendered handle: the only entry point when the panel is hidden.
  const handle = el("div", "dev-handle", "◦ dev");
  handle.addEventListener("click", () => setVisible(!panelVisible));
  host.append(handle);

  // ------------------------------------------------------------------
  // Visibility, keyboard, per-frame, teardown
  // ------------------------------------------------------------------

  function setVisible(open) {
    panelVisible = open;
    root.classList.toggle("dev-panel-hidden", !open);
  }

  function onKeyDown(event) {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.code === "Backquote" || event.key === "`") {
      setVisible(!panelVisible);
      return;
    }
    if (event.key === "Escape") setVisible(false);
  }
  window.addEventListener("keydown", onKeyDown);

  function refreshValues() {
    for (const [, row] of sliderRows) {
      row.value.textContent = clamp(springValue(row.key)).toFixed(2);
    }
  }

  function refreshStats() {
    let drawText = "--";
    if (getStats) {
      try {
        const stats = getStats();
        if (stats) {
          if (Number.isFinite(stats.fps)) fps = stats.fps;
          if (Number.isFinite(stats.drawCalls)) drawText = String(Math.round(stats.drawCalls));
        }
      } catch { /* provider stats are best-effort */ }
    }
    const modeText = (controller && controller.mode) || "--";
    const stateText = (controller && controller.canvasState) || "--";
    statsEl.textContent = `fps ${fps ? fps.toFixed(0) : "--"} · draws ${drawText} · mode ${modeText} · state ${stateText}`;
  }

  function frame(dt) {
    const step = Number.isFinite(dt) ? dt : 0;
    if (step > 0) {
      const instant = 1 / step;
      fps = fps ? fps + (instant - fps) * 0.08 : instant;
    }
    if (synthActive && controller && controller.debug) {
      sampleSynth();
      controller.debug.params.speechActivity = synthOpenness();
    }
    valueClock += step;
    if (valueClock >= 1 / 6) { valueClock = 0; refreshValues(); }
    statsClock += step;
    if (statsClock >= 0.25) { statsClock = 0; refreshStats(); }
  }

  function dispose() {
    for (const id of timers) clearTimeout(id);
    timers.clear();
    toolTimer = null;
    recoverTimer = null;
    window.removeEventListener("keydown", onKeyDown);
    if (synthActive && onSyntheticVisemes) onSyntheticVisemes(null);
    if (controller && controller.debug) {
      controller.debug.active = false;
      controller.debug.mode = null;
      controller.debug.params = {};
    }
    root.remove();
    handle.remove();
  }

  if (visible) setVisible(true);
  refreshValues();
  refreshStats();

  return { frame, dispose };
}
