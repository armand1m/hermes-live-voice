// The entity's environment: camera choreography, orbital particles, inner
// cortex structures, mechanical gimbal rings, computation pulses and tool
// packets. Everything here reads the continuous visual state — nothing knows
// about WebSockets or audio formats.

import { Renderer, mat4, Mesh, PointField } from "./entity-gl.js";
import { Wander } from "./entity-state.js";

const clamp = (v, min = 0, max = 1) => v < min ? min : v > max ? max : v;
const lerp = (a, b, t) => a + (b - a) * t;
const TAU = Math.PI * 2;

// Palette: one dominant accent family (cold mint-teal) and one secondary
// (warm signal amber) that computation pulls toward. Error is a restrained
// coral. States modulate the mix, never swap the palette.
const ACCENTS = {
  primary: [0.12, 0.62, 1.0],
  secondary: [1.0, 0.72, 0.38],
  deep: [0.08, 0.20, 0.29],
  error: [1.0, 0.52, 0.42],
  white: [0.92, 0.98, 1.0],
};

const LINE_SHADER = {
  vert: `
attribute vec3 aPos;
attribute vec4 aColor;
uniform mat4 uVP;
uniform mat4 uModel;
varying vec4 vColor;
void main() {
  gl_Position = uVP * uModel * vec4(aPos, 1.0);
  vColor = aColor;
}`,
  frag: `
precision mediump float;
varying vec4 vColor;
void main() {
  // Ceiling for edge-on ring stacking; premultiplied for screen blending.
  float alpha = min(vColor.a, 0.22);
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(vColor.rgb * alpha, alpha);
}`,
};

const PARTICLE_COUNT = 280;
const PULSE_COUNT = 5;
const PACKET_COUNT = 3;
const CORTEX_RINGS = 2;

/** Damped scalar with velocity, used for camera framing. */
class Damper {
  constructor(value, rate) {
    this.value = value;
    this.target = value;
    this.rate = rate;
  }
  step(dt) {
    const k = 1 - Math.exp(-this.rate * dt);
    this.value += (this.target - this.value) * k;
    return this.value;
  }
}

export class VoiceEntityScene {
  constructor(canvas, { reducedMotion = false } = {}) {
    this.canvas = canvas;
    this.reducedMotion = reducedMotion;
    this.renderer = new Renderer(canvas);
    this.head = null;
    this.disposed = false;
    // Geometry loading must never delay microphone startup or voice events.
    this.ready = import("./entity-facekit.js").then(({ FaceKitHead }) => {
      if (!this.disposed) this.head = new FaceKitHead(this.renderer);
    }).catch((error) => {
      if (this.disposed) return;
      this.loadError = String(error);
      document.body.classList.add("no-webgl");
    });
    this.lineProgram = this.renderer.program(LINE_SHADER.vert, LINE_SHADER.frag);

    // Camera rig.
    this.cam = {
      dist: new Damper(4.4, 2.2),
      az: new Damper(0, 1.6),
      el: new Damper(0.02, 1.8),
      fov: new Damper(0.66, 1.4),
      parallaxX: new Damper(0, 2.6),
      parallaxY: new Damper(0, 2.6),
    };
    this.wanderAz = new Wander(1, 0.13, 3.3);
    this.wanderEl = new Wander(1, 0.09, 8.1);
    this.pointer = { x: 0, y: 0, active: false };

    // Mixed accent (per-frame, shared with the DOM as CSS variables).
    this.accent = {
      primary: [...ACCENTS.primary],
      secondary: [...ACCENTS.secondary],
      deep: [...ACCENTS.deep],
      cssPrimary: "",
    };

    this.time = 0;
    this.buildParticles();
    this.buildCortex();
    this.buildGimbal();
    this.buildPulses();
    this.buildPackets();
  }

  // ------------------------------------------------------------------
  // Construction
  // ------------------------------------------------------------------

  buildParticles() {
    const n = PARTICLE_COUNT;
    this.particleData = {
      baseRadius: new Float32Array(n),
      radius: new Float32Array(n),
      angle: new Float32Array(n),
      speed: new Float32Array(n),
      incl: new Float32Array(n),
      phase: new Float32Array(n),
      yOffset: new Float32Array(n),
      baseSize: new Float32Array(n),
    };
    for (let i = 0; i < n; i++) {
      // Sparser near the head, drifting outward — the entity breathes in an
      // empty chamber, not a dust cloud.
      const t = Math.pow(Math.random(), 1.35);
      this.particleData.baseRadius[i] = lerp(1.9, 3.65, t);
      this.particleData.radius[i] = this.particleData.baseRadius[i];
      this.particleData.angle[i] = Math.random() * TAU;
      this.particleData.speed[i] = (0.05 + Math.random() * 0.16) * (Math.random() < 0.5 ? -1 : 1);
      this.particleData.incl[i] = (Math.random() - 0.5) * 0.9;
      this.particleData.phase[i] = Math.random();
      this.particleData.yOffset[i] = (Math.random() - 0.5) * 0.9;
      this.particleData.baseSize[i] = 0.9 + Math.random() * 1.6;
    }
    this.particleField = new PointField(this.renderer, n);
  }

  buildCortex() {
    // Nested rings inside the skull — the internal machinery that becomes
    // visible while the entity computes.
    const segments = 44;
    const perRing = segments * 2;
    const total = CORTEX_RINGS * perRing;
    this.cortexPos = new Float32Array(total * 3);
    this.cortexColor = new Float32Array(total * 4);
    this.cortexRadii = [0.38, 0.58];
    this.cortexAxes = [
      { x: 0.2, y: 0.0, z: 0.98 },
      { x: 0.9, y: 0.3, z: 0.3 },
      { x: 0.3, y: 0.9, z: 0.2 },
    ];
    this.cortexMesh = new Mesh(this.renderer, [
      { name: "aPos", size: 3, dynamic: true },
      { name: "aColor", size: 4, dynamic: true },
    ]);
    this.cortexMesh.set("aPos", this.cortexPos);
    this.cortexMesh.set("aColor", this.cortexColor);
    this.cortexSegments = segments;
  }

  buildGimbal() {
    // Two broad mechanical rings that frame the entity like an instrument
    // mount. They precess slowly; they never spin.
    const segments = 90;
    const rings = 1;
    this.gimbalPos = new Float32Array(rings * segments * 2 * 3);
    this.gimbalColor = new Float32Array(rings * segments * 2 * 4);
    this.gimbalMesh = new Mesh(this.renderer, [
      { name: "aPos", size: 3, dynamic: true },
      { name: "aColor", size: 4, dynamic: true },
    ]);
    this.gimbalMesh.set("aPos", this.gimbalPos);
    this.gimbalMesh.set("aColor", this.gimbalColor);
    this.gimbalSegments = segments;
    this.gimbalRadii = [1.48];
  }

  buildPulses() {
    // Computation impulses: latitude rings that swell outward from the head.
    const segments = 64;
    this.pulses = [];
    for (let i = 0; i < PULSE_COUNT; i++) {
      const mesh = new Mesh(this.renderer, [
        { name: "aPos", size: 3, dynamic: true },
        { name: "aColor", size: 4, dynamic: true },
      ]);
      const pos = new Float32Array(segments * 2 * 3);
      const color = new Float32Array(segments * 2 * 4);
      mesh.set("aPos", pos);
      mesh.set("aColor", color);
      this.pulses.push({ mesh, pos, color, segments, active: false, t: 0, y: 0, strength: 1 });
    }
    this.pulseSegments = segments;
  }

  buildPackets() {
    // Tool packets: small clusters that leave the head toward an anchor just
    // beside it while Hermes runs a tool, then return with the result. The
    // anchor stays close — the tool activity reads as orbiting the entity,
    // never leaving the stage.
    this.packetField = new PointField(this.renderer, PACKET_COUNT * 28);
    this.packets = [];
    for (let i = 0; i < PACKET_COUNT; i++) {
      this.packets.push({
        id: null, phase: "idle", t: 0, label: "",
        baseAnchor: [1.22, 0.52 + i * 0.34, 0.30],
        anchor: [1.22, 0.52 + i * 0.34, 0.30],
        origin: [0.55, 0.30, 0.62],
        screen: [0, 0, 0],
        success: true,
      });
    }
    // Peripheral anchor nodes: small rotating octahedra.
    this.buildNodes();
  }

  buildNodes() {
    const verts = [];
    // Octahedron edges.
    const base = [
      [0, 1, 0], [1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, 0, -1], [0, -1, 0],
    ];
    const edges = [[0, 1], [0, 2], [0, 3], [0, 4], [5, 1], [5, 2], [5, 3], [5, 4], [1, 2], [2, 3], [3, 4], [4, 1]];
    for (const [a, b] of edges) {
      verts.push(...base[a], ...base[b]);
    }
    this.nodeMesh = new Mesh(this.renderer, [
      { name: "aPos", size: 3, dynamic: true },
      { name: "aColor", size: 4, dynamic: true },
    ]);
    this.nodePos = new Float32Array(verts.length);
    this.nodePos.set(verts);
    this.nodeBase = Float32Array.from(this.nodePos);
    this.nodeColor = new Float32Array((verts.length / 3) * 4);
    this.nodeMesh.set("aPos", this.nodePos);
    this.nodeMesh.set("aColor", this.nodeColor);
    this.nodeCount = verts.length / 3;
  }

  // ------------------------------------------------------------------
  // Public events (from the state bridge)
  // ------------------------------------------------------------------

  /** A computation impulse (response activity, token progress, tool event). */
  pulse(strength = 1) {
    const pulse = this.pulses.find(p => !p.active);
    if (!pulse) return;
    pulse.active = true;
    pulse.t = 0;
    pulse.y = (Math.random() - 0.5) * 0.9;
    pulse.strength = strength;
  }

  toolPacketStart(id, label) {
    let packet = this.packets.find(p => p.id === id);
    if (!packet) packet = this.packets.find(p => p.phase === "idle");
    if (!packet) return;
    packet.id = id;
    packet.label = label || "";
    packet.phase = "out";
    packet.t = 0;
    packet.success = true;
    this.pulse(0.7);
  }

  toolPacketEnd(id, success = true) {
    const packet = this.packets.find(p => p.id === id && p.phase !== "idle");
    if (!packet) return;
    packet.phase = "return";
    packet.t = 0;
    packet.success = success;
    this.pulse(success ? 1 : 0.6);
  }

  setPointer(nx, ny) {
    // Normalized -1..1 from the viewport center.
    this.pointer.x = clamp(nx, -1, 1);
    this.pointer.y = clamp(ny, -1, 1);
    this.pointer.active = true;
  }

  // ------------------------------------------------------------------
  // Per-frame update + render
  // ------------------------------------------------------------------

  render(dt, visual, mouth) {
    const renderer = this.renderer;
    this.time += dt;
    renderer.time = this.time;
    renderer.resize();

    this.updateAccents(visual);
    this.updateCamera(dt, visual, mouth);
    this.head?.update(dt, this.time, visual, mouth, this.accent);
    this.updateParticles(dt, visual);
    this.updateCortex(dt, visual);
    this.updateGimbal(dt, visual);
    this.updatePulses(dt, visual);
    this.updatePackets(dt, visual);

    const aspect = renderer.canvas.clientWidth / Math.max(1, renderer.canvas.clientHeight);
    const eye = renderer.eye;
    renderer.updateCamera(eye, [0, 0.08, 0], this.cam.fov.value, aspect);

    renderer.beginFrame([0, 0, 0, 0]);

    // Inner structures first: they shine through the translucent shell.
    renderer.additive();
    glDisableDepth(this.renderer);
    this.drawCortex(visual);
    glEnableDepth(this.renderer);
    this.head?.draw(renderer, visual, this.accent);
    this.drawGimbal(visual);
    this.drawPulses(visual);
    this.drawPackets(visual);
    this.drawParticles(visual);

    renderer.endFrame();
    return renderer.drawCalls;
  }

  updateAccents(visual) {
    // Computation warms the palette; errors pull it toward coral. The head,
    // rings, packets and the CSS accent all ride this same mix.
    const warm = clamp(visual.thinkingIntensity * 0.7 + visual.toolActivity * 0.3);
    const err = clamp(visual.errorIntensity);
    for (let i = 0; i < 3; i++) {
      let r = lerp(ACCENTS.primary[i], ACCENTS.secondary[i], warm);
      r = lerp(r, ACCENTS.error[i], err * 0.7);
      this.accent.primary[i] = r;
      this.accent.secondary[i] = lerp(ACCENTS.secondary[i], ACCENTS.white[i], 0.12);
      this.accent.deep[i] = ACCENTS.deep[i];
    }
    this.accent.cssPrimary = `${Math.round(this.accent.primary[0] * 255)},${Math.round(this.accent.primary[1] * 255)},${Math.round(this.accent.primary[2] * 255)}`;
  }

  updateCamera(dt, visual) {
    const cam = this.cam;
    const mode = visual.mode;
    // Framing per mode — restrained, purposeful, never orbiting continuously.
    const framing = {
      dormant: { dist: 4.6, az: 0, el: 0.06, fov: 0.70 },
      offline: { dist: 4.6, az: 0, el: 0.10, fov: 0.70 },
      idle: { dist: 3.65, az: 0, el: 0.03, fov: 0.66 },
      listening: { dist: 3.05, az: 0, el: 0.05, fov: 0.62 },
      thinking: { dist: 3.55, az: 0, el: 0.06, fov: 0.67 },
      tool: { dist: 3.5, az: -0.10, el: 0.07, fov: 0.68 },
      speaking: { dist: 3.3, az: 0, el: 0.02, fov: 0.63 },
      error: { dist: 4.1, az: 0.04, el: 0.13, fov: 0.72 },
      paused: { dist: 3.9, az: 0, el: 0.05, fov: 0.68 },
    }[mode] || { dist: 3.65, az: 0, el: 0.03, fov: 0.66 };

    let azDrift = 0, elDrift = 0;
    if (!this.reducedMotion) {
      // Slow, nearly imperceptible drift built from incommensurate sines.
      const stillness = mode === "listening" || mode === "speaking" ? 0.35 : 1;
      azDrift = this.wanderAz.next(dt) * 0.06 * stillness;
      elDrift = this.wanderEl.next(dt) * 0.04 * stillness;
    }
    cam.dist.target = framing.dist;
    cam.az.target = framing.az + azDrift;
    cam.el.target = framing.el + elDrift;
    cam.fov.target = framing.fov;

    // Pointer parallax: subtle, heavily damped, disabled for reduced motion.
    if (this.pointer.active && !this.reducedMotion) {
      cam.parallaxX.target = this.pointer.x * 0.05;
      cam.parallaxY.target = -this.pointer.y * 0.03;
    } else {
      cam.parallaxX.target = 0;
      cam.parallaxY.target = 0;
    }
    for (const d of Object.values(cam)) d.step(dt);

    const az = cam.az.value + cam.parallaxX.value;
    const el = clamp(cam.el.value + cam.parallaxY.value, -0.5, 0.8);
    // Preserve the head silhouette on narrow portrait displays.
    const aspect = this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight);
    const dist = cam.dist.value * Math.max(1, 0.88 / aspect);
    renderer_eye_set(this.renderer, az, el, dist);
  }

  updateParticles(dt, visual) {
    const data = this.particleData;
    const n = PARTICLE_COUNT;
    const accent = this.accent.primary;
    const mode = visual.mode;
    // Environmental response: contract when attending, exhale when speaking,
    // scatter on disruption.
    const contract = mode === "listening" ? 0.76 : mode === "thinking" ? 0.88 : mode === "speaking" ? 1.02 : 1;
    const capture = 1 - visual.capture * 0.12;
    const errorScatter = visual.errorIntensity;
    const brightness = 0.07 + visual.energy * 0.32 + visual.listening * 0.16 + visual.thinkingIntensity * 0.12;
    const speedGain = 1 + visual.energy * 1.4 + visual.thinkingIntensity * 1.1;
    const dpr = this.renderer.dprScale;
    const t = this.time;
    const field = this.particleField;
    field.begin();
    for (let i = 0; i < n; i++) {
      const base = data.baseRadius[i];
      let radius = base * contract * capture;
      if (errorScatter > 0.02) {
        radius += errorScatter * 0.9 * Math.sin(t * 13.0 + data.phase[i] * 40.0);
      }
      // Gentle radial breathing, phase-offset per particle. Contraction never
      // pulls particles onto the face itself — the head stays readable.
      radius *= 1 + (this.reducedMotion ? 0 : 0.05 * Math.sin(t * (0.3 + data.phase[i] * 0.5) + data.phase[i] * TAU));
      radius = Math.max(1.5, radius);
      data.radius[i] = radius;
      data.angle[i] += data.speed[i] * speedGain * dt;

      const a = data.angle[i];
      const r = data.radius[i];
      const incl = data.incl[i];
      const x0 = Math.cos(a) * r;
      const z0 = Math.sin(a) * r;
      // Tilt the orbital plane about the X axis.
      const y = z0 * Math.sin(incl) + data.yOffset[i] * (0.4 + 0.2 * Math.sin(t * 0.2 + data.phase[i] * TAU));
      const z = z0 * Math.cos(incl);

      // Mic energy breathes into the near particles.
      const micBoost = visual.listening * visual.micLevel * (1.6 - Math.min(1, r / 3.2));
      const alpha = Math.min(0.3, brightness * (0.24 + data.phase[i] * 0.42) + micBoost * 0.22) * 0.32;
      const warmMix = clamp(visual.thinkingIntensity * 0.18 * data.phase[i]);
      const pr = lerp(accent[0], ACCENTS.secondary[0], warmMix);
      const pg = lerp(accent[1], ACCENTS.secondary[1], warmMix);
      const pb = lerp(accent[2], ACCENTS.secondary[2], warmMix);
      const size = (data.baseSize[i] * (1 + micBoost * 0.8 + visual.speechActivity * 0.3)) * dpr;
      field.push(x0, y, z, size, pr, pg, pb, alpha, data.phase[i]);
    }
  }

  updateCortex(dt, visual) {
    const visibility = clamp(visual.thinkingIntensity * 0.48 + visual.toolActivity * 0.14);
    this.cortexVisibility = visibility;
    const t = this.time;
    const pos = this.cortexPos;
    const color = this.cortexColor;
    const segments = this.cortexSegments;
    const accent = this.accent.primary;
    let v = 0;
    for (let ring = 0; ring < CORTEX_RINGS; ring++) {
      const radius = this.cortexRadii[ring];
      const axis = this.cortexAxes[ring];
      // Each ring spins slowly on its own axis; speeds rise with thought.
      const spin = t * (0.14 + ring * 0.09) * (1 + visual.thinkingIntensity * 2.4);
      for (let k = 0; k < segments; k++) {
        for (const step of [0, 1]) {
          const a = ((k + step) / segments) * TAU + spin;
          // Ring in its local plane, then rotated toward its axis.
          let x = Math.cos(a) * radius;
          let y = Math.sin(a) * radius * 0.86;
          let z = 0;
          // Rotate: first tilt the ring plane by axis inclination.
          const tilt = axis.y * 0.9;
          const y2 = y * Math.cos(tilt) - z * Math.sin(tilt);
          const z2 = y * Math.sin(tilt) + z * Math.cos(tilt) + axis.z * 0.22;
          const x2 = x * Math.cos(axis.x * 0.4) - z2 * Math.sin(axis.x * 0.4);
          const z3 = x * Math.sin(axis.x * 0.4) + z2 * Math.cos(axis.x * 0.4);
          pos[v * 3] = x2;
          pos[v * 3 + 1] = y2 * 0.92;
          pos[v * 3 + 2] = z3;
          color[v * 4] = accent[0];
          color[v * 4 + 1] = accent[1];
          color[v * 4 + 2] = accent[2];
          color[v * 4 + 3] = (0.04 + visibility * 0.5) * (0.6 + 0.4 * Math.sin(a * 3.0));
          v += 1;
        }
      }
    }
    this.cortexMesh.subupdate("aPos", pos);
    this.cortexMesh.subupdate("aColor", color);
  }

  updateGimbal(dt, visual) {
    const t = this.time;
    const pos = this.gimbalPos;
    const color = this.gimbalColor;
    const segments = this.gimbalSegments;
    const accent = this.accent.primary;
    const alpha = visual.thinkingIntensity * 0.055 + visual.toolActivity * 0.07;
    let v = 0;
    for (let ring = 0; ring < 1; ring++) {
      const radius = this.gimbalRadii[ring];
      // Precession: the ring plane's orientation drifts, never rotates fully.
      const precess = t * (ring === 0 ? 0.031 : -0.023);
      const tilt = 0.16 + ring * 0.1 + Math.sin(t * 0.05 + ring) * 0.05;
      for (let k = 0; k < segments; k++) {
        for (const step of [0, 1]) {
          const a = ((k + step) / segments) * TAU;
          let x = Math.cos(a) * radius;
          let y = Math.sin(a) * radius * Math.cos(tilt);
          let z = Math.sin(a) * radius * Math.sin(tilt);
          // Precess about Y.
          const px = x * Math.cos(precess) - z * Math.sin(precess);
          const pz = x * Math.sin(precess) + z * Math.cos(precess);
          pos[v * 3] = px;
          pos[v * 3 + 1] = y;
          pos[v * 3 + 2] = pz;
          color[v * 4] = accent[0];
          color[v * 4 + 1] = accent[1];
          color[v * 4 + 2] = accent[2];
          color[v * 4 + 3] = alpha * (ring === 0 ? 1 : 0.7);
          v += 1;
        }
      }
    }
    this.gimbalMesh.subupdate("aPos", pos);
    this.gimbalMesh.subupdate("aColor", color);
  }

  updatePulses(dt, visual) {
    for (const pulse of this.pulses) {
      if (!pulse.active) continue;
      pulse.t += dt / 0.9;
      if (pulse.t >= 1) {
        pulse.active = false;
        continue;
      }
      const ease = 1 - (1 - pulse.t) ** 2;
      const radius = lerp(0.7, 1.95, ease);
      const alpha = (1 - pulse.t) * 0.34 * pulse.strength;
      const segments = pulse.segments;
      const accent = this.accent.primary;
      for (let k = 0; k < segments; k++) {
        for (const step of [0, 1]) {
          const a = ((k + step) / segments) * TAU;
          const v = k * 2 + step;
          pulse.pos[v * 3] = Math.cos(a) * radius;
          pulse.pos[v * 3 + 1] = pulse.y + Math.sin(a) * radius * 0.05;
          pulse.pos[v * 3 + 2] = Math.sin(a) * radius;
          pulse.color[v * 4] = accent[0];
          pulse.color[v * 4 + 1] = accent[1];
          pulse.color[v * 4 + 2] = accent[2];
          pulse.color[v * 4 + 3] = alpha;
        }
      }
      pulse.mesh.subupdate("aPos", pulse.pos);
      pulse.mesh.subupdate("aColor", pulse.color);
    }
  }

  updatePackets(dt, visual) {
    const field = this.packetField;
    field.begin();
    const dpr = this.renderer.dprScale;
    // Keep every anchor inside the visible frustum: on narrow/portrait
    // viewports the frustum half-width shrinks, so the anchor rides inward
    // instead of drifting off-canvas. It never collapses onto the face.
    const aspect = this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight);
    const reach = Math.max(0.85,
      Math.tan(this.cam.fov.value / 2) * Math.max(1.5, this.cam.dist.value - 0.3) * aspect - 0.22);
    for (const packet of this.packets) {
      if (packet.phase === "idle") continue;
      packet.anchor[0] = Math.min(packet.baseAnchor[0], reach);
      const speed = packet.phase === "hold" ? 0 : 0.9;
      packet.t += dt * speed;
      const [ox, oy, oz] = packet.origin;
      const [ax, ay, az] = packet.anchor;
      let u;
      if (packet.phase === "out") {
        u = Math.min(1, packet.t);
        if (u >= 1) { packet.phase = "hold"; packet.t = 0; }
      } else if (packet.phase === "return") {
        u = 1 - Math.min(1, packet.t);
        if (packet.t >= 1) { packet.phase = "idle"; packet.id = null; continue; }
      } else {
        u = 1;
      }
      // Bezier with a slight outward bow so the path avoids the face.
      const bow = 0.3;
      const cx = (ox + ax) / 2 + bow, cy = (oy + ay) / 2 + 0.35, cz = (oz + az) / 2;
      const iu = 1 - u;
      const px = iu * iu * ox + 2 * iu * u * cx + u * u * ax;
      const py = iu * iu * oy + 2 * iu * u * cy + u * u * ay;
      const pz = iu * iu * oz + 2 * iu * u * cz + u * u * az;
      const t = this.time;
      const head = 6;
      const trail = 20;
      const accent = this.accent.primary;
      const er = packet.success ? 0 : 0.75;
      for (let i = 0; i < head + trail; i++) {
        let x, y, z, size, alpha;
        if (i < head) {
          // Cluster: tight jittering constellation around the packet center.
          const p = i / head;
          x = px + Math.sin(t * 6.0 + p * TAU) * 0.05;
          y = py + Math.cos(t * 5.0 + p * TAU * 2) * 0.05;
          z = pz + Math.sin(t * 4.0 + p * TAU * 3) * 0.04;
          size = (1.6 + Math.sin(t * 9 + p * TAU) * 0.5) * dpr;
          alpha = 0.7;
        } else {
          // Trail: sample back along the path.
          const s = (i - head) / trail;
          const tu = clamp(u - s * 0.4);
          const tiu = 1 - tu;
          x = tiu * tiu * ox + 2 * tiu * tu * cx + tu * tu * ax;
          y = tiu * tiu * oy + 2 * tiu * tu * cy + tu * tu * ay;
          z = tiu * tiu * oz + 2 * tiu * tu * cz + tu * tu * az;
          size = 1.0 * dpr;
          alpha = 0.3 * (1 - s);
        }
        field.push(x, y, z, size,
          lerp(accent[0], ACCENTS.error[0], er),
          lerp(accent[1], ACCENTS.error[1], er),
          lerp(accent[2], ACCENTS.error[2], er),
          alpha, i / (head + trail));
      }
      // Project the anchor for the DOM label chip.
      const projected = this.renderer.project(packet.screen, ax, ay, az);
      packet.screen[3] = projected[3];
    }
    this.updateNodes(dt, visual);
  }

  updateNodes(dt, visual) {
    const t = this.time;
    const anyActive = this.packets.some(p => p.phase !== "idle");
    this.nodeActivity = anyActive ? Math.min(1, (this.nodeActivity || 0) + dt * 3) : Math.max(0, (this.nodeActivity || 0) - dt * 1.5);
    const activity = this.nodeActivity;
    if (activity <= 0.001) return;
    const base = this.nodeBase;
    const pos = this.nodePos;
    const color = this.nodeColor;
    const spin = t * (0.5 + activity * 1.2);
    const cs = Math.cos(spin), sn = Math.sin(spin);
    const tilt = Math.sin(t * 0.4) * 0.3;
    const ct = Math.cos(tilt), st = Math.sin(tilt);
    for (let i = 0; i < this.nodeCount; i++) {
      const x = base[i * 3] * 0.09, y = base[i * 3 + 1] * 0.09, z = base[i * 3 + 2] * 0.09;
      const rx = x * ct - y * st;
      const ry = x * st + y * ct;
      const px = rx * cs - z * sn;
      const pz = rx * sn + z * cs;
      // Node 0 sits at the first active anchor.
      const anchor = (this.packets.find(p => p.phase !== "idle") || this.packets[0]).anchor;
      pos[i * 3] = anchor[0] + px;
      pos[i * 3 + 1] = anchor[1] + ry;
      pos[i * 3 + 2] = anchor[2] + pz;
      color[i * 4] = this.accent.primary[0];
      color[i * 4 + 1] = this.accent.primary[1];
      color[i * 4 + 2] = this.accent.primary[2];
      color[i * 4 + 3] = 0.25 + activity * 0.5;
    }
    this.nodeMesh.subupdate("aPos", pos);
    this.nodeMesh.subupdate("aColor", color);
  }

  // ------------------------------------------------------------------
  // Draw passes
  // ------------------------------------------------------------------

  drawCortex(visual) {
    if (this.cortexVisibility <= 0.01) return;
    const gl = this.renderer.gl;
    const identity = this.identity ||= mat4.create();
    this.cortexMesh.draw(this.lineProgram, {
      mode: gl.LINES,
      uniforms: { uVP: this.renderer.viewProjection, uModel: identity },
    });
  }

  drawGimbal(visual) {
    const gl = this.renderer.gl;
    const identity = this.identity ||= mat4.create();
    this.gimbalMesh.draw(this.lineProgram, {
      mode: gl.LINES,
      uniforms: { uVP: this.renderer.viewProjection, uModel: identity },
    });
  }

  drawPulses(visual) {
    const gl = this.renderer.gl;
    const identity = this.identity ||= mat4.create();
    for (const pulse of this.pulses) {
      if (!pulse.active) continue;
      pulse.mesh.draw(this.lineProgram, {
        mode: gl.LINES,
        uniforms: { uVP: this.renderer.viewProjection, uModel: identity },
      });
    }
  }

  drawPackets(visual) {
    const gl = this.renderer.gl;
    this.packetField.draw(this.renderer, { flicker: 0.5 });
    if (this.nodeActivity > 0.001) {
      const identity = this.identity ||= mat4.create();
      this.nodeMesh.draw(this.lineProgram, {
        mode: gl.LINES,
        uniforms: { uVP: this.renderer.viewProjection, uModel: identity },
      });
    }
  }

  drawParticles(visual) {
    this.particleField.draw(this.renderer, { flicker: visual.thinkingIntensity * 0.4 });
  }

  dispose() {
    this.disposed = true;
    this.head?.dispose();
    this.particleField.dispose();
    this.packetField.dispose();
    this.cortexMesh.dispose();
    this.gimbalMesh.dispose();
    for (const pulse of this.pulses) pulse.mesh.dispose();
    this.nodeMesh.dispose();
  }
}

function renderer_eye_set(renderer, az, el, dist) {
  const eye = renderer.eye;
  eye[0] = Math.sin(az) * Math.cos(el) * dist;
  eye[1] = Math.sin(el) * dist;
  eye[2] = Math.cos(az) * Math.cos(el) * dist;
}

function glDisableDepth(renderer) {
  renderer.gl.disable(renderer.gl.DEPTH_TEST);
}

function glEnableDepth(renderer) {
  renderer.gl.enable(renderer.gl.DEPTH_TEST);
}
