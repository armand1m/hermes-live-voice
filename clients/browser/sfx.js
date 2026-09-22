// Interface sound cues for the voice console — Arwes-style synthesized bleeps.
//
// Every cue is pure Web Audio synthesis (oscillator + gain envelope, optional
// lowpass): no audio assets, no fetches, nothing for the page CSP to allow.
// The palette mirrors the entity's semantic state vocabulary (modes from
// AgentStateController.deriveMode plus the pulsed expressions), so pinning a
// state in the ?dev=1 playground plays its sound. Sounds ride their OWN
// page-lifetime AudioContext, deliberately not HermesLiveAudio's playback
// context: that context is disposed the moment the client closes — exactly
// when the disconnected cue must play — and routing cues through its analyser
// would flap the mouth rig and the output meter. Cues stay under 160 ms and
// at low gain so the microphone's echo cancellation treats them like any
// other speaker output, and every path is guarded so a cue can never break
// the voice page (the e2e contract allows zero page errors, one button, and
// this module adds no DOM at all). Opt out per tab with ?no-sfx=1 / #no-sfx.

// Envelope shape shared by every voice: fast linear attack, exponential decay.
const ATTACK_SEC = 0.008;
const GAIN_FLOOR = 0.0001;
// Keep the oscillator alive briefly past its envelope so the release has
// fully reached zero before the node stops (avoids a click).
const STOP_TAIL_SEC = 0.02;
// Scheduling lead so the first sample is not clipped by the event loop.
const SCHEDULE_LEAD_SEC = 0.005;
// Cues duck under the assistant's voice instead of competing with it.
const SPEAKING_DUCK = 0.5;
export const DEFAULT_MASTER_VOLUME = 0.6;

const voice = (type, fromHz, toHz, offsetSec, durationSec, gain) =>
  ({ type, fromHz, toHz, offsetSec, durationSec, gain });

/**
 * The cue palette, as data. A cue is one or more voices (waveform, frequency
 * ramp, offset, duration, peak gain), an optional biquad filter over the whole
 * sound, and a refractory window that collapses bursts and state flapping
 * (error volleys, speaking-watchdog re-entries) into a single cue.
 */
export const SOUND_SPECS = {
  // --- entity modes ---------------------------------------------------------
  connected:    { refractoryMs: 1000, voices: [voice("triangle", 320, 640, 0, 0.14, 0.22)] },
  disconnected: { refractoryMs: 1000, voices: [voice("triangle", 640, 300, 0, 0.16, 0.20)] },
  error: {
    refractoryMs: 900,
    filter: { type: "lowpass", frequency: 420 },
    voices: [voice("square", 105, 100, 0, 0.16, 0.30), voice("square", 112, 106, 0, 0.16, 0.30)],
  },
  thinking:     { refractoryMs: 3000, voices: [voice("sine", 240, 200, 0, 0.12, 0.12)] },
  tool:         { refractoryMs: 2500, voices: [voice("sine", 180, 180, 0, 0.05, 0.12), voice("sine", 320, 340, 0.06, 0.07, 0.14)] },
  waiting:      { refractoryMs: 4000, voices: [voice("sine", 190, 230, 0, 0.16, 0.14)] },
  speaking:     { refractoryMs: 2500, voices: [voice("sine", 1320, 1320, 0, 0.02, 0.05)] },
  paused:       { refractoryMs: 300, voices: [voice("triangle", 440, 440, 0, 0.08, 0.16), voice("triangle", 550, 550, 0.09, 0.08, 0.16)] },
  idleReturn:   { refractoryMs: 2000, voices: [voice("sine", 392, 392, 0, 0.07, 0.14), voice("sine", 494, 494, 0.08, 0.09, 0.16)] },
  // --- pulsed expressions (dev chips "success" / "uncertain") ----------------
  satisfied:    { refractoryMs: 800, voices: [voice("sine", 660, 660, 0, 0.07, 0.20), voice("sine", 990, 990, 0.075, 0.10, 0.22)] },
  uncertain:    { refractoryMs: 800, voices: [voice("sine", 220, 220, 0, 0.14, 0.20), voice("sine", 262, 262, 0.01, 0.14, 0.16)] },
  // --- interactions and task lifecycle --------------------------------------
  unmute:       { refractoryMs: 150, voices: [voice("sine", 520, 780, 0, 0.09, 0.24)] },
  mute:         { refractoryMs: 150, voices: [voice("sine", 780, 520, 0, 0.09, 0.22)] },
  taskStarted:  { refractoryMs: 300, voices: [voice("sine", 300, 360, 0, 0.06, 0.16)] },
  taskTick:     { refractoryMs: 2000, voices: [voice("sine", 880, 880, 0, 0.025, 0.07)] },
};

const clamp01 = (value) => (value < 0 ? 0 : value > 1 ? 1 : value);

const now = () => (typeof performance !== "undefined" && performance.now
  ? performance.now()
  : Date.now());

/**
 * Map an entity mode transition to a cue name (first match wins).
 *
 * voice.js calls this where it already tracks `body[data-mode]` changes, so
 * dev-pinned modes sound exactly like live ones. `listening` and `dormant`
 * entries are intentionally silent (you caused them; nothing to announce),
 * and a return to idle only speaks when the microphone is live — the turn
 * ended and it is the user's move again.
 *
 * @returns {string|null} cue name to play, or null for silence.
 */
export function resolveModeCue(from, to, { micActive = false, connected = false } = {}) {
  if (!to || from === to) return null;
  if (to === "dormant") return null;
  if (to === "offline") return "disconnected";
  if (from === "dormant" || from === "offline") return "connected";
  if (to === "error") return "error";
  if (to === "thinking") return "thinking";
  if (to === "tool") return "tool";
  if (to === "waiting") return "waiting";
  if (to === "speaking") return "speaking";
  if (to === "paused") return "paused";
  if (to === "idle" && (from === "speaking" || from === "waiting" || from === "tool") && micActive && connected) {
    return "idleReturn";
  }
  return null;
}

const PREFS_KEY = "hermes-live-audio-prefs";

/**
 * Interface-sound preferences, persisted across sessions. A non-secret user
 * preference, so unlike the auth token (which voice.js keeps in
 * sessionStorage) plain localStorage is fine.
 */
export function loadAudioPrefs() {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(PREFS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    const prefs = {};
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.effects === "boolean") prefs.effects = parsed.effects;
      if (typeof parsed.effectsVolume === "number" && Number.isFinite(parsed.effectsVolume)) {
        prefs.effectsVolume = clamp01(parsed.effectsVolume);
      }
    }
    return prefs;
  } catch {
    return {};
  }
}

export function saveAudioPrefs(prefs) {
  try {
    if (typeof localStorage === "undefined" || !prefs || typeof prefs !== "object") return;
    const current = loadAudioPrefs();
    const merged = { ...current };
    if (typeof prefs.effects === "boolean") merged.effects = prefs.effects;
    if (typeof prefs.effectsVolume === "number" && Number.isFinite(prefs.effectsVolume)) {
      merged.effectsVolume = clamp01(prefs.effectsVolume);
    }
    localStorage.setItem(PREFS_KEY, JSON.stringify(merged));
  } catch {
    /* storage may be blocked; preferences simply do not persist */
  }
}

/** Controller cues arrive as "expression:satisfied"; the palette key is bare. */
function normalizeName(name) {
  return String(name).replace(/^expression:/, "");
}

/** Schedule one sound spec onto the graph. Throws are caught by the caller. */
function renderSpec(spec, context, destination, at, scale) {
  let output = destination;
  if (spec.filter) {
    const filter = context.createBiquadFilter();
    filter.type = spec.filter.type;
    filter.frequency.setValueAtTime(spec.filter.frequency, at);
    filter.connect(destination);
    output = filter;
  }
  for (const sound of spec.voices) {
    const start = at + (sound.offsetSec || 0);
    const osc = context.createOscillator();
    osc.type = sound.type;
    osc.frequency.setValueAtTime(sound.fromHz, start);
    if (sound.toHz && sound.toHz !== sound.fromHz) {
      osc.frequency.exponentialRampToValueAtTime(sound.toHz, start + sound.durationSec);
    }
    const gain = context.createGain();
    const peak = Math.max(sound.gain * scale, GAIN_FLOOR);
    gain.gain.setValueAtTime(GAIN_FLOOR, start);
    gain.gain.linearRampToValueAtTime(peak, start + ATTACK_SEC);
    gain.gain.exponentialRampToValueAtTime(GAIN_FLOOR, start + sound.durationSec);
    osc.connect(gain);
    gain.connect(output);
    osc.start(start);
    osc.stop(start + sound.durationSec + STOP_TAIL_SEC);
  }
}

/**
 * Build a cue player. The AudioContext is created lazily on the first real
 * need and lives for the page; `prime()` resumes it and must be called
 * synchronously inside a user gesture (voice.js does so first thing in the
 * mute button handler). `isSpeaking()` ducks cues while the assistant talks.
 *
 * @returns {{ play(name: string): boolean, prime(): void,
 *             setEnabled(enabled: boolean): void, setVolume(v: number): void,
 *             dispose(): void }}
 */
export function createSfx(options = {}) {
  const injectedFactory = typeof options.contextFactory === "function" ? options.contextFactory : null;
  const isSpeaking = typeof options.isSpeaking === "function" ? options.isSpeaking : () => false;
  let enabled = options.enabled !== false;
  let volume = clamp01(typeof options.volume === "number" && Number.isFinite(options.volume)
    ? options.volume
    : DEFAULT_MASTER_VOLUME);
  let context = null;
  let masterGain = null;
  let disposed = false;
  const lastPlayedAt = new Map();
  const unlockListeners = [];

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    // Browsers keep audio contexts suspended until a user gesture; resume
    // opportunistically on the first interaction, like Arwes bleeps do.
    for (const type of ["pointerdown", "keydown"]) {
      const listener = () => prime();
      window.addEventListener(type, listener, { once: true, passive: true });
      unlockListeners.push(() => window.removeEventListener(type, listener));
    }
  }

  function ensureGraph() {
    if (disposed) return false;
    if (context) return true;
    // An injected factory (tests, embedded hosts) replaces the availability
    // check entirely; otherwise require the browser global.
    if (injectedFactory) {
      context = injectedFactory();
    } else if (typeof AudioContext === "function") {
      context = new AudioContext();
    } else if (typeof webkitAudioContext === "function") {
      context = new webkitAudioContext();
    } else {
      return false;
    }
    if (!context || typeof context.createGain !== "function") {
      context = null;
      return false;
    }
    masterGain = context.createGain();
    masterGain.gain.value = volume;
    masterGain.connect(context.destination);
    return true;
  }

  function prime() {
    try {
      if (disposed) return;
      ensureGraph();
      if (context && context.state === "suspended" && typeof context.resume === "function") {
        void context.resume().catch(() => undefined);
      }
    } catch {
      /* audio may be unavailable; cues are optional by design */
    }
  }

  function play(name) {
    try {
      if (disposed || !enabled) return false;
      const key = normalizeName(name);
      const spec = SOUND_SPECS[key];
      if (!spec) return false;
      // The refractory window is consumed even when the cue is then dropped
      // (context suspended): bursts and flapping collapse deterministically.
      const time = now();
      const last = lastPlayedAt.get(key);
      if (last !== undefined && time - last < spec.refractoryMs) return false;
      lastPlayedAt.set(key, time);
      if (!ensureGraph()) return false;
      // Never schedule on a frozen clock — the cues would pile up at
      // currentTime 0 and all fire at once when the context resumes.
      if (context.state !== "running") return false;
      const scale = isSpeaking() ? SPEAKING_DUCK : 1;
      renderSpec(spec, context, masterGain, context.currentTime + SCHEDULE_LEAD_SEC, scale);
      return true;
    } catch {
      return false;
    }
  }

  function setEnabled(next) {
    enabled = Boolean(next);
  }

  function setVolume(next) {
    volume = clamp01(typeof next === "number" && Number.isFinite(next) ? next : volume);
    try {
      if (masterGain) masterGain.gain.value = volume;
    } catch {
      /* graph may be gone; the value is kept for the next one */
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const remove of unlockListeners) {
      try { remove(); } catch { /* window may be gone */ }
    }
    unlockListeners.length = 0;
    try {
      if (context && typeof context.close === "function") void context.close().catch(() => undefined);
    } catch {
      /* closing is best-effort */
    }
    context = null;
    masterGain = null;
  }

  return { play, prime, setEnabled, setVolume, dispose };
}
