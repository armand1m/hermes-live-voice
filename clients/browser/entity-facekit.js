// ICT FaceKit geometry rendered as a blue depth scan, carrying the full
// continuous expression rig. Asset provenance and license: FACEKIT-LICENSE.txt;
// regenerate with scripts/build-facekit.mjs.
//
// The rig maps the controller's springs onto the model in three layers:
//   - blendshape morphs (jaw, lips, brows, lids) driven by the expression
//     channels, the viseme mouth pack and the blink scheduler;
//   - real eyeball rotation: the eyeball vertex blocks pivot about their own
//     centers, so the optical iris actually looks where the gaze springs point
//     (micro-saccades included) while the head follows with lag — eyes lead;
//   - shader-level state colour and disruption: the scene's mixed accent
//     (teal → amber while computing, coral on error) tints the rim, scan
//     lines, sweep and iris, and the surface itself shimmers apart while
//     reasoning (dispersal) or hitches in time when disrupted (error).
import { mat4, Mesh, PointField } from "./entity-gl.js";
import { FACEKIT } from "./facekit-data.js";

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const VERT = `
attribute vec3 aPos;
attribute vec3 aNormal;
attribute float aIris;
uniform mat4 uVP;
uniform mat4 uModel;
// mediump must match the fragment shader's declaration or the program
// fails to link on strict drivers (vertex default is highp).
uniform mediump float uTime;
uniform float uDispersal;
uniform float uError;
varying vec3 vNormal;
varying vec3 vWorld;
varying float vIris;
varying vec3 vLocal;
void main() {
  // Surfaces loosen and drift along their normals while the entity computes;
  // disruption adds a high-frequency hitch. Eyeballs stay rigid so the
  // optical iris never smears.
  float ph = fract(sin(dot(aPos.xy, vec2(12.9898, 78.233))) * 43758.5453);
  float wob = sin(uTime * (0.8 + ph * 1.7) + ph * 6.2831) * uDispersal * 0.011;
  float jit = sin(uTime * 43.0 + ph * 40.0) * uError * 0.008;
  vec3 pos = aPos + aNormal * ((wob + jit) * (1.0 - aIris * 0.85));
  vec4 p = uModel * vec4(pos, 1.0);
  vWorld = p.xyz;
  vIris = aIris;
  vLocal = aPos;
  vNormal = normalize((uModel * vec4(aNormal, 0.0)).xyz);
  gl_Position = uVP * p;
}`;
const FRAG = `
precision mediump float;
varying vec3 vNormal;
varying vec3 vWorld;
varying float vIris;
varying vec3 vLocal;
uniform vec3 uEye;
uniform float uTime;
uniform float uEnergy;
uniform float uThought;
uniform float uWire;
uniform vec3 uAccent;
uniform float uTint;
uniform float uPupil;
uniform float uGlow;
void main() {
  vec3 n = normalize(vNormal);
  vec3 view = normalize(uEye - vWorld);
  float facing = max(0.0, dot(n, view));
  float rim = pow(1.0 - abs(dot(n, view)), 2.6);
  float light = max(0.0, dot(n, normalize(vec3(-0.5, 0.65, 1.0))));
  float scan = pow(0.5 + 0.5 * sin(vWorld.y * 110.0), 14.0);
  float sweep = exp(-pow((vWorld.y - (1.2 - mod(uTime * 0.35, 2.4))) * 9.0, 2.0));
  float fade = smoothstep(-1.5, -0.78, vWorld.y);
  // The scan stays blue at rest; the mixed accent (warm while computing,
  // coral while disrupted) takes over the luminous terms by uTint.
  vec3 body = mix(vec3(0.025, 0.32, 0.64), uAccent * 0.85, uTint);
  vec3 blue = mix(vec3(0.008, 0.035, 0.12), body, light);
  blue += mix(vec3(0.02, 0.34, 0.70), uAccent, uTint * 0.85) * rim * (0.55 + uEnergy * 0.35);
  blue += mix(vec3(0.025, 0.24, 0.44), uAccent * 0.8, uTint) * (scan * 0.15 + sweep * uThought * 0.3);
  blue *= 0.8 + uEnergy * 0.35;
  // Render an optical blue iris on the outer eyeball surface. The source's
  // inner iris geometry expects a transparent cornea in a physical material.
  float eyeRadius = length(vec2(abs(vLocal.x) - 0.2804, vLocal.y - 0.0132));
  float iris = (1.0 - smoothstep(0.047, 0.064, eyeRadius)) * vIris * step(-0.02, vLocal.z);
  // Pupil aperture: dilates with interest (user speaking, captured utterance),
  // constricts with focus. Larger k = larger dark center.
  float k = mix(0.8, 1.55, uPupil);
  float pupil = smoothstep(0.012 * k, 0.024 * k, eyeRadius);
  // The iris adopts the live accent almost fully: it is the brightest mark
  // on the scan, so state colour reads instantly in the eyes.
  vec3 irisColor = mix(vec3(0.04, 0.64, 1.0), uAccent, clamp(uTint * 1.25, 0.0, 0.95));
  blue = mix(blue, irisColor * (0.16 + pupil * 0.84) * (0.7 + uGlow * 0.75), iris);
  if (uWire > 0.5) {
    float alpha = (0.06 + facing * 0.11 + sweep * uThought * 0.14) * fade;
    vec3 wire = mix(vec3(0.10, 0.57, 1.0), uAccent, uTint * 0.75);
    gl_FragColor = vec4(wire * alpha, alpha);
  } else {
    gl_FragColor = vec4(blue * fade, fade);
  }
}`;

export class FaceKitHead {
  constructor(renderer) {
    this.renderer = renderer;
    this.rest = new Float32Array(FACEKIT.positions);
    this.pose = new Float32Array(this.rest);
    this.normals = new Float32Array(this.rest.length);
    this.triangles = new Uint16Array(FACEKIT.triangles);
    this.model = mat4.create();
    this.kind = "ict-facekit";
    // Lagged head orientation (eyes lead, head follows).
    this.rotX = 0; this.rotY = 0; this.rotZ = 0;
    // Eye saccade state, independent of the head.
    this.saccadeX = 0; this.saccadeY = 0;
    this.saccadeTargetX = 0; this.saccadeTargetY = 0;
    this.nextSaccade = 0;
    this.rotation = 0;
    this.nextBlink = 2.8;
    this.blinkStart = -10;
    this.blinkDouble = false;
    this.program = renderer.program(VERT, FRAG);
    this.mesh = new Mesh(renderer, [
      { name: "aPos", size: 3, dynamic: true },
      { name: "aNormal", size: 3, dynamic: true },
      { name: "aIris", size: 1 },
    ]);
    this.computeNormals();
    this.mesh.set("aPos", this.pose).set("aNormal", this.normals);
    const iris = new Float32Array(this.rest.length / 3);
    // Both eyeballs receive the optical iris material.
    const eyeStart = FACEKIT.metadata.eyeballStart;
    if (Number.isInteger(eyeStart)) {
      iris.fill(1, eyeStart);
    }
    this.mesh.set("aIris", iris);
    this.mesh.setIndex(this.triangles);
    this.surfaceIndex = this.mesh.index;
    // A sparse subset of actual topology edges preserves facial contours.
    const edges = [];
    for (let i = 0; i < this.triangles.length; i += 12) {
      edges.push(this.triangles[i], this.triangles[i + 1]);
    }
    const gl = renderer.gl;
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(edges), gl.STATIC_DRAW);
    this.wireIndex = { buffer, count: edges.length };
    this.cloud = new PointField(renderer, Math.ceil(this.rest.length / 9));
    this.morphWeights = Object.fromEntries(Object.keys(FACEKIT.morphs).map(k => [k, 0]));
    this.findEyeballs(eyeStart);
  }

  /**
   * Locate the two eyeball vertex blocks (left then right per the data
   * contract) and their pivot centers, so gaze can rotate each eyeball in
   * its socket instead of merely sliding an iris around.
   */
  findEyeballs(eyeStart) {
    this.eyeballs = [];
    if (!Number.isInteger(eyeStart)) return;
    const total = this.rest.length / 3;
    const half = Math.floor((total - eyeStart) / 2);
    for (let side = 0; side < 2; side++) {
      const start = eyeStart + side * half;
      const end = side === 1 ? total : start + half;
      let cx = 0, cy = 0, cz = 0;
      for (let v = start; v < end; v++) {
        cx += this.rest[v * 3]; cy += this.rest[v * 3 + 1]; cz += this.rest[v * 3 + 2];
      }
      const count = Math.max(1, end - start);
      this.eyeballs.push({ start, end, cx: cx / count, cy: cy / count, cz: cz / count });
    }
  }

  computeNormals() {
    const p = this.pose, n = this.normals, t = this.triangles;
    n.fill(0);
    for (let i = 0; i < t.length; i += 3) {
      const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (let j = 0; j < 3; j++) {
        const v = t[i + j] * 3;
        n[v] += nx; n[v + 1] += ny; n[v + 2] += nz;
      }
    }
    for (let i = 0; i < n.length; i += 3) {
      const len = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
      n[i] /= len; n[i + 1] /= len; n[i + 2] /= len;
    }
  }

  update(dt, time, visual, mouth, accents) {
    const e = visual.expression;
    const still = visual.reducedMotion ? 0 : 1;

    // --- blink scheduler: occasional doubles, faster while listening --------
    if (time > this.nextBlink && !visual.reducedMotion) {
      this.blinkStart = time;
      this.blinkDouble = Math.random() < 0.12;
      const quick = visual.listening > 0.5;
      this.nextBlink = time + (this.blinkDouble ? 0.62 : 0)
        + (quick ? 1.4 + Math.random() * 2.2 : 2.6 + Math.random() * 3.4);
    }
    let blink = 0;
    const sinceBlink = time - this.blinkStart;
    const closeDur = 0.09, openDur = 0.14;
    if (sinceBlink >= 0 && sinceBlink < closeDur + openDur) {
      blink = sinceBlink < closeDur
        ? 1 - sinceBlink / closeDur
        : (sinceBlink - closeDur) / openDur;
      blink = Math.sin(blink * Math.PI);
    } else if (this.blinkDouble && sinceBlink >= closeDur + openDur + 0.06
      && sinceBlink < closeDur + openDur + 0.06 + closeDur + openDur) {
      // Second, quicker blink of a double-blink.
      const t2 = sinceBlink - (closeDur + openDur + 0.06);
      blink = Math.sin(clamp(t2 / (closeDur + openDur)) * Math.PI);
    }

    // --- gaze: eyes lead, head follows --------------------------------------
    // Micro-saccades keep the eyes alive between deliberate gaze targets.
    if (still && time > this.nextSaccade) {
      this.nextSaccade = time + 0.35 + Math.random() * 1.6;
      this.saccadeTargetX = (Math.random() - 0.5) * 0.16;
      this.saccadeTargetY = (Math.random() - 0.5) * 0.10;
    }
    const ks = 1 - Math.exp(-16 * dt * (still || 1));
    this.saccadeX += (this.saccadeTargetX - this.saccadeX) * ks;
    this.saccadeY += (this.saccadeTargetY - this.saccadeY) * ks;
    const eyeGazeX = clamp(visual.gazeX + this.saccadeX * still, -1, 1);
    const eyeGazeY = clamp(visual.gazeY + this.saccadeY * still, -1, 1);

    // --- head orientation and presence --------------------------------------
    // Nod cadence rides the actual speech envelope; capture (an utterance
    // just taken in) is a small inhale — lift and swell.
    const nod = Math.sin(time * 2.6 + 1.3) * 0.016 * visual.speechActivity
      + Math.sin(time * 9.1) * 0.004 * visual.speechActivity;
    const targetRX = -eyeGazeY * 0.16 - e.concern * 0.035 + nod;
    const targetRY = eyeGazeX * 0.26 + (still ? Math.sin(time * 0.22) * 0.03 : 0);
    const targetRZ = e.tiltZ * 0.15
      + (visual.errorIntensity > 0.4 ? 0.02 * Math.sin(time * 41.0) * visual.errorIntensity : 0);
    const kh = 1 - Math.exp(-4.5 * dt);
    this.rotX += (targetRX - this.rotX) * kh;
    this.rotY += (targetRY - this.rotY) * kh;
    this.rotZ += (targetRZ - this.rotZ) * kh;

    const breath = still * 0.005 * Math.sin(time * 0.55);
    const inhale = visual.capture * 0.014 + visual.energy * 0.006 * Math.sin(time * 2.3) * still;
    const scale = 0.88 * (1 + breath + inhale);
    mat4.compose(this.model, 0, 0.28 + still * 0.01 * Math.sin(time * 0.5), 0.02 * visual.listening,
      this.rotX, this.rotY, this.rotZ, scale);

    // Disruption hitches the entity's sense of time.
    const errHigh = visual.errorIntensity > 0.45;
    this.drawTime = errHigh ? Math.floor(time * 11) / 11 : time;
    this.dispersal = clamp(visual.dispersal);
    this.errorJit = clamp(visual.errorIntensity);
    this.tintMix = clamp(0.45 + visual.thinkingIntensity * 0.2 + visual.toolActivity * 0.12
      + visual.errorIntensity * 0.4 + visual.capture * 0.2);
    const accent = (accents && accents.primary) || [0.12, 0.62, 1.0];
    this.accentR = accent[0]; this.accentG = accent[1]; this.accentB = accent[2];
    // Pupil aperture: wide with interest (user speaking, capture), tight with
    // focus. Eye glow tracks attention and flashes on capture/error.
    this.pupil = clamp(0.4 + visual.listening * 0.28 + visual.micLevel * 0.14
      + visual.capture * 0.4 - visual.thinkingIntensity * 0.22 - e.squint * 0.18);
    this.glow = clamp(0.25 + visual.attention * 0.55 + visual.capture * 0.5
      + visual.errorIntensity * 0.7);

    // --- blendshape weights --------------------------------------------------
    const w = this.morphWeights;
    w.jawOpen = clamp(mouth.jaw * 0.78 + mouth.energy * 0.06);
    w.mouthFunnel = clamp(mouth.round * 0.42 + mouth.teeth * 0.26);
    w.mouthPucker = clamp(mouth.narrow * 0.38 + mouth.round * 0.42 + mouth.press * 0.16);
    w.mouthSmile_L = w.mouthSmile_R = clamp(e.smile * 0.5 + mouth.wide * 0.14);
    w.mouthFrown_L = w.mouthFrown_R = clamp(e.concern * 0.42);
    w.eyeBlink_L = w.eyeBlink_R = clamp(blink + (1 - e.lidOpen) * 0.5 + e.squint * 0.22);
    w.browInnerUp_L = w.browInnerUp_R = clamp(e.browRaise * 0.8);
    w.browDown_L = w.browDown_R = clamp(e.browFurrow * 0.95);
    this.pose.set(this.rest);
    for (const name in FACEKIT.morphs) {
      const weight = w[name] || 0;
      if (weight < 0.001) continue;
      const { indices, deltas } = FACEKIT.morphs[name];
      for (let i = 0; i < indices.length; i++) {
        const v = indices[i] * 3, d = i * 3;
        this.pose[v] += deltas[d] * weight;
        this.pose[v + 1] += deltas[d + 1] * weight;
        this.pose[v + 2] += deltas[d + 2] * weight;
      }
    }
    // Rotate the eyeballs in their sockets toward the gaze direction. The
    // eyeball radius is ~0.19 world units, so gains near 0.4 rad are needed
    // for the iris to visibly traverse its socket.
    const yaw = eyeGazeX * 0.42, pitch = -eyeGazeY * 0.5;
    if (this.eyeballs.length === 2) {
      const cy = Math.cos(yaw), sy = Math.sin(yaw);
      const cp = Math.cos(pitch), sp = Math.sin(pitch);
      for (const eye of this.eyeballs) {
        for (let v = eye.start; v < eye.end; v++) {
          const i3 = v * 3;
          const x = this.pose[i3] - eye.cx;
          const y = this.pose[i3 + 1] - eye.cy;
          const z = this.pose[i3 + 2] - eye.cz;
          const y1 = y * cp - z * sp;
          const z1 = y * sp + z * cp;
          this.pose[i3] = eye.cx + x * cy + z1 * sy;
          this.pose[i3 + 1] = eye.cy + y1;
          this.pose[i3 + 2] = eye.cz - x * sy + z1 * cy;
        }
      }
    }
    this.computeNormals();
    this.mesh.subupdate("aPos", this.pose).subupdate("aNormal", this.normals);
    this.cloud.begin();
    const attention = visual.attention;
    for (let i = 0; i < this.pose.length; i += 9) {
      const front = Math.max(0, this.normals[i + 2]);
      const fade = clamp((this.pose[i + 1] + 1.5) / 0.7);
      if (front < 0.1 || fade < 0.01) continue;
      this.cloud.push(this.pose[i], this.pose[i + 1], this.pose[i + 2],
        (1.4 + front * 0.7) * this.renderer.dprScale,
        lerp(0.12, this.accentR, 0.4), lerp(0.65, this.accentG, 0.4),
        lerp(1, this.accentB, 0.2), (0.18 + front * (0.35 + attention * 0.14)) * fade, (i % 71) / 71);
    }
  }

  draw(renderer, visual, accents) {
    const gl = renderer.gl;
    const uniforms = {
      uVP: renderer.viewProjection, uModel: this.model, uEye: renderer.eye,
      uTime: visual.reducedMotion ? 0 : this.drawTime,
      uEnergy: visual.energy, uThought: visual.thinkingIntensity, uWire: 0,
      uDispersal: visual.reducedMotion ? 0 : this.dispersal,
      uError: visual.reducedMotion ? 0 : this.errorJit,
      uAccent: [this.accentR, this.accentG, this.accentB],
      uTint: this.tintMix, uPupil: this.pupil, uGlow: this.glow,
    };
    renderer.normalBlend();
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1, 1);
    this.mesh.index = this.surfaceIndex;
    this.mesh.draw(this.program, { uniforms });
    gl.disable(gl.POLYGON_OFFSET_FILL);
    renderer.additive();
    this.mesh.index = this.wireIndex;
    uniforms.uWire = 1;
    this.mesh.draw(this.program, { mode: gl.LINES, uniforms });
    this.cloud.draw(renderer, { model: this.model });
  }

  dispose() {
    this.mesh.index = this.surfaceIndex;
    this.mesh.dispose();
    this.renderer.gl.deleteBuffer(this.wireIndex.buffer);
    this.cloud.dispose();
  }
}
