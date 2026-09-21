// The synthetic head.
//
// Geometry is grown procedurally from a sphere: anatomical influence fields
// (brow ridge, eye sockets, nose, cheekbones, jaw, chin) displace a latitude/
// longitude grid, and the same fields produce per-vertex rig weights. The
// identical vertex pool is rendered as four representations — a fresnel glass
// shell, decimated topology wire, travelling latitude contours and a surface
// point cloud — so the entity reads as one object seen through four lenses.
//
// Facial features are apertures rather than realistic parts: eyes are lens
// rings with luminous irises and folding lids, the mouth is an articulating
// segmented line. All expression motion is continuous; nothing snaps.

import { mat4, Mesh, PointField } from "./entity-gl.js";

const clamp = (v, min = 0, max = 1) => v < min ? min : v > max ? max : v;
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;

// Head proportions (local space, head roughly spans y ∈ [-1.15, 1.15]).
const AXES = { x: 0.76, y: 1.08, z: 0.88 };

/** Angular gaussian: chord-distance falloff from a canonical direction. */
function field(dirX, dirY, dirZ, sigma) {
  const len = Math.hypot(dirX, dirY, dirZ) || 1;
  const cx = dirX / len, cy = dirY / len, cz = dirZ / len;
  const k = 1 / (2 * sigma * sigma);
  return (x, y, z) => {
    const chordSq = 2 * (1 - (x * cx + y * cy + z * cz));
    return Math.exp(-Math.max(0, chordSq) * k);
  };
}

// Static anatomical fields (unit direction space, +Z is the face).
const FIELDS = {
  socketL: field(-0.36, 0.15, 0.80, 0.155),
  socketR: field(0.36, 0.15, 0.80, 0.155),
  noseTip: field(0, -0.2, 0.94, 0.09),
  noseWingL: field(-0.11, -0.24, 0.86, 0.06),
  noseWingR: field(0.11, -0.24, 0.86, 0.06),
  cheekL: field(-0.55, -0.05, 0.55, 0.20),
  cheekR: field(0.55, -0.05, 0.55, 0.20),
  hollowL: field(-0.44, -0.31, 0.52, 0.16),
  hollowR: field(0.44, -0.31, 0.52, 0.16),
  chin: field(0, -0.73, 0.62, 0.15),
  jawCornerL: field(-0.46, -0.44, 0.26, 0.17),
  jawCornerR: field(0.46, -0.44, 0.26, 0.17),
  templeL: field(-0.62, 0.32, 0.28, 0.2),
  templeR: field(0.62, 0.32, 0.28, 0.2),
  occiput: field(0, 0.05, -0.95, 0.42),
  mouthPlate: field(0, -0.47, 0.80, 0.17),
  glabella: field(0, 0.17, 0.92, 0.07),
};

/** Sculpt displacement along the radial direction for a unit direction. */
function sculpt(x, y, z) {
  let d = 0;
  // Humanise the seed ellipsoid before adding features: a full cranium,
  // tapered lower face and flatter side planes give the scan a recognisable
  // facial silhouette even when only a few points survive the depth cue.
  d += smoothstep(0.22, 0.82, y) * 0.035;
  d -= smoothstep(-0.18, -0.72, y) * smoothstep(0.18, 0.72, Math.abs(x)) * 0.075;
  d -= smoothstep(0.54, 0.92, Math.abs(x)) * smoothstep(-0.2, 0.55, z) * 0.028;
  // Skull base shape: slightly fuller occiput, flatter crown front.
  d += FIELDS.occiput(x, y, z) * 0.03;
  // Brow ridge: a horizontal band above the sockets, strongest frontally.
  const front = smoothstep(0.05, 0.45, z);
  const band = Math.exp(-(((y - 0.27) / 0.10) ** 2)) * smoothstep(0.72, 0.3, Math.abs(x));
  d += band * 0.045 * front;
  d += FIELDS.glabella(x, y, z) * 0.012 * front;
  // Eye sockets sink.
  d -= FIELDS.socketL(x, y, z) * 0.092;
  d -= FIELDS.socketR(x, y, z) * 0.092;
  // Nose: ridge strip growing toward the tip, plus tip and wings.
  if (y > -0.3 && y < 0.16 && z > 0.35) {
    const along = (0.14 - y) / 0.44;
    d += Math.exp(-((x / (0.075 + 0.05 * along)) ** 2)) * (0.012 + 0.075 * along * along) * front;
  }
  d += FIELDS.noseTip(x, y, z) * 0.035;
  d += FIELDS.noseWingL(x, y, z) * 0.022;
  d += FIELDS.noseWingR(x, y, z) * 0.022;
  // Cheekbones out, hollows under, mouth plate flattened.
  d += FIELDS.cheekL(x, y, z) * 0.044;
  d += FIELDS.cheekR(x, y, z) * 0.044;
  d -= FIELDS.hollowL(x, y, z) * 0.022;
  d -= FIELDS.hollowR(x, y, z) * 0.022;
  d -= FIELDS.mouthPlate(x, y, z) * 0.014;
  // Jaw corners, chin, temple pinch.
  d += FIELDS.jawCornerL(x, y, z) * 0.018;
  d += FIELDS.jawCornerR(x, y, z) * 0.018;
  d += FIELDS.chin(x, y, z) * 0.072;
  d -= FIELDS.templeL(x, y, z) * 0.02;
  d -= FIELDS.templeR(x, y, z) * 0.02;
  return d;
}

/** Point on the rest surface for a direction (unit or not). */
export function surfacePoint(out, dx, dy, dz) {
  const len = Math.hypot(dx, dy, dz) || 1;
  const x = dx / len, y = dy / len, z = dz / len;
  const r = 1 + sculpt(x, y, z);
  out[0] = x * r * AXES.x;
  out[1] = y * r * AXES.y;
  out[2] = z * r * AXES.z;
  return out;
}

// Rig weight channels per vertex (index order matters below).
const WEIGHTS = ["brow", "lid", "socket", "cheek", "muzzle", "jaw", "mouth", "forehead"];
const W_BROW = 0, W_LID = 1, W_SOCKET = 2, W_CHEEK = 3, W_MUZZLE = 4, W_JAW = 5, W_MOUTH = 6, W_FOREHEAD = 7;

const RINGS = 46; // latitude subdivisions
const SECTORS = 54; // longitude subdivisions

const SHELL_VERT = `
attribute vec3 aPos;
attribute vec3 aNormal;
attribute vec4 aData;
uniform mat4 uVP;
uniform mat4 uModel;
varying vec3 vNormal;
varying vec3 vWorld;
varying vec4 vData;
void main() {
  vec4 world = uModel * vec4(aPos, 1.0);
  gl_Position = uVP * world;
  vNormal = normalize((uModel * vec4(aNormal, 0.0)).xyz);
  vWorld = world.xyz;
  vData = aData;
}`;

const SHELL_FRAG = `
precision mediump float;
varying vec3 vNormal;
varying vec3 vWorld;
varying vec4 vData;
uniform vec3 uEye;
uniform vec3 uDeep;
uniform vec3 uRim;
uniform float uRimGain;
uniform float uOpacity;
uniform float uTime;
uniform float uThought;
void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uEye - vWorld);
  float fres = pow(1.0 - abs(dot(N, V)), 2.0);
  vec3 color = mix(uDeep, uRim, clamp(fres * uRimGain, 0.0, 1.0));
  // Interior shimmer: faint stratification scrolling through the skull
  // while the entity computes.
  float strata = sin(vWorld.y * 14.0 - uTime * 1.4);
  color += uRim * (uThought * 0.1 + 0.08) * (0.5 + 0.5 * strata);
  float alpha = uOpacity * (0.58 + 0.42 * fres);
  gl_FragColor = vec4(color, alpha);
}`;

const LINE_VERT = `
attribute vec3 aPos;
attribute vec3 aNormal;
attribute vec4 aColor;
attribute vec4 aData;
uniform mat4 uVP;
uniform mat4 uModel;
uniform vec3 uEye;
uniform vec3 uTint;
uniform float uTintMix;
varying vec4 vColor;
varying float vLat;
void main() {
  vec4 world = uModel * vec4(aPos, 1.0);
  gl_Position = uVP * world;
  // Holographic depth cue: topology facing away dims instead of hiding,
  // so the whole head reads as translucent.
  vec3 N = normalize((uModel * vec4(aNormal, 0.0)).xyz);
  vec3 V = normalize(uEye - world.xyz);
  float facing = smoothstep(-0.25, 0.3, dot(N, V));
  vColor = aColor;
  vColor.rgb = mix(vColor.rgb, uTint, uTintMix);
  vColor.a *= mix(0.12, 1.0, facing);
  vLat = aData.y;
}`;

const LINE_FRAG = `
precision mediump float;
varying vec4 vColor;
varying float vLat;
uniform float uSweep;   // travelling contour position (latitude 0..1)
uniform float uThink;   // thinking intensity
uniform float uGlobalAlpha;
uniform float uCap;     // per-fragment ceiling for this pass
void main() {
  // A bright band traverses the skull while reasoning. Output is
  // premultiplied for screen blending, which caps stacked luminance.
  float band = exp(-pow((vLat - uSweep) * 5.0, 2.0));
  float alpha = min(vColor.a * uGlobalAlpha * (1.0 + uThink * 2.8 * band), uCap);
  if (alpha < 0.004) discard;
  vec3 rgb = vColor.rgb * (1.0 + uThink * band * 0.8) * alpha;
  gl_FragColor = vec4(min(rgb, vec3(1.0)), alpha);
}`;

function hash(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * AgentHead — geometry, rig and expression rendering for the entity's face.
 */
export class AgentHead {
  constructor(renderer) {
    this.renderer = renderer;
    // Scratch buffers reused every frame (no per-frame allocation).
    this.scratchA = new Float32Array(3);
    this.scratchB = new Float32Array(3);
    this.gazeWorld = new Float32Array(4);
    this.buildSurface();
    this.buildFeatures();
    this.buildPrograms();

    // Head transform state.
    this.model = mat4.create();
    this.rotX = 0; this.rotY = 0; this.rotZ = 0;
    this.bobPhase = Math.random() * 10;

    // Gaze / saccade / blink state.
    this.saccadeX = 0; this.saccadeY = 0;
    this.saccadeTargetX = 0; this.saccadeTargetY = 0;
    this.nextSaccade = 0;
    this.blink = 1; // 1 = fully open
    this.blinkT = -1;
    this.blinkDouble = false;
    this.nextBlink = 1.5 + Math.random() * 3;
    this.sweep = 0;
  }

  // ------------------------------------------------------------------
  // Surface construction
  // ------------------------------------------------------------------

  buildSurface() {
    const vertexCount = (RINGS + 1) * SECTORS;
    const rest = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const data = new Float32Array(vertexCount * 4); // feature, lat01, phase, crown
    const weights = new Float32Array(vertexCount * WEIGHTS.length);
    this.rest = rest;
    this.normals = normals;
    this.weights = weights;
    this.vertexCount = vertexCount;

    const lidLineL = field(-0.36, 0.215, 0.82, 0.085);
    const lidLineR = field(0.36, 0.215, 0.82, 0.085);
    const browBandL = field(-0.34, 0.30, 0.78, 0.13);
    const browBandR = field(0.34, 0.30, 0.78, 0.13);
    const muzzleField = field(0, -0.34, 0.86, 0.30);
    const mouthField = field(0, -0.48, 0.84, 0.10);

    let v = 0;
    for (let i = 0; i <= RINGS; i++) {
      const phi = (i / RINGS) * Math.PI;
      const sy = Math.cos(phi);
      const sr = Math.sin(phi);
      for (let j = 0; j < SECTORS; j++) {
        const theta = (j / SECTORS) * Math.PI * 2 + Math.PI / 2;
        const sx = sr * Math.cos(theta);
        const sz = sr * Math.sin(theta);
        // Asymmetry: a living entity is never perfectly symmetric.
        const asym = 1 + 0.012 * Math.sin(phi * 2.3 + 1.7) + 0.008 * Math.sin(theta * 3.1);
        surfacePoint(this.scratchA ||= new Float32Array(3), sx, sy, sz);
        rest[v * 3] = this.scratchA[0] * asym;
        rest[v * 3 + 1] = this.scratchA[1];
        rest[v * 3 + 2] = this.scratchA[2];
        normals[v * 3] = sx; normals[v * 3 + 1] = sy; normals[v * 3 + 2] = sz;

        // Rig weights from the anatomical fields.
        const w = weights;
        const base = v * WEIGHTS.length;
        const browL = browBandL(sx, sy, sz), browR = browBandR(sx, sy, sz);
        w[base + W_BROW] = Math.min(1, browL + browR);
        w[base + W_LID] = Math.min(1, lidLineL(sx, sy, sz) + lidLineR(sx, sy, sz));
        w[base + W_SOCKET] = Math.min(1, FIELDS.socketL(sx, sy, sz) + FIELDS.socketR(sx, sy, sz));
        w[base + W_CHEEK] = Math.min(1, FIELDS.cheekL(sx, sy, sz) + FIELDS.cheekR(sx, sy, sz));
        w[base + W_MUZZLE] = muzzleField(sx, sy, sz);
        w[base + W_MOUTH] = mouthField(sx, sy, sz);
        w[base + W_FOREHEAD] = smoothstep(0.2, 0.55, sy) * smoothstep(0.1, 0.5, sz);
        const jawBoundary = -0.34 - 0.16 * smoothstep(0.1, 0.7, sz) - 0.10 * (1 - Math.abs(sx));
        w[base + W_JAW] = smoothstep(jawBoundary, jawBoundary - 0.16, sy);

        // Per-vertex data for the four render layers.
        const feature = Math.min(1,
          w[base + W_BROW] * 0.8 + w[base + W_LID] * 1.0 + w[base + W_SOCKET] * 0.55 +
          w[base + W_MOUTH] * 1.0 + FIELDS.noseTip(sx, sy, sz) * 0.9 + w[base + W_JAW] * 0.12);
        const phase = hash(v * 1.618 + 0.7);
        data[v * 4] = feature;
        data[v * 4 + 1] = 1 - i / RINGS; // lat01: 1 at crown
        data[v * 4 + 2] = phase;
        data[v * 4 + 3] = smoothstep(0.35, 0.85, sy);
        v += 1;
      }
    }

    // Index buffers ---------------------------------------------------
    const tri = [];
    for (let i = 0; i < RINGS; i++) {
      for (let j = 0; j < SECTORS; j++) {
        const a = i * SECTORS + j;
        const b = i * SECTORS + (j + 1) % SECTORS;
        const c = (i + 1) * SECTORS + j;
        const d = (i + 1) * SECTORS + (j + 1) % SECTORS;
        tri.push(a, c, d, a, d, b);
      }
    }
    const wire = [];
    const wireRingEvery = 3, wireSectorEvery = 4;
    for (let i = 1; i < RINGS; i += wireRingEvery) {
      for (let j = 0; j < SECTORS; j++) {
        wire.push(i * SECTORS + j, i * SECTORS + (j + 1) % SECTORS);
      }
    }
    for (let j = 0; j < SECTORS; j += wireSectorEvery) {
      for (let i = 2; i < RINGS - 1; i++) {
        wire.push(i * SECTORS + j, (i + 1) * SECTORS + j);
      }
    }
    // Sparse diagonals break the lat/long globe pattern into a faceted
    // reconstruction mesh, like a Kinect depth solve rather than a cage.
    for (let i = 3; i < RINGS - 2; i += 4) {
      for (let j = (i % 2) * 2; j < SECTORS; j += 4) {
        wire.push(i * SECTORS + j, (i + 3) * SECTORS + (j + 2) % SECTORS);
      }
    }
    const contour = [];
    for (let i = 1; i < RINGS; i += 2) {
      for (let j = 0; j < SECTORS; j++) {
        contour.push(i * SECTORS + j, i * SECTORS + (j + 1) % SECTORS);
      }
    }
    const points = [];
    for (let i = 1; i < RINGS; i += 1) {
      for (let j = 0; j < SECTORS; j++) {
        const vi = i * SECTORS + j;
        const front = normals[vi * 3 + 2];
        // Dense facial samples, sparse rear-skull context.
        if (front > 0.02 || ((i * 17 + j * 13) % 7 === 0)) points.push(vi);
      }
    }

    // Meshes ----------------------------------------------------------
    // Shell: positions + normals + data.
    this.shellMesh = new Mesh(this.renderer, [
      { name: "aPos", size: 3, dynamic: true },
      { name: "aNormal", size: 3 },
      { name: "aData", size: 4 },
    ]);
    this.shellMesh.set("aPos", rest);
    this.shellMesh.set("aNormal", normals);
    this.shellMesh.set("aData", data);
    this.shellMesh.setIndex(new Uint16Array(tri));

    // Lines share their own pool with baked colors.
    this.lineColors = new Float32Array(vertexCount * 4);
    this.computeLayerColors(data, weights);
    this.lineMesh = new Mesh(this.renderer, [
      { name: "aPos", size: 3, dynamic: true },
      { name: "aNormal", size: 3 },
      { name: "aColor", size: 4, dynamic: true },
      { name: "aData", size: 4 },
    ]);
    this.lineMesh.set("aPos", rest);
    this.lineMesh.set("aNormal", normals);
    this.lineMesh.set("aColor", this.lineColors);
    this.lineMesh.set("aData", data);

    this.wireIndex = this.makeIndex(wire);
    this.contourIndex = this.makeIndex(contour);

    // The streamed pose buffer, copied into both pools each frame.
    this.pose = new Float32Array(rest);

    // Surface cloud: billboard sprites at a decimated subset of vertices.
    this.cloudIndices = points;
    this.cloudField = new PointField(this.renderer, points.length);
    this.basePointAlpha = new Float32Array(points.length);
    this.basePointSize = new Float32Array(points.length);
    for (let i = 0; i < points.length; i++) {
      const feature = data[points[i] * 4];
      const front = clamp(normals[points[i] * 3 + 2] * 0.7 + 0.3);
      this.basePointAlpha[i] = 0.12 + front * 0.22 + feature * 0.3;
      this.basePointSize[i] = 0.72 + feature * 0.72;
    }
  }

  makeIndex(indices) {
    const gl = this.renderer.gl;
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
    return { buffer, count: indices.length };
  }

  computeLayerColors(data, weights) {
    for (let v = 0; v < this.vertexCount; v++) {
      const feature = data[v * 4];
      const crown = data[v * 4 + 3];
      // Wire: the topology IS the head's body. The grid carries enough
      // alpha to read as a luminous surface; feature lines (brow, lids,
      // mouth) burn brighter still. Interior crossings stay under control
      // because only a decimated grid draws here.
      this.lineColors[v * 4] = 0.34 + feature * 0.38;
      this.lineColors[v * 4 + 1] = 0.88 + feature * 0.12;
      this.lineColors[v * 4 + 2] = 0.96 + feature * 0.04;
      this.lineColors[v * 4 + 3] = 0.16 + feature * 0.7 + crown * 0.03;
    }
  }

  // ------------------------------------------------------------------
  // Feature apertures (eyes, brows, mouth) as a small dynamic line pool
  // ------------------------------------------------------------------

  buildFeatures() {
    // 2 brows × 9 pts, nose bridge 5, 2 socket rings × 14, 4 lid arcs × 8,
    // mouth 16 + teeth 16 → line vertices, plus 2 iris sprites.
    this.MAX_FEATURE_VERTS = 220;
    this.featurePos = new Float32Array(this.MAX_FEATURE_VERTS * 3);
    this.featureNormal = new Float32Array(this.MAX_FEATURE_VERTS * 3);
    this.featureColor = new Float32Array(this.MAX_FEATURE_VERTS * 4);
    this.featureData = new Float32Array(this.MAX_FEATURE_VERTS * 4);
    this.featureMesh = new Mesh(this.renderer, [
      { name: "aPos", size: 3, dynamic: true },
      { name: "aNormal", size: 3, dynamic: true },
      { name: "aColor", size: 4, dynamic: true },
      { name: "aData", size: 4 },
    ]);
    this.featureMesh.set("aPos", this.featurePos);
    this.featureMesh.set("aNormal", this.featureNormal);
    this.featureMesh.set("aColor", this.featureColor);
    this.featureMesh.set("aData", this.featureData);
    this.featureCount = 0;

    // The two luminous irises.
    this.irisField = new PointField(this.renderer, 2);
    this.irisPos = new Float32Array(2 * 3);
    this.irisBright = new Float32Array(2);
    this.irisSize = new Float32Array(2);
  }

  buildPrograms() {
    this.shellProgram = this.renderer.program(SHELL_VERT, SHELL_FRAG);
    this.lineProgram = this.renderer.program(LINE_VERT, LINE_FRAG);
  }

  /** Append a polyline vertex; returns vertex index for line pairing. */
  pushFeature(x, y, z, nx, ny, nz, r, g, b, a, lat) {
    const i = this.featureCount;
    if (i >= this.MAX_FEATURE_VERTS) return i - 1;
    this.featurePos[i * 3] = x; this.featurePos[i * 3 + 1] = y; this.featurePos[i * 3 + 2] = z;
    this.featureNormal[i * 3] = nx; this.featureNormal[i * 3 + 1] = ny; this.featureNormal[i * 3 + 2] = nz;
    this.featureColor[i * 4] = r; this.featureColor[i * 4 + 1] = g; this.featureColor[i * 4 + 2] = b;
    this.featureColor[i * 4 + 3] = a;
    this.featureData[i * 4 + 1] = lat;
    this.featureCount = i + 1;
    return i;
  }

  // ------------------------------------------------------------------
  // Per-frame pose evaluation
  // ------------------------------------------------------------------

  update(dt, time, visual, mouth, accents) {
    const e = visual.expression;
    const pose = this.pose;
    const rest = this.rest;
    const weights = this.weights;
    const n = this.vertexCount;

    // Gaze micro-saccades: tiny rapid jumps, sprung loosely so they read
    // as life rather than twitch.
    if (!visual.reducedMotion) {
      if (time > this.nextSaccade) {
        this.nextSaccade = time + 0.35 + Math.random() * 1.6;
        this.saccadeTargetX = (Math.random() - 0.5) * 0.14;
        this.saccadeTargetY = (Math.random() - 0.5) * 0.09;
      }
      const k = 1 - Math.exp(-16 * dt);
      this.saccadeX += (this.saccadeTargetX - this.saccadeX) * k;
      this.saccadeY += (this.saccadeTargetY - this.saccadeY) * k;
    }
    const gazeX = clamp(visual.gazeX + this.saccadeX, -0.85, 0.85);
    const gazeY = clamp(visual.gazeY + this.saccadeY, -0.85, 0.85);

    // Blink scheduler: more frequent while attentive, occasional doubles.
    if (this.blinkT < 0 && time > this.nextBlink) {
      this.blinkT = 0;
      this.blinkDouble = Math.random() < 0.12;
    }
    let blinkOpen = 1;
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      const closeDur = 0.11, openDur = 0.16;
      const cycle = closeDur + openDur + (this.blinkDouble ? 0.24 : 0);
      if (this.blinkT < closeDur) blinkOpen = 1 - this.blinkT / closeDur;
      else if (this.blinkT < closeDur + openDur) blinkOpen = (this.blinkT - closeDur) / openDur;
      else if (this.blinkDouble && this.blinkT < cycle) {
        // Second, quicker blink of a double-blink.
        const t2 = this.blinkT - closeDur - openDur;
        blinkOpen = t2 < 0.07 ? 1 - t2 / 0.07 : Math.min(1, (t2 - 0.07) / 0.1);
      } else {
        this.blinkT = -1;
        this.nextBlink = time + (visual.listening > 0.5 ? 1.6 : 2.4) + Math.random() * (visual.listening > 0.5 ? 2.6 : 4.4);
      }
    }
    this.blink = clamp(blinkOpen);

    // Head orientation: follows gaze with heavy lag (eyes lead the head),
    // plus expression tilt and an error stutter.
    const targetRX = -gazeY * 0.16 - e.concern * 0.04 + mouth.energy * 0.015 * Math.sin(time * 3.1);
    const targetRY = -gazeX * 0.30;
    const targetRZ = e.tiltZ * 0.22
      + (visual.errorIntensity > 0.4 ? 0.018 * Math.sin(time * 41.0) * visual.errorIntensity : 0);
    const kh = 1 - Math.exp(-5.5 * dt);
    this.rotX += (targetRX - this.rotX) * kh;
    this.rotY += (targetRY - this.rotY) * kh;
    this.rotZ += (targetRZ - this.rotZ) * kh;

    // Breathing and presence.
    const breath = visual.reducedMotion ? 0 : 1;
    const breathe = 1 + breath * (0.006 * Math.sin(time * 0.55 + this.bobPhase) + visual.energy * 0.008 * Math.sin(time * 2.3));
    const bob = breath * 0.012 * Math.sin(time * 0.5 + this.bobPhase);
    const lean = 0.05 * visual.listening + 0.03 * visual.attention * 0.3;
    // Sit slightly high in the stage, preserving a calm caption lane below.
    mat4.compose(this.model, 0, 0.10 + bob, lean, this.rotX, this.rotY, this.rotZ, breathe);

    // Temporal stutter during disruption: the entity's sense of time hitches.
    const stutter = visual.errorIntensity > 0.45 ? Math.floor(time * 11) / 11 : time;
    const dispersal = visual.dispersal;
    const speechVib = visual.speechActivity * 0.5 + (mouth.energy || 0) * 0.5;
    const errJit = visual.errorIntensity;
    const capturePull = visual.capture;

    const browRaise = e.browRaise, browFurrow = e.browFurrow;
    const squint = e.squint * 0.6 + e.concern * 0.35;
    const smile = e.smile, concern = e.concern;
    const jawAngle = (mouth.jaw * 0.20 + e.jawRelax * 0.05);
    const jawSin = Math.sin(jawAngle), jawCos = Math.cos(jawAngle);
    const jawPivotY = -0.16, jawPivotZ = 0.05;

    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      const px = rest[i3], py = rest[i3 + 1], pz = rest[i3 + 2];
      const nx = this.normals[i3], ny = this.normals[i3 + 1], nz = this.normals[i3 + 2];
      const base = i * WEIGHTS.length;
      let dx = 0, dy = 0, dz = 0;

      const browW = weights[base + W_BROW];
      if (browW > 0.002) {
        const raise = browRaise * browW;
        dx += nx * 0.030 * raise; dy += 0.020 * raise;
        const furrow = browFurrow * browW;
        dx += (px < 0 ? 0.014 : -0.014) * furrow;
        dy += -0.010 * furrow * Math.abs(px) * 2.2;
      }
      const socketW = weights[base + W_SOCKET];
      if (socketW > 0.002) {
        const sink = squint * 0.012 * socketW;
        dx -= nx * sink; dy -= ny * sink; dz -= nz * sink;
      }
      const cheekW = weights[base + W_CHEEK];
      if (cheekW > 0.002) {
        dx += (px < 0 ? -1 : 1) * 0.016 * smile * cheekW;
        dy += 0.013 * smile * cheekW - 0.015 * concern * cheekW;
      }
      const muzzleW = weights[base + W_MUZZLE];
      if (dispersal > 0.003) {
        // Surfaces loosen and drift apart along their normals while the
        // entity computes — per-vertex phase keeps it organic.
        const phase = hash(i * 0.618);
        const wob = 0.5 + 0.5 * Math.sin(stutter * (0.7 + phase * 1.6) + phase * 6.283);
        const amp = dispersal * 0.030 * wob;
        dx += nx * amp; dy += ny * amp; dz += nz * amp;
      }
      if (speechVib > 0.004) {
        const vib = speechVib * 0.0038 * (0.35 + 0.65 * Math.max(muzzleW, cheekW * 0.6)) * (0.6 + 0.4 * Math.sin(stutter * 21 + i));
        dx += nx * vib; dy += ny * vib; dz += nz * vib;
      }
      if (errJit > 0.01) {
        const jit = errJit * 0.011 * Math.sin(stutter * 43.0 + i * 12.9898) * (1.15 - 0.5 * weights[base + W_FOREHEAD]);
        dx += nx * jit; dy += ny * jit; dz += nz * jit;
      }
      if (capturePull > 0.01) {
        // The "captured" moment: the whole surface draws imperceptibly inward.
        const pull = capturePull * 0.016 * (0.5 + 0.5 * Math.sin(i * 0.04));
        dx -= nx * pull; dy -= ny * pull; dz -= nz * pull;
      }

      // Jaw skinning: rotate the jaw-weighted portion about the ear axis.
      const jawW = weights[base + W_JAW];
      let ox = px + dx, oy = py + dy, oz = pz + dz;
      if (jawW > 0.001 && jawAngle > 0.0005) {
        const rx = ox, ry = oy - jawPivotY, rz = oz - jawPivotZ;
        const rry = ry * jawCos - rz * jawSin;
        const rrz = ry * jawSin + rz * jawCos;
        const bl = jawW;
        oy = lerp(oy, jawPivotY + rry, bl);
        oz = lerp(oz, jawPivotZ + rrz, bl);
        ox = lerp(ox, rx, bl);
      }
      pose[i3] = ox; pose[i3 + 1] = oy; pose[i3 + 2] = oz;
    }

    // Stream the pose into both surface pools.
    this.shellMesh.subupdate("aPos", pose);
    this.lineMesh.subupdate("aPos", pose);

    // Surface cloud dynamics: brighter and slightly swollen when energized.
    const energy = visual.energy;
    const glow = 0.88 + energy * 0.75 + visual.thinkingIntensity * 0.22;
    const swell = 1 + visual.energy * 0.12;
    const dpr = this.renderer.dprScale;
    const field = this.cloudField;
    const cloudIndices = this.cloudIndices;
    const baseAlpha = this.basePointAlpha;
    const baseSize = this.basePointSize;
    const ca = this.accentCache ||= [0, 0, 0];
    ca[0] = accents.primary[0];
    ca[1] = accents.primary[1];
    ca[2] = accents.primary[2];
    field.begin();
    for (let i = 0; i < cloudIndices.length; i++) {
      const vi = cloudIndices[i];
      const lat = 1 - Math.acos(clamp(this.normals[vi * 3 + 1], -1, 1)) / Math.PI;
      const scanOffset = (lat - this.sweep) * 11;
      const scan = Math.exp(-(scanOffset ** 2)) * visual.thinkingIntensity;
      const alpha = Math.min(0.44, baseAlpha[i] * glow + scan * 0.16);
      if (alpha < 0.008) continue;
      field.push(
        pose[vi * 3], pose[vi * 3 + 1], pose[vi * 3 + 2],
        baseSize[i] * (swell + scan * 0.38) * dpr,
        lerp(ca[0], 0.92, scan * 0.35), lerp(ca[1], 0.98, scan * 0.2), lerp(ca[2], 1, scan * 0.15), alpha,
        (vi % SECTORS) / SECTORS,
      );
    }

    // Features (brows, lids, sockets, mouth) follow the same pose language.
    this.featureCount = 0;
    this.updateFeatures(time, visual, mouth, accents, gazeX, gazeY, jawSin, jawCos);

    // Contour sweep travels crown → chin while thinking.
    const sweepSpeed = 0.22 + visual.thinkingIntensity * 0.5;
    this.sweep = (this.sweep + dt * sweepSpeed) % 1;
  }

  /** Evaluate the feature aperture geometry into the dynamic line pool. */
  updateFeatures(time, visual, mouth, accents, gazeX, gazeY, jawSin, jawCos) {
    const e = visual.expression;
    const lidOpen = clamp(e.lidOpen * this.blink, 0.02, 1);
    const accent = accents.primary;
    const accentSoft = accents.secondary;
    const p = this.scratchA;
    const q = this.scratchB;
    const jawPivotY = -0.16, jawPivotZ = 0.05;

    const jawDrop = (point) => {
      const ry = point[1] - jawPivotY, rz = point[2] - jawPivotZ;
      point[1] = jawPivotY + ry * jawCos - rz * jawSin;
      point[2] = jawPivotZ + ry * jawSin + rz * jawCos;
      return point;
    };

    // --- Eye sockets, lids, irises --------------------------------
    for (const side of [-1, 1]) {
      const eyeX = 0.36 * side;
      // Socket ring, drawn as consecutive segment pairs.
      const ringSegments = 14;
      for (let k = 0; k < ringSegments; k++) {
        for (const step of [0, 1]) {
          const a = ((k + step) / ringSegments) * Math.PI * 2;
          surfacePoint(p, eyeX + Math.cos(a) * 0.135, 0.155 + Math.sin(a) * 0.105, 0.86);
          p[0] *= 1.012; p[1] *= 1.012; p[2] *= 1.012;
          this.pushFeature(p[0], p[1], p[2], p[0], p[1], p[2],
            accent[0], accent[1], accent[2], 0.14 + visual.attention * 0.1, 0.35);
        }
      }
      // Lids: two arcs whose separation is `lidOpen`; gaze slides both.
      const lidSegments = 7;
      const spread = 0.06 + lidOpen * 0.115;
      const gazeU = gazeX * 0.045;
      const gazeV = gazeY * 0.03;
      for (const lidSide of [-1, 1]) {
        for (let k = 0; k < lidSegments; k++) {
          for (const step of [0, 1]) {
            const t = (k + step) / lidSegments;
            const u = (t * 2 - 1) * 0.16;
            const v = lidSide * spread * Math.cos((t * 2 - 1) * Math.PI * 0.5) + gazeV;
            surfacePoint(q, eyeX + u + gazeU * 0.4, 0.155 + v * 0.9, 0.86);
            q[0] *= 1.016; q[1] *= 1.016; q[2] *= 1.016;
            this.pushFeature(q[0], q[1], q[2], q[0], q[1], q[2],
              accent[0], accent[1], accent[2], lidSide < 0 ? 0.44 : 0.6, 0.35);
          }
        }
      }
      // Iris: the luminous aperture core, brighter with attention.
      const slot = side < 0 ? 0 : 1;
      surfacePoint(p, eyeX + gazeX * 0.075, 0.155 + gazeY * 0.05, 0.87);
      this.irisPos[slot * 3] = p[0] * 1.02;
      this.irisPos[slot * 3 + 1] = p[1] * 1.02;
      this.irisPos[slot * 3 + 2] = p[2] * 1.02;
      this.irisBright[slot] = (0.5 + visual.attention * 0.5) * lidOpen;
      this.irisSize[slot] = 18 + visual.attention * 9;
    }

    // --- Brows -----------------------------------------------------
    for (const side of [-1, 1]) {
      const browSegments = 7;
      const raise = e.browRaise;
      const furrow = e.browFurrow;
      const innerDrop = furrow * 0.05 - raise * 0.012;
      for (let k = 0; k < browSegments; k++) {
        const t0 = k / browSegments, t1 = (k + 1) / browSegments;
        for (const t of [t0, t1]) {
          const s = (t * 2 - 1) * side; // -1 inner, +1 outer (mirrored)
          const u = 0.36 * side + s * 0.16 * side;
          const arch = -Math.abs(t * 2 - 1) * 0.35 + 1;
          const v = 0.315 + raise * 0.055 * (0.4 + arch * 0.6) - (t < 0.5 ? innerDrop : 0) * (1 - t * 1.6);
          surfacePoint(q, u, v, 0.82);
          q[0] *= 1.014; q[1] *= 1.014; q[2] *= 1.014;
          this.pushFeature(q[0], q[1], q[2], q[0], q[1], q[2],
            accent[0], accent[1], accent[2], 0.68 + e.browRaise * 0.3, 0.3);
        }
      }
    }

    // --- Nose bridge -----------------------------------------------
    for (let k = 0; k < 4; k++) {
      const t0 = k / 4, t1 = (k + 1) / 4;
      for (const t of [t0, t1]) {
        surfacePoint(q, 0, lerp(0.20, -0.16, t), 0.9);
        q[0] *= 1.012; q[1] *= 1.012; q[2] *= 1.012;
        this.pushFeature(q[0], q[1], q[2], q[0], q[1], q[2],
          accentSoft[0], accentSoft[1], accentSoft[2], 0.2, 0.28);
      }
    }

    // --- Mouth ------------------------------------------------------
    const segments = 14;
    const width = 0.205 * (1 + mouth.wide * 0.42 - mouth.round * 0.5);
    for (let k = 0; k < segments; k++) {
      const t0 = k / segments, t1 = (k + 1) / segments;
      for (const t of [t0, t1]) {
        const s = t * 2 - 1;
        const bell = Math.cos(s * Math.PI * 0.5) ** 1.2;
        const cornerLift = mouth.wide * 0.035 * Math.abs(s) - e.concern * 0.03 * Math.abs(s);
        // Upper lip line.
        surfacePoint(q, Math.asin(clamp(s * width, -0.99, 0.99)) * 1.0, -0.47 + cornerLift * 0.6 + mouth.round * 0.012 * bell, 0.85);
        q[2] += mouth.round * 0.055 * bell + mouth.narrow * 0.045 * bell - mouth.wide * 0.012;
        jawDrop(q);
        this.pushFeature(q[0], q[1], q[2], q[0], q[1], q[2],
          accent[0], accent[1], accent[2], 0.74 + mouth.energy * 0.3, 0.22);
        // Lower lip line, dropped by jaw openness.
        surfacePoint(q, Math.asin(clamp(s * width * 0.92, -0.99, 0.99)) * 1.0, -0.485 - mouth.jaw * 0.16 * bell - mouth.press * 0.012 + cornerLift * 0.5, 0.85);
        q[2] += mouth.round * 0.06 * bell + mouth.narrow * 0.05 * bell;
        jawDrop(q);
        this.pushFeature(q[0], q[1], q[2], q[0], q[1], q[2],
          accent[0], accent[1], accent[2], 0.62 + mouth.energy * 0.25, 0.22);
        // Teeth / inner mouth line when FV or open.
        if (mouth.teeth > 0.06 || mouth.jaw > 0.25) {
          const inner = Math.max(mouth.teeth, mouth.jaw * 0.55);
          surfacePoint(q, Math.asin(clamp(s * width * 0.78, -0.99, 0.99)) * 1.0, -0.475 - mouth.jaw * 0.07 * bell, 0.83);
          jawDrop(q);
          this.pushFeature(q[0], q[1], q[2], q[0], q[1], q[2],
            0.95, 0.97, 1.0, 0.42 * inner, 0.22);
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // Drawing
  // ------------------------------------------------------------------

  draw(renderer, visual, accents) {
    const gl = renderer.gl;
    const model = this.model;
    const eye = renderer.eye;
    const rim = accents.primary;
    const deep = accents.deep;

    // Interior shimmer register for the shell.
    const thought = visual.thinkingIntensity * 0.8 + visual.toolActivity * 0.4;

    // Shell back faces then front faces: translucent glass with volume.
    const shellUniforms = {
      uVP: renderer.viewProjection,
      uModel: model,
      uEye: eye,
      uDeep: [deep[0], deep[1], deep[2]],
      uRim: [rim[0], rim[1], rim[2]],
      uRimGain: 1.35 + visual.energy * 0.6,
      uOpacity: 0.34,
      uTime: this.renderer.time,
      uThought: thought,
    };
    renderer.normalBlend();
    gl.cullFace(gl.FRONT);
    gl.enable(gl.CULL_FACE);
    this.shellMesh.draw(this.shellProgram, {
      uniforms: { ...shellUniforms, uOpacity: 0.18 },
    });
    gl.cullFace(gl.BACK);
    this.shellMesh.draw(this.shellProgram, { uniforms: shellUniforms });
    gl.disable(gl.CULL_FACE);

    // State tint: computation warms the entire topology toward amber.
    const tintMix = Math.min(0.28, visual.thinkingIntensity * 0.22 + visual.toolActivity * 0.12 + visual.errorIntensity * 0.28);

    // Topology wire (decimated) — the structural signature.
    renderer.additive();
    gl.disable(gl.DEPTH_TEST);
    this.lineMesh.index = this.wireIndex;
    this.lineMesh.draw(this.lineProgram, {
      mode: gl.LINES,
      uniforms: {
        uVP: renderer.viewProjection,
        uModel: model,
        uEye: eye,
        uTint: rim,
        uTintMix: tintMix,
        uSweep: this.sweep,
        uThink: visual.thinkingIntensity * 0.8,
        uGlobalAlpha: 0.9 + visual.energy * 0.35,
        uCap: 0.38,
      },
    });

    // Travelling contours (a whisper at rest, a scan while thinking).
    this.lineMesh.index = this.contourIndex;
    this.lineMesh.draw(this.lineProgram, {
      mode: gl.LINES,
      uniforms: {
        uVP: renderer.viewProjection,
        uModel: model,
        uEye: eye,
        uTint: rim,
        uTintMix: tintMix,
        uSweep: this.sweep,
        uThink: visual.thinkingIntensity,
        uGlobalAlpha: 0.05 + visual.thinkingIntensity * 0.4,
        uCap: 0.16,
      },
    });

    // Surface point cloud.
    this.cloudField.draw(renderer, { flicker: visual.thinkingIntensity * 0.8, model });

    // Feature apertures (consecutive vertex pairs → LINES via drawArrays).
    const count = this.featureCount & ~1;
    if (count > 1) {
      this.featureMesh.subupdate("aPos", this.featurePos);
      this.featureMesh.subupdate("aNormal", this.featureNormal);
      this.featureMesh.subupdate("aColor", this.featureColor);
      this.featureMesh.subupdate("aData", this.featureData);
      this.featureMesh.draw(this.lineProgram, {
        mode: gl.LINES,
        count,
        uniforms: {
          uVP: renderer.viewProjection,
          uModel: model,
          uEye: eye,
          uSweep: this.sweep,
          uThink: 0,
          uGlobalAlpha: 1.05,
          uCap: 0.85,
        },
      });
    }
    // Irises: two luminous sprites.
    const dpr = renderer.dprScale;
    const irisField = this.irisField;
    irisField.begin();
    const bright0 = this.irisBright[0], bright1 = this.irisBright[1];
    if (bright0 > 0.01 || bright1 > 0.01) {
      irisField.push(
        this.irisPos[0], this.irisPos[1], this.irisPos[2],
        this.irisSize[0] * dpr,
        lerp(rim[0], 1, 0.35), lerp(rim[1], 1, 0.35), lerp(rim[2], 1, 0.35),
        0.95 * bright0, 0.5,
      );
      irisField.push(
        this.irisPos[3], this.irisPos[4], this.irisPos[5],
        this.irisSize[1] * dpr,
        lerp(rim[0], 1, 0.35), lerp(rim[1], 1, 0.35), lerp(rim[2], 1, 0.35),
        0.95 * bright1, 0.5,
      );
      irisField.draw(renderer, { model });
    }
    gl.enable(gl.DEPTH_TEST);
  }

  /** World-space gaze focus (eyes lead, so this is ahead of head rotation). */
  getGazeWorld(out) {
    const target = out || this.gazeWorld;
    const mx = (this.irisPos[0] + this.irisPos[3]) * 0.5;
    const my = (this.irisPos[1] + this.irisPos[4]) * 0.5;
    const mz = (this.irisPos[2] + this.irisPos[5]) * 0.5 + 0.9;
    mat4.transformPoint(target, this.model, mx, my, mz);
    return target;
  }
}
