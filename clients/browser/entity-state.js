// Continuous visual state for the synthetic entity.
//
// Voice events (WebSocket messages, VAD transitions, audio analysis) are
// translated here into a small set of continuously varying parameters. The
// renderer never sees protocol events — it only reads `controller.visual`
// once per frame. Everything springs toward its target so no transition
// snaps, and every value degrades gracefully when events stop arriving.

const clamp = (value, min = 0, max = 1) => value < min ? min : value > max ? max : value;
const lerp = (a, b, t) => a + (b - a) * t;

/** Critically-damped spring with separate attack/release responsiveness. */
export class Spring {
  constructor(value = 0, { attack = 60, release = 0, damping = 1, min = 0, max = 1 } = {}) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
    this.attack = attack;
    // A release of 0 means "same as attack" — most springs want symmetric
    // behaviour and only a few (energy, audio envelopes) need slow decay.
    this.release = release || attack;
    this.damping = damping;
    this.min = min;
    this.max = max;
  }

  set(target) {
    this.target = clamp(target, this.min, this.max);
  }

  snap(value) {
    this.value = this.target = clamp(value, this.min, this.max);
    this.velocity = 0;
  }

  step(dt) {
    const rising = this.target > this.value;
    const stiffness = rising ? this.attack : this.release;
    // dt arrives clamped by the render loop, so explicit euler steps stay
    // stable even after a tab was backgrounded for seconds.
    const steps = Math.max(1, Math.min(4, Math.ceil(dt / 0.017)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const force = stiffness * (this.target - this.value);
      const cd = 2 * Math.sqrt(stiffness) * this.damping;
      this.velocity += (force - cd * this.velocity) * h;
      this.value += this.velocity * h;
    }
    return this.value;
  }
}

/** Non-repeating organic drift: overlapping incommensurate sines. */
export class Wander {
  constructor(amp = 1, speed = 1, seed = 0) {
    this.amp = amp;
    this.speed = speed;
    this.t = seed * 7.13;
    // Irrational frequency ratios keep the sum from cycling.
    this.waves = [
      { f: 0.31, p: seed * 1.7 + 0.3, a: 0.55 },
      { f: 0.73, p: seed * 3.1 + 1.9, a: 0.28 },
      { f: 1.71, p: seed * 5.9 + 4.2, a: 0.17 },
    ];
  }

  next(dt) {
    this.t += dt * this.speed;
    let sum = 0;
    for (const w of this.waves) sum += w.a * Math.sin(this.t * w.f * Math.PI * 2 + w.p);
    return sum * this.amp;
  }
}

/**
 * Frequency analysis of the outgoing agent audio (TTS).
 *
 * HermesLiveAudio routes every playback buffer through an AnalyserNode
 * (`audio.playbackAnalyser`). The node appears lazily once the first response
 * is scheduled, so the analyser is re-resolved every frame through a getter.
 * Exposes smoothed rms / low / mid / high / transient with fast attack and
 * slower release so the mouth tracks the voice without flutter.
 */
export class SpeechAnalysis {
  constructor(getAnalyser, { bands = [6, 22, 64] } = {}) {
    this.getAnalyser = getAnalyser;
    this.bins = new Uint8Array(128);
    this.bands = bands;
    this.rms = 0;
    this.low = 0;
    this.mid = 0;
    this.high = 0;
    this.transient = 0;
    this.rawRms = 0;
    this.voiced = 0;
  }

  smooth(value, target, attack, release, dt) {
    const k = target > value ? attack : release;
    return value + (target - value) * (1 - Math.exp(-k * dt));
  }

  update(dt, active) {
    const analyser = this.getAnalyser();
    let rms = 0, low = 0, mid = 0, high = 0;
    if (analyser && active) {
      analyser.getByteFrequencyData(this.bins);
      const [lowEnd, midEnd, highEnd] = this.bands;
      let sum = 0, lowSum = 0, midSum = 0, highSum = 0;
      // Byte values are dB-scaled; ^1.6 approximates a linear amplitude read.
      for (let i = 0; i < highEnd; i++) {
        const v = this.bins[i] / 255;
        const a = v ** 1.6;
        sum += a;
        if (i < lowEnd) lowSum += a;
        else if (i < midEnd) midSum += a;
        else highSum += a;
      }
      rms = clamp(sum / highEnd * 2.6);
      low = clamp(lowSum / lowEnd * 3.4);
      mid = clamp(midSum / (midEnd - lowEnd) * 3.2);
      high = clamp(highSum / (highEnd - midEnd) * 3.6);
    }
    this.rawRms = rms;
    const a = 26, r = 7.5;
    this.rms = this.smooth(this.rms, rms, a, r, dt);
    this.low = this.smooth(this.low, low, a, r * 0.8, dt);
    this.mid = this.smooth(this.mid, mid, a, r * 0.8, dt);
    this.high = this.smooth(this.high, high, a * 1.3, r, dt);
    const onset = clamp((rms - this.rms) * 14);
    this.transient = this.smooth(this.transient, onset, 22, 9, dt);
    // "Voiced" separates vowel energy (fundamental + F1) from fricative noise.
    this.voiced = clamp((this.low * 0.8 + this.mid * 0.5) * 1.6 - this.high * 0.35);
    return this;
  }
}

/**
 * Approximate viseme weights from the spectral shape of one analysis frame.
 *
 * No phoneme timing is available from the providers, so visemes are inferred
 * from band energy ratios: dark+loud reads as open vowels, mid-dominant as
 * spread vowels, low-dominant as rounded, bright bursts as fricatives. The
 * estimator is intentionally swappable — feed `weights` from a timed phoneme
 * source instead and everything downstream keeps working.
 */
export class VisemeEstimator {
  constructor() {
    this.names = ["closed", "open", "wide", "round", "narrow", "teeth"];
    this.weights = { closed: 1, open: 0, wide: 0, round: 0, narrow: 0, teeth: 0 };
  }

  update(analysis, dt) {
    const { rms, low, mid, high } = analysis;
    const energy = clamp(rms * 1.15);
    const total = low + mid * 0.9 + high * 0.7 + 1e-4;
    const centroid = (low * 0.22 + mid * 0.48 + high * 0.30) / total;
    const targets = {
      closed: 0, open: 0, wide: 0, round: 0, narrow: 0, teeth: 0,
    };
    if (energy < 0.055) {
      targets.closed = 1;
    } else {
      targets.open = clamp(energy * 1.8 - 0.2) * clamp(1.35 - centroid * 1.9);
      targets.wide = clamp(energy * 1.5) * clamp((mid - low * 0.62 - high * 0.28) * 2.6);
      targets.round = clamp(energy * 1.4) * clamp((low * 1.05 - mid * 0.62 - high * 0.22) * 2.4);
      targets.narrow = clamp((low * 1.5 - mid * 0.85 - high * 0.5) * 1.6) * clamp(1.25 - energy * 1.6);
      targets.teeth = clamp((high * 1.6 - mid * 0.45 - low * 0.55) * 2.2) * clamp(1.35 - energy * 0.9);
    }
    let sum = 0;
    for (const k of this.names) sum += targets[k];
    if (sum < 1e-3) targets.closed = 1;
    else for (const k of this.names) targets[k] /= sum;
    // Fast attack keeps consonant articulation; slower release avoids flicker.
    for (const k of this.names) {
      const t = targets[k];
      const k2 = t > this.weights[k] ? 24 : 10;
      this.weights[k] += (t - this.weights[k]) * (1 - Math.exp(-k2 * dt));
    }
    return this.weights;
  }
}

/**
 * Text-synchronized viseme scheduling for lipsync.
 *
 * The audio-only estimator infers mouth shape from spectral energy, which
 * reads as generic flapping. This scheduler converts the words actually
 * being spoken into a phoneme-like unit queue (grapheme rules, no
 * dictionary): the reveal pacing in voice.js feeds it text at the cadence
 * real speech is playing, and update() plays the queue back with its
 * amplitude gated by the live audio envelope — text provides articulation,
 * audio provides timing and loudness.
 */
const VISEME_NAMES = ["closed", "open", "wide", "round", "narrow", "teeth"];

// Ordered longest-first grapheme rules → [viseme, amount, hold seconds].
const GRAPHEME_RULES = [
  [["oo", "ou", "ow", "oa", "oi", "oy", "au", "aw", "ue", "ui"], "round", 1.0, 0.13],
  [["ee", "ea", "ie", "ay", "ai", "ey"], "wide", 0.95, 0.12],
  [["ch", "sh", "zh", "ck"], "narrow", 0.7, 0.07],
  [["th", "ph"], "teeth", 0.9, 0.07],
  [["qu", "wh"], "round", 0.75, 0.08],
  [["ng"], "narrow", 0.35, 0.07],
  [["gh"], "open", 0.3, 0.06],
  [["a"], "open", 0.9, 0.12],
  [["e"], "wide", 0.7, 0.1],
  [["i", "y"], "wide", 0.6, 0.1],
  [["o"], "round", 0.85, 0.12],
  [["u"], "round", 0.8, 0.11],
  [["m", "b", "p"], "closed", 0.95, 0.06],
  [["f", "v"], "teeth", 0.85, 0.07],
  [["w"], "round", 0.8, 0.07],
  [["r"], "round", 0.45, 0.08],
  [["l"], "open", 0.45, 0.08],
  [["s", "z", "x", "j", "c", "k", "g", "q", "t", "d", "n", "h"], "narrow", 0.45, 0.06],
];
const RULE_LOOKUP = (() => {
  const map = new Map();
  for (const [keys, viseme, amount, hold] of GRAPHEME_RULES) {
    for (const key of keys) map.set(key, [viseme, amount, hold]);
  }
  return map;
})();
const RULE_LENGTHS = [2, 1];

export class TextVisemeScheduler {
  constructor() {
    this.weights = { closed: 1, open: 0, wide: 0, round: 0, narrow: 0, teeth: 0 };
    this.queue = []; // upcoming units: [viseme, amount, hold]
    this.queued = 0; // seconds of articulation waiting
    this.cursor = 0; // seconds elapsed in the head unit
    this.active = 0; // 0..1 — how much the text rig should override audio
    this.silence = 0; // seconds of silent audio while units remain
  }

  /** Queue freshly revealed spoken text (word-sized chunks are ideal). */
  feed(text) {
    const lower = text.toLowerCase();
    let i = 0;
    while (i < lower.length) {
      let matched = false;
      for (const len of RULE_LENGTHS) {
        const key = lower.slice(i, i + len);
        const rule = key.length === len && RULE_LOOKUP.get(key);
        if (rule) {
          this.pushUnit(rule[0], rule[1], rule[2]);
          i += len;
          matched = true;
          break;
        }
      }
      if (!matched) {
        // Spaces and punctuation become brief resting closures.
        if (/\s/.test(lower[i])) this.pushUnit("closed", 0.5, 0.05);
        else if (/[,.!?;:]/.test(lower[i])) this.pushUnit("closed", 0.7, 0.09);
        i += 1;
      }
    }
    this.compress();
  }

  pushUnit(viseme, amount, hold) {
    this.queue.push([viseme, amount, hold]);
    this.queued += hold;
  }

  /** Keep at most ~1.2s of articulation: speed the backlog up, never stall. */
  compress() {
    if (this.queued <= 1.2) return;
    for (let i = Math.floor(this.queue.length / 2); i < this.queue.length; i++) {
      const unit = this.queue[i];
      this.queued -= unit[2] * 0.4;
      unit[2] *= 0.6;
    }
    // Still overloaded (the reveal raced ahead): drop trailing consonants
    // first — vowels carry the recognizable shape — then anything, so
    // playback never lags far behind the voice.
    for (let pass = 0; pass < 2; pass++) {
      for (let i = this.queue.length - 1; i >= 1 && this.queued > 1.2; i--) {
        const unit = this.queue[i];
        const isVowel = unit[0] === "open" || unit[0] === "round" || unit[0] === "wide";
        if (pass === 0 && isVowel) continue;
        this.queued -= unit[2];
        this.queue.splice(i, 1);
      }
    }
  }

  /** Drop everything (speech ended or was interrupted). */
  reset() {
    this.queue.length = 0;
    this.queued = 0;
    this.cursor = 0;
    this.active = 0;
    this.silence = 0;
  }

  /**
   * Advance playback. `activity` is the live output-audio level (0..1): the
   * mouth articulates the queued text but only moves as loud as the voice,
   * and goes fully closed when the voice stops.
   */
  update(dt, activity) {
    const w = this.weights;
    if (this.queue.length === 0) {
      this.silence = 0;
      this.active = Math.max(0, this.active - dt * 2.4);
      for (const name of VISEME_NAMES) {
        if (name !== "closed") w[name] *= Math.exp(-10 * dt);
      }
      w.closed += (1 - w.closed) * (1 - Math.exp(-10 * dt));
      return w;
    }
    if (activity < 0.02) {
      this.silence += dt;
      if (this.silence > 0.6) {
        // Audio ended while text remained (or raced far ahead): abandon it.
        this.reset();
        return w;
      }
    } else {
      this.silence = 0;
    }
    this.active = Math.min(1, this.active + dt * 5);
    // A backlog plays faster so the mouth catches up to the reveal.
    const rate = this.queued > 0.5 ? 1.55 : 1.1;
    this.cursor += dt * rate;
    while (this.queue.length > 0 && this.cursor >= this.queue[0][2]) {
      this.cursor -= this.queue[0][2];
      this.queued -= this.queue[0][2];
      this.queue.shift();
    }
    if (this.queue.length === 0) return w;
    const current = this.queue[0];
    const next = this.queue[1] || null;
    // Smoothstep blend into the next unit over the tail of the current one.
    let nextMix = 0;
    if (next) {
      const phase = clamp((this.cursor / current[2] - 0.55) / 0.45);
      nextMix = phase * phase * (3 - 2 * phase);
    }
    const amp = clamp(activity * 2.4);
    for (const name of VISEME_NAMES) w[name] = 0;
    w[current[0]] += current[1] * (1 - nextMix) * amp;
    if (next) w[next[0]] += next[1] * nextMix * amp;
    w.closed += 1 - amp;
    return w;
  }
}

/**
 * Rig-level expression poses. Values are targets for the face rig; the head
 * component maps them onto weighted vertex regions. Blending happens through
 * the continuous springs in AgentStateController, never by snapping.
 */
export const EXPRESSIONS = {
  neutral:     { browRaise: 0.08, browFurrow: 0,    lidOpen: 0.72, squint: 0.06, smile: 0.04, concern: 0,    tiltZ: 0,     jawRelax: 0.15 },
  attentive:   { browRaise: 0.38, browFurrow: 0.08, lidOpen: 0.96, squint: 0,    smile: 0.06, concern: 0,    tiltZ: 0.02,  jawRelax: 0.1 },
  curious:     { browRaise: 0.62, browFurrow: 0,    lidOpen: 0.9,  squint: 0,    smile: 0.14, concern: 0,    tiltZ: 0.16,  jawRelax: 0.22 },
  processing:  { browRaise: 0.18, browFurrow: 0.5,  lidOpen: 0.55, squint: 0.14, smile: 0,    concern: 0.04, tiltZ: -0.06, jawRelax: 0.1 },
  speaking:    { browRaise: 0.26, browFurrow: 0.06, lidOpen: 0.88, squint: 0.04, smile: 0.18, concern: 0,    tiltZ: 0.03,  jawRelax: 0.55 },
  amused:      { browRaise: 0.46, browFurrow: 0,    lidOpen: 0.78, squint: 0.3,  smile: 0.72, concern: 0,    tiltZ: 0.1,   jawRelax: 0.4 },
  uncertain:   { browRaise: 0.3,  browFurrow: 0.42, lidOpen: 0.6,  squint: 0.1,  smile: 0,    concern: 0.3,  tiltZ: -0.14, jawRelax: 0.2 },
  concerned:   { browRaise: 0.02, browFurrow: 0.5,  lidOpen: 0.62, squint: 0.18, smile: 0,    concern: 0.62, tiltZ: 0.05,  jawRelax: 0.12 },
  satisfied:   { browRaise: 0.34, browFurrow: 0,    lidOpen: 0.7,  squint: 0.22, smile: 0.52, concern: 0,    tiltZ: 0.04,  jawRelax: 0.3 },
  error:       { browRaise: 0.5,  browFurrow: 0.6,  lidOpen: 0.42, squint: 0.2,  smile: 0,    concern: 0.5,  tiltZ: -0.1,  jawRelax: 0.05 },
};

const EXPRESSION_KEYS = Object.keys(EXPRESSIONS.neutral);

function blendExpression(out, base, pulse, amount) {
  for (const key of EXPRESSION_KEYS) {
    out[key] = lerp(base[key], pulse[key], amount);
  }
  return out;
}

/**
 * AgentStateController — the single translation layer between Hermes voice
 * events and the entity's continuous visual state.
 *
 * Discrete `mode` choreographs everything (gaze intention, camera framing,
 * environment behaviour); continuous springs carry the nuance. The mode also
 * derives the legacy canvas data-state contract (idle/listening/thinking/
 * waiting/speaking) kept for assistive technology and e2e expectations.
 */
export class AgentStateController {
  constructor({ reducedMotion = false } = {}) {
    this.reducedMotion = reducedMotion;
    this.mode = "dormant";
    this.connection = "connecting";
    this.microphone = "idle";
    this.time = 0;

    // Primitive pipeline trackers (source of the legacy canvas state).
    this.speakingActive = false;
    this.listeningActive = false;
    this.thinkingActive = false;
    this.taskWaiting = false;
    this.paused = false;

    // Timers guard against events that never arrive.
    this.lastSpeechEnd = -1e9;
    this.lastTtsFrame = -1e9;
    this.lastPlaybackActive = -1e9;
    this.thinkingSince = 0;
    this.errorSince = -1e9;

    // Continuous visual parameters, all 0..1 unless noted.
    this.springs = {
      attention: new Spring(0, { attack: 120, release: 14 }),
      energy: new Spring(0.05, { attack: 110, release: 9 }),
      confidence: new Spring(0.5, { attack: 30, release: 12 }),
      speechActivity: new Spring(0, { attack: 200, release: 60 }),
      thinkingIntensity: new Spring(0, { attack: 26, release: 7 }),
      uncertainty: new Spring(0, { attack: 20, release: 8 }),
      errorIntensity: new Spring(0, { attack: 300, release: 4.5 }),
      listening: new Spring(0, { attack: 170, release: 20 }),
      toolActivity: new Spring(0, { attack: 90, release: 10 }),
      capture: new Spring(0, { attack: 400, release: 26 }),
      dispersal: new Spring(0, { attack: 18, release: 10 }),
      // Gaze intention in head-local space, -1..1.
      gazeX: new Spring(0, { attack: 42, release: 42, min: -1, max: 1 }),
      gazeY: new Spring(0, { attack: 42, release: 42, min: -1, max: 1 }),
    };

    // Expression targets, sprung more softly than signal springs.
    this.expression = {};
    this.expressionSprings = {};
    for (const key of EXPRESSION_KEYS) {
      this.expression[key] = EXPRESSIONS.neutral[key];
      this.expressionSprings[key] = new Spring(this.expression[key], {
        attack: 46,
        release: 30,
        min: key === "tiltZ" ? -1 : 0,
        max: 1,
      });
    }
    this.expressionBase = EXPRESSIONS.neutral;
    this.pulse = null;
    this.pulseAmount = 0;
    this.pulseRemaining = 0;

    // Organic drift generators (idle life, thinking wander).
    this.wander = {
      idleX: new Wander(0.5, 0.4, 1.2),
      idleY: new Wander(0.35, 0.33, 4.7),
      thinkX: new Wander(1.0, 0.8, 9.4),
      thinkY: new Wander(0.7, 0.6, 2.8),
      mic: new Wander(1, 6, 6.1),
    };

    // Mic level envelope with fast attack so "user detected" reads instantly.
    this.micLevel = 0;
    this.micLevelPeak = 0;
    // Raw TTS loudness for the current frame; set by the render bridge from
    // SpeechAnalysis before update() so speech targets track real audio.
    this.speechRaw = 0;

    // Latency observations surfaced in the peripheral interface.
    this.latency = { perceive: null, respond: null };

    // Dev playground overrides (mode pinning + parameter clamps).
    this.debug = { active: false, mode: null, params: {} };
  }

  /** Legacy canvas data-state derivation, matching the previous contract. */
  get canvasState() {
    if (this.speakingActive) return "speaking";
    if (this.listeningActive) return "listening";
    if (this.thinkingActive) return "thinking";
    if (this.taskWaiting) return "waiting";
    return "idle";
  }

  setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
  }

  // ------------------------------------------------------------------
  // Event surface. voice.js bridges HermesLiveClient / HermesLiveAudio
  // events into these semantic calls; nothing else needs to know the wire.
  // ------------------------------------------------------------------

  connectionState(state) {
    this.connection = state;
    if (state === "ready") this.recover();
    if (state === "failed" || state === "closed") {
      this.speakingActive = false;
      this.listeningActive = false;
      this.thinkingActive = false;
    }
  }

  microphoneState(state) {
    this.microphone = state;
    if (state !== "active" && this.listeningActive) {
      this.listeningActive = false;
    }
  }

  pauseRequested() {
    this.paused = true;
    this.listeningActive = false;
  }

  resumeRequested() {
    this.paused = false;
  }

  userSpeechStarted() {
    this.listeningActive = true;
    this.thinkingActive = false;
    this.springs.capture.snap(0);
    this.lastSpeechEnd = this.time;
    if (this.paused) this.paused = false;
  }

  userLevel(level) {
    // 20 Hz envelope from the capture worklet. VAD transitions exclusively
    // own listeningActive; ambient amplitude is only a visual envelope.
    const scaled = clamp(level * 9);
    this.micLevel = scaled;
    this.micLevelPeak = Math.max(this.micLevelPeak * 0.92, scaled);
  }

  userSpeechEnded() {
    this.listeningActive = false;
    this.lastSpeechEnd = this.time;
    // The utterance was captured: a distinct inward "capture" pulse, then
    // cognition begins unless a response is already on its way.
    this.springs.capture.set(1);
    if (!this.speakingActive) {
      this.thinkingActive = true;
      this.thinkingSince = this.time;
    }
  }

  transcribing() {
    // Final/interim user transcript text while not speaking ourselves.
    if (!this.speakingActive) this.thinkingActive = false;
  }

  responseStarted() {
    this.thinkingActive = true;
    this.thinkingSince = this.time;
    this.springs.thinkingIntensity.set(0.85);
    if (this.lastSpeechEnd > 0) {
      this.latency.perceive = Math.round((this.time - this.lastSpeechEnd) * 1000);
    }
  }

  responseActivity() {
    // Any token/progress-ish event: keep computation visibly alive.
    this.thinkingActive = true;
    this.thinkingSince = this.time;
    this.springs.thinkingIntensity.set(Math.max(0.7, this.springs.thinkingIntensity.target));
  }

  responseCompleted() {
    this.thinkingActive = false;
    this.springs.confidence.set(0.86);
  }

  responseCancelled() {
    this.thinkingActive = false;
  }

  ttsStarted() {
    this.speakingActive = true;
    this.thinkingActive = false;
    this.lastTtsFrame = this.time;
    if (this.thinkingSince > 0) {
      this.latency.respond = Math.round((this.time - this.thinkingSince) * 1000);
    }
  }

  ttsFrame() {
    this.lastTtsFrame = this.time;
    if (!this.speakingActive) this.ttsStarted();
  }

  ttsEnded() {
    // Called by the renderer when playback has been silent; the watchdog
    // below owns the actual transition so trailing silence still reads as
    // speech cadence rather than an abrupt stop.
  }

  toolStarted() {
    this.springs.toolActivity.set(1);
    this.thinkingActive = false;
  }

  toolActivity() {
    this.springs.toolActivity.set(1);
  }

  toolEnded(success) {
    this.springs.toolActivity.set(0);
    this.pulseExpression(success === false ? "concerned" : "satisfied", success === false ? 3 : 2.2);
  }

  taskWaitingChanged(active) {
    this.taskWaiting = active;
    // This is the authoritative aggregate task lifecycle signal. In
    // particular, cancelled/stopping tasks do not call toolEnded in voice.js.
    if (!active) this.springs.toolActivity.set(0);
  }

  taskTerminal(kind) {
    if (kind === "completed") this.pulseExpression("satisfied", 2.4);
    else if (kind === "failed" || kind === "unknown") this.pulseExpression("uncertain", 2.6);
  }

  error() {
    this.thinkingActive = false;
    this.speakingActive = false;
    this.errorSince = this.time;
    this.springs.errorIntensity.set(1);
    this.springs.confidence.set(0.2);
  }

  recover() {
    if (this.time - this.errorSince > 1.2) {
      this.springs.errorIntensity.set(0);
      this.springs.confidence.set(0.62);
    }
  }

  pulseExpression(name, duration) {
    const pose = EXPRESSIONS[name];
    if (!pose) return;
    this.pulse = pose;
    this.pulseDuration = duration;
    this.pulseRemaining = duration;
    this.pulseAmount = 0;
  }

  // ------------------------------------------------------------------
  // Per-frame integration.
  // ------------------------------------------------------------------

  update(dt, { speakingNow, micActive }) {
    this.time += dt;
    const t = this.time;
    const s = this.springs;

    // --- watchdogs -------------------------------------------------
    // Playback considered ended after trailing silence.
    if (this.speakingActive && t - Math.max(this.lastTtsFrame, this.lastPlaybackActive) > 0.7) {
      this.speakingActive = false;
      this.springs.confidence.set(0.74);
    }
    if (speakingNow) this.lastPlaybackActive = t;
    // A thinking phase that never produces anything decays into uncertainty,
    // then quietly back to idle.
    if (this.thinkingActive && t - this.thinkingSince > 14) {
      this.springs.uncertainty.set(0.5);
    }
    if (this.thinkingActive && t - this.thinkingSince > 30) {
      this.thinkingActive = false;
      this.springs.uncertainty.set(0.18);
      this.springs.thinkingIntensity.set(0);
    }
    if (this.errorIntensitySettled()) this.springs.errorIntensity.set(0);

    // --- mode selection --------------------------------------------
    const mode = this.debug.active && this.debug.mode ? this.debug.mode : this.deriveMode();
    this.setMode(mode);

    // --- continuous targets ----------------------------------------
    const listening = this.listeningActive && micActive;
    const thinking = this.thinkingActive;
    const speaking = this.speakingActive && speakingNow;
    const tool = s.toolActivity.value > 0.3;

    s.listening.set(listening ? 1 : 0);
    s.energy.set(
      speaking ? 0.62 + 0.3 * this.speechRaw
        : listening ? 0.42 + 0.2 * this.micLevel
        : thinking ? 0.3
        : tool ? 0.34
        : this.connection === "ready" ? 0.14
        : 0.10,
    );
    s.attention.set(
      speaking ? 0.92
        : listening ? 1
        : thinking ? 0.45
        : tool ? 0.62
        : this.connection === "ready" ? 0.3 : 0.12,
    );
    s.speechActivity.set(speaking ? Math.max(0.18, this.speechRaw || 0) : 0);
    s.thinkingIntensity.set(thinking ? (t - this.thinkingSince > 14 ? 0.55 : 1) : 0);
    s.uncertainty.set(thinking && t - this.thinkingSince > 14 ? 0.55 : speaking || listening ? 0.06 : 0.18);
    s.capture.set(listening || speaking || thinking ? 0 : 0);
    s.dispersal.set(thinking ? 1 : tool ? 0.35 : 0);

    // Gaze intention: focused on the user while listening/speaking, wandering
    // while reasoning, glancing toward the peripheral tool node while tools
    // run. The head follows gaze with softer springs — eyes lead the head.
    if (this.reducedMotion) {
      // Keep semantic gaze changes, but remove all oscillator-driven drift.
      s.gazeX.set(tool ? 0.4 : 0);
      s.gazeY.set(thinking ? 0.18 : tool ? 0.06 : listening ? -0.04 : 0);
    } else if (speaking) {
      s.gazeX.set(0);
      s.gazeY.set(0);
    } else if (listening) {
      s.gazeX.set(this.wander.idleX.next(dt) * 0.08);
      s.gazeY.set(-0.05 + this.wander.idleY.next(dt) * 0.05);
    } else if (tool) {
      s.gazeX.set(0.55);
      s.gazeY.set(0.08);
    } else if (thinking) {
      s.gazeX.set(this.wander.thinkX.next(dt) * 0.7);
      s.gazeY.set(0.24 + this.wander.thinkY.next(dt) * 0.3);
    } else {
      s.gazeX.set(this.wander.idleX.next(dt) * 0.35);
      s.gazeY.set(this.wander.idleY.next(dt) * 0.3 - 0.05);
    }

    // --- expression blend ------------------------------------------
    const errorActive = t - this.errorSince <= 1.6 || s.errorIntensity.value > 0.2;
    let base;
    if (errorActive) base = EXPRESSIONS.error;
    else if (speaking) base = EXPRESSIONS.speaking;
    else if (listening) base = EXPRESSIONS.attentive;
    else if (thinking) base = t - this.thinkingSince > 14 ? EXPRESSIONS.uncertain : EXPRESSIONS.processing;
    else if (tool) base = EXPRESSIONS.processing;
    else if (this.connection !== "ready") base = EXPRESSIONS.neutral;
    else if (this.springs.energy.value > 0.24) base = EXPRESSIONS.curious;
    else base = EXPRESSIONS.neutral;
    this.expressionBase = base;

    if (this.pulseRemaining > 0) {
      this.pulseRemaining -= dt;
      // Ease in fast, hold, ease out over the last second.
      const r = this.pulseRemaining;
      const envelope = Math.min(1, (this.pulseDuration - r) * 6) * Math.min(1, r / 1.0);
      this.pulseAmount = clamp(envelope);
      if (this.pulseRemaining <= 0) this.pulse = null;
    } else {
      this.pulseAmount = Math.max(0, this.pulseAmount - dt * 2.2);
    }
    // Errors are safety-significant and temporarily supersede contextual
    // expression pulses; the pulse timer may continue and resume afterward.
    if (this.pulse && !errorActive) blendExpression(this.expression, base, this.pulse, this.pulseAmount);
    else for (const key of EXPRESSION_KEYS) this.expression[key] = base[key];

    // --- integrate springs -----------------------------------------
    const debugParams = this.debug.active ? this.debug.params : null;
    for (const [key, spring] of Object.entries(s)) {
      if (debugParams && debugParams[key] !== undefined) spring.snap(debugParams[key]);
      spring.step(dt);
    }
    for (const key of EXPRESSION_KEYS) {
      const spring = this.expressionSprings[key];
      spring.set(this.expression[key]);
      spring.step(dt);
      this.expression[key] = spring.value;
    }

    // Mic envelope decay when no fresh input.level events arrive.
    if (!listening) this.micLevel *= Math.exp(-3 * dt);
    return this;
  }

  deriveMode() {
    if (this.connection === "failed" || this.connection === "closed") return "offline";
    if (this.connection !== "ready") return "dormant";
    if (this.springs.errorIntensity.value > 0.5) return "error";
    if (this.speakingActive) return "speaking";
    if (this.springs.toolActivity.value > 0.3) return "tool";
    if (this.thinkingActive) return "thinking";
    if (this.listeningActive) return "listening";
    if (this.taskWaiting) return "waiting";
    if (this.paused) return "paused";
    return "idle";
  }

  errorIntensitySettled() {
    return this.time - this.errorSince > 1.6 && this.springs.errorIntensity.value > 0.02;
  }

  /** Flat readout consumed by renderers each frame (no allocation). */
  readout() {
    const s = this.springs;
    const v = this.visual || (this.visual = {});
    v.mode = this.mode;
    v.connection = this.connection;
    v.microphone = this.microphone;
    v.canvasState = this.canvasState;
    v.attention = s.attention.value;
    v.energy = s.energy.value;
    v.confidence = s.confidence.value;
    v.speechActivity = s.speechActivity.value;
    v.thinkingIntensity = s.thinkingIntensity.value;
    v.uncertainty = s.uncertainty.value;
    v.errorIntensity = s.errorIntensity.value;
    v.listening = s.listening.value;
    v.toolActivity = s.toolActivity.value;
    v.capture = s.capture.value;
    v.dispersal = s.dispersal.value;
    v.gazeX = s.gazeX.value;
    v.gazeY = s.gazeY.value;
    v.micLevel = this.micLevel;
    v.expression = this.expression;
    v.latency = this.latency;
    v.reducedMotion = this.reducedMotion;
    return v;
  }
}
