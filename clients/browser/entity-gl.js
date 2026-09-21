// Minimal WebGL layer for the entity scene.
//
// Deliberately dependency-free: the voice page is served from an exact
// allowlist under a strict CSP (script-src 'self'), so everything here is
// hand-rolled — column-major mat4 math, a program cache, static/dynamic
// attribute buffers and a billboard sprite batch. All shaders are GLSL ES
// 1.00, which both WebGL1 and WebGL2 contexts accept.

// ----------------------------------------------------------------------
// mat4 (column major, matching WebGL conventions)
// ----------------------------------------------------------------------

export const mat4 = {
  create() {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
  },

  perspective(out, fovY, aspect, near, far) {
    const f = 1 / Math.tan(fovY / 2);
    const nf = 1 / (near - far);
    out.fill(0);
    out[0] = f / aspect;
    out[5] = f;
    out[10] = (far + near) * nf;
    out[11] = -1;
    out[14] = 2 * far * near * nf;
    return out;
  },

  lookAt(out, eye, center, up) {
    let zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
    let len = Math.hypot(zx, zy, zz) || 1;
    zx /= len; zy /= len; zz /= len;
    let xx = up[1] * zz - up[2] * zy;
    let xy = up[2] * zx - up[0] * zz;
    let xz = up[0] * zy - up[1] * zx;
    len = Math.hypot(xx, xy, xz) || 1;
    xx /= len; xy /= len; xz /= len;
    const yx = zy * xz - zz * xy;
    const yy = zz * xx - zx * xz;
    const yz = zx * xy - zy * xx;
    out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
    out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
    out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
    out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
    out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
    out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
    out[15] = 1;
    return out;
  },

  multiply(out, a, b) {
    const t = mat4.scratch || (mat4.scratch = new Float32Array(16));
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        t[c * 4 + r] =
          a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
    }
    out.set(t);
    return out;
  },

  /** Rigid transform: translate * rotZ * rotY * rotX * uniform scale. */
  compose(out, tx, ty, tz, rx, ry, rz, scale) {
    const cx = Math.cos(rx), sx = Math.sin(rx);
    const cy = Math.cos(ry), sy = Math.sin(ry);
    const cz = Math.cos(rz), sz = Math.sin(rz);
    // R = Rz * Ry * Rx
    const r00 = cz * cy, r01 = cz * sy * sx - sz * cx, r02 = cz * sy * cx + sz * sx;
    const r10 = sz * cy, r11 = sz * sy * sx + cz * cx, r12 = sz * sy * cx - cz * sx;
    const r20 = -sy, r21 = cy * sx, r22 = cy * cx;
    out[0] = r00 * scale; out[1] = r10 * scale; out[2] = r20 * scale; out[3] = 0;
    out[4] = r01 * scale; out[5] = r11 * scale; out[6] = r21 * scale; out[7] = 0;
    out[8] = r02 * scale; out[9] = r12 * scale; out[10] = r22 * scale; out[11] = 0;
    out[12] = tx; out[13] = ty; out[14] = tz; out[15] = 1;
    return out;
  },

  /** Transform a point by a matrix; out is a 4-component array. */
  transformPoint(out, m, x, y, z, w = 1) {
    out[0] = m[0] * x + m[4] * y + m[8] * z + m[12] * w;
    out[1] = m[1] * x + m[5] * y + m[9] * z + m[13] * w;
    out[2] = m[2] * x + m[6] * y + m[10] * z + m[14] * w;
    out[3] = m[3] * x + m[7] * y + m[11] * z + m[15] * w;
    return out;
  },
};

// ----------------------------------------------------------------------
// Billboard sprite fields.
//
// gl.POINTS is deliberately NOT used: several WebGL rasterizers (notably
// ANGLE/SwiftShader configurations) mis-handle gl_PointSize, rendering
// every point at the implementation's maximum size. Camera-facing quads
// with an exact pixel size behave identically on every driver.
// ----------------------------------------------------------------------

const BILLBOARD_VERT = `
attribute vec3 aCenter;
attribute vec2 aCorner;
attribute float aSize;
attribute vec4 aColor;
attribute float aPhase;
uniform mat4 uVP;
uniform mat4 uModel;
uniform vec2 uViewport;
uniform float uTime;
uniform float uFlicker;
varying vec4 vColor;
varying vec2 vUV;
void main() {
  vec4 clip = uVP * uModel * vec4(aCenter, 1.0);
  vec2 pixel = aCorner * aSize * 2.0 / uViewport;
  gl_Position = vec4(clip.xy / clip.w + pixel, clip.z / clip.w, clip.w);
  float flick = 1.0 + uFlicker * 0.5 * sin(uTime * (1.5 + aPhase * 3.5) + aPhase * 6.2831);
  vColor = aColor;
  vColor.rgb *= mix(1.0, flick, uFlicker);
  vUV = aCorner;
}`;

const BILLBOARD_FRAG = `
precision mediump float;
varying vec4 vColor;
varying vec2 vUV;
void main() {
  float r2 = dot(vUV, vUV);
  if (r2 > 1.0) discard;
  float core = exp(-r2 * 16.0);
  float fall = exp(-r2 * 6.0);
  float alpha = (core * 0.9 + fall * 0.35) * vColor.a;
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(vColor.rgb * (0.7 + core * 0.5) * alpha, alpha);
}`;

/**
 * A capacity-bounded batch of glowing sprites, updated on the CPU each frame
 * and drawn in one call. All state is preallocated; push() never allocates.
 * Sizes are in drawing-buffer pixels.
 */
export class PointField {
  constructor(renderer, capacity) {
    const gl = renderer.gl;
    this.renderer = renderer;
    this.gl = gl;
    this.capacity = capacity;
    this.count = 0;
    this.centers = new Float32Array(capacity * 3);
    this.sizes = new Float32Array(capacity);
    this.colors = new Float32Array(capacity * 4);
    this.phases = new Float32Array(capacity);
    // Four corners (±1, ±1) per sprite: 8 floats each.
    const corners = new Float32Array(capacity * 8);
    const indices = new Uint16Array(capacity * 6);
    for (let i = 0; i < capacity; i++) {
      const c = i * 8;
      corners[c] = -1; corners[c + 1] = -1;
      corners[c + 2] = 1; corners[c + 3] = -1;
      corners[c + 4] = 1; corners[c + 5] = 1;
      corners[c + 6] = -1; corners[c + 7] = 1;
      indices[i * 6] = i * 4;
      indices[i * 6 + 1] = i * 4 + 1;
      indices[i * 6 + 2] = i * 4 + 2;
      indices[i * 6 + 3] = i * 4;
      indices[i * 6 + 4] = i * 4 + 2;
      indices[i * 6 + 5] = i * 4 + 3;
    }
    this.mesh = new Mesh(renderer, [
      { name: "aCenter", size: 3, dynamic: true },
      { name: "aCorner", size: 2 },
      { name: "aSize", size: 1, dynamic: true },
      { name: "aColor", size: 4, dynamic: true },
      { name: "aPhase", size: 1 },
    ]);
    this.mesh.set("aCenter", this.centers);
    this.mesh.set("aCorner", corners);
    this.mesh.set("aSize", this.sizes);
    this.mesh.set("aColor", this.colors);
    this.mesh.set("aPhase", this.phases);
    this.mesh.setIndex(indices);
    this.program = renderer.program(BILLBOARD_VERT, BILLBOARD_FRAG);
  }

  begin() {
    this.count = 0;
  }

  push(x, y, z, size, r, g, b, a, phase = 0) {
    if (this.count >= this.capacity) return;
    const i = this.count++;
    this.centers[i * 3] = x;
    this.centers[i * 3 + 1] = y;
    this.centers[i * 3 + 2] = z;
    this.sizes[i] = size;
    this.colors[i * 4] = r;
    this.colors[i * 4 + 1] = g;
    this.colors[i * 4 + 2] = b;
    this.colors[i * 4 + 3] = a;
    this.phases[i] = phase;
  }

  draw(renderer, { flicker = 0, model } = {}) {
    if (this.count === 0) return;
    const gl = this.gl;
    // Stream only the dynamic ranges (corners/phases/indices are static).
    this.mesh.subupdate("aCenter", this.centers.subarray(0, this.count * 3));
    this.mesh.subupdate("aSize", this.sizes.subarray(0, this.count));
    this.mesh.subupdate("aColor", this.colors.subarray(0, this.count * 4));
    // Index range for this frame's sprite count.
    this.mesh.index.count = this.count * 6;
    this.mesh.draw(this.program, {
      mode: gl.TRIANGLES,
      uniforms: {
        uVP: renderer.viewProjection,
        uModel: model || this.identity || (this.identity = mat4.create()),
        uViewport: [renderer.width, renderer.height],
        uTime: renderer.time,
        uFlicker: flicker,
      },
    });
    this.mesh.index.count = this.capacity * 6;
  }

  dispose() {
    this.mesh.dispose();
  }
}

// ----------------------------------------------------------------------
// Renderer
// ----------------------------------------------------------------------

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const options = {
      alpha: true,
      antialias: true,
      depth: true,
      stencil: false,
      powerPreference: "high-performance",
      preserveDrawingBuffer: false,
    };
    this.gl = canvas.getContext("webgl2", options) || canvas.getContext("webgl", options);
    if (!this.gl) throw new Error("WebGL is unavailable in this browser.");
    this.drawCalls = 0;
    this.time = 0;
    this.eye = new Float32Array([0, 0, 3]);
    this.dprScale = Math.min(window.devicePixelRatio || 1, 2);
    this.projection = mat4.create();
    this.view = mat4.create();
    this.viewProjection = mat4.create();
    this.programs = new Map();
    this.width = 0;
    this.height = 0;
    this.resize();
  }

  get version() {
    return this.gl instanceof WebGL2RenderingContext ? 2 : 1;
  }

  program(vertexSource, fragmentSource) {
    const key = vertexSource + " " + fragmentSource;
    let program = this.programs.get(key);
    if (program) return program;
    const gl = this.gl;
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const info = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error("Entity shader compile failed: " + info);
      }
      return shader;
    };
    const vs = compile(gl.VERTEX_SHADER, vertexSource);
    const fs = compile(gl.FRAGMENT_SHADER, fragmentSource);
    program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error("Entity shader link failed: " + info);
    }
    const cache = { program, uniforms: new Map(), attributes: new Map() };
    this.programs.set(key, cache);
    return cache;
  }

  uniform(cache, name) {
    let location = cache.uniforms.get(name);
    if (location === undefined) {
      location = this.gl.getUniformLocation(cache.program, name);
      cache.uniforms.set(name, location);
    }
    return location;
  }

  /** Returns true when the drawing buffer size changed. */
  resize() {
    const gl = this.gl;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    const changed = width !== this.width || height !== this.height;
    if (changed) {
      this.width = width;
      this.height = height;
      this.canvas.width = width;
      this.canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    return changed;
  }

  beginFrame(clearColor) {
    const gl = this.gl;
    this.drawCalls = 0;
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    gl.clearColor(clearColor[0], clearColor[1], clearColor[2], clearColor[3]);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  /**
   * Screen blending for all glow layers: dst += src·(1-dst). Unlike pure
   * addition it can never saturate, so any number of overlapping lines and
   * sprites composes into controlled luminance instead of blowing out to
   * white. Fragments must be premultiplied (rgb already scaled by alpha).
   */
  additive() {
    const gl = this.gl;
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_COLOR, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
  }

  normalBlend() {
    const gl = this.gl;
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(true);
  }

  endFrame() {
    const gl = this.gl;
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  updateCamera(eye, target, fov, aspect) {
    mat4.perspective(this.projection, fov, aspect, 0.05, 60);
    mat4.lookAt(this.view, eye, target, [0, 1, 0]);
    mat4.multiply(this.viewProjection, this.projection, this.view);
  }

  /** Project a world point to CSS pixels; out[3] <= 0 means behind the camera. */
  project(out, x, y, z) {
    mat4.transformPoint(out, this.viewProjection, x, y, z);
    if (out[3] > 0.001) {
      out[0] = (out[0] / out[3] * 0.5 + 0.5) * this.canvas.clientWidth;
      out[1] = (1 - (out[1] / out[3] * 0.5 + 0.5)) * this.canvas.clientHeight;
    }
    return out;
  }
}

// ----------------------------------------------------------------------
// Mesh
// ----------------------------------------------------------------------

/**
 * A mesh of separate per-attribute buffers (the simplest scheme that lets
 * static attributes stay static while positions stream every frame). An
 * optional index buffer lets one vertex pool back several representations
 * (TRIANGLES / LINES / sprite quads).
 */
export class Mesh {
  constructor(renderer, layout) {
    const gl = renderer.gl;
    this.gl = gl;
    this.renderer = renderer;
    this.layout = layout; // [{ name, size, dynamic }] — dynamic hints usage
    this.attributes = new Map(); // name -> { buffer, size, count }
    this.index = null;
    this.count = 0;
    this.mode = gl.TRIANGLES;
  }

  /** Upload Float32Array data for one attribute; grows the vertex count. */
  set(name, data) {
    const gl = this.gl;
    const attr = this.layout.find(a => a.name === name);
    if (!attr) throw new Error("Unknown mesh attribute " + name);
    let entry = this.attributes.get(name);
    if (!entry) {
      entry = { buffer: gl.createBuffer(), size: attr.size, count: 0 };
      this.attributes.set(name, entry);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, entry.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, attr.dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
    entry.count = data.length / attr.size;
    this.count = Math.max(this.count, entry.count);
    return this;
  }

  /** Stream a partial update into an already-allocated attribute. */
  subupdate(name, data) {
    const gl = this.gl;
    const entry = this.attributes.get(name);
    gl.bindBuffer(gl.ARRAY_BUFFER, entry.buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
    return this;
  }

  setIndex(indices) {
    const gl = this.gl;
    if (!this.index) this.index = { buffer: gl.createBuffer(), count: indices.length };
    else this.index.count = indices.length;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.index.buffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    return this;
  }

  /** Bind attributes and draw; `options.count` limits drawArrays ranges. */
  draw(cache, options = {}) {
    const { uniforms = {}, mode, count } = options;
    const gl = this.gl;
    const program = cache.program;
    gl.useProgram(program);
    // Attribute locations are resolved once per (program, layout) pair.
    let bindings = cache.attributes.get(this);
    if (!bindings) {
      bindings = [];
      for (const attr of this.layout) {
        bindings.push({ name: attr.name, location: gl.getAttribLocation(program, attr.name), size: attr.size });
      }
      cache.attributes.set(this, bindings);
    }
    for (const binding of bindings) {
      const entry = this.attributes.get(binding.name);
      if (!entry || binding.location < 0) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, entry.buffer);
      gl.enableVertexAttribArray(binding.location);
      gl.vertexAttribPointer(binding.location, binding.size, gl.FLOAT, false, 0, 0);
    }
    for (const [name, value] of Object.entries(uniforms)) {
      const location = this.renderer.uniform(cache, name);
      if (location === null) continue;
      if (typeof value === "number") gl.uniform1f(location, value);
      else if (value.length === 2) gl.uniform2f(location, value[0], value[1]);
      else if (value.length === 3) gl.uniform3f(location, value[0], value[1], value[2]);
      else if (value.length === 4) gl.uniform4f(location, value[0], value[1], value[2], value[3]);
      else if (value.length === 16) gl.uniformMatrix4fv(location, false, value);
    }
    const drawMode = mode || this.mode;
    if (this.index && (drawMode === gl.TRIANGLES || drawMode === gl.LINES)) {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.index.buffer);
      gl.drawElements(drawMode, this.index.count, gl.UNSIGNED_SHORT, 0);
    } else {
      gl.drawArrays(drawMode, 0, count ?? this.count);
    }
    this.renderer.drawCalls += 1;
  }

  dispose() {
    for (const entry of this.attributes.values()) this.gl.deleteBuffer(entry.buffer);
    if (this.index) this.gl.deleteBuffer(this.index.buffer);
  }
}
