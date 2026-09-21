# Assistant UI — the synthetic entity

## September 21 polish: blue ICT FaceKit head

The active renderer now uses **ICT FaceKit Light**, replacing the procedural
ellipsoid with an anatomical head and eyes. `entity-facekit.js` renders a blue
surface, scan bands, sparse topology and a depth-tested point cloud. Thirteen
sparse expression targets drive jaw, lips, brows, smiles, concern and blinks
from the existing audio and state pipeline. Transcript keywords provide brief,
heuristic expression cues; they are not an emotion classifier.

- `facekit-data.js`: 14,388 vertices, 28,552 triangles, about 2.11 MB raw.
  Geometry loads asynchronously so microphone startup does not wait for it.
- `scripts/build-facekit.mjs`: reproducible importer pinned to upstream revision
  `da5f95a607f5e6b37755b38d3385d7f2853732e5`; source OBJs cache under `/tmp`.
- `FACEKIT-LICENSE.txt`: full upstream MIT notice and credits. The light model
  is used; no assets from the separately licensed full model are included.
- The interface has contextual presence labels, actual input/output meters,
  clearer captions, blue accents and portrait-aware camera framing.
- Conversation history now updates during streaming and retains final text.
  The old `cloneNode(false)` path copied empty elements. The log supports
  Enter/Space, Escape and touch closing, plus count and empty state.
- Fixed sprite attributes being allocated once per sprite instead of once per
  quad vertex, which caused stretched triangular eyes and missing point clouds.
- VAD owns listening state; task completion clears tool activity; gaze and tilt
  springs support negative values; errors override contextual expressions.
- Regression coverage includes history corrections, keyboard/touch drawer use,
  geometry loading, WebGL errors, sprite buffers and controller lifecycle.

The earlier procedural renderer description below is retained as design history;
`entity-head.js` is no longer the active head implementation. Build and package
checks include the new renderer, geometry module and license in the exact asset
allowlist. Local changes are not automatically deployed to the installed gateway.

Summary of the voice interface redesign (commit `ca07f1a`, September 2026).
The standalone voice page (`clients/browser/`) now renders a procedural 3D
synthetic head whose geometry, motion, lighting, expression and surrounding
interface react continuously to the voice pipeline. Zero new npm dependencies.

Live at `https://exodia.raven-balance.ts.net/voice/` (Tailscale Serve mount →
gateway `dev.hermes-live-voice.gateway.service`).

## Experience

Talking to the page feels like addressing an entity, not operating software:

- **Idle** — a dark glass skull breathes; sparse particles drift; it blinks.
- **Listening** (VAD fires) — gaze locks on you, particles contract, the
  camera closes in; the response is immediate.
- **Utterance ends** — the surface draws inward: the thought was captured.
- **Thinking** — the head *computes*: the topology warms toward amber, a scan
  band travels crown→chin, the surface loosens, inner cortex rings become
  visible, perceive/respond latency appears in the periphery.
- **Tool execution** — a packet of light leaves the face along a bezier toward
  a rotating peripheral node with a DOM-projected label, and returns with the
  result.
- **Speaking** — the mouth tracks the actual outgoing TTS audio (visemes from
  spectral analysis), the jaw skins realistically, cheeks vibrate with energy.
- **Error** — a brief stutter, scatter and coral tint; graceful recovery.

## Architecture

```
voice events → AgentStateController → continuous visual state → animation → WebGL
```

| Module | Role |
| --- | --- |
| `entity-state.js` | `AgentStateController`: voice events → spring-interpolated continuous parameters (attention, energy, confidence, speechActivity, thinkingIntensity, uncertainty, errorIntensity, listening, toolActivity, dispersal, gaze), 10 expression presets blended continuously, watchdogs for dead pipelines. Also `SpeechAnalysis` (rms/low/mid/high/transient from `audio.playbackAnalyser`, attack/release smoothed) and the swappable `VisemeEstimator`. |
| `entity-gl.js` | Dependency-free WebGL layer: mat4 math, shader program cache, per-attribute `Mesh` buffers with optional index buffers, and `PointField` — a camera-facing billboard sprite batch (see lessons below). WebGL2 with WebGL1 fallback (all shaders GLSL ES 1.00). |
| `entity-head.js` | The head: a lat/long sphere sculpted by anatomical influence fields (brow ridge, eye sockets, nose wedge, cheekbones, jaw, chin); the same fields produce per-vertex rig weights. One vertex pool renders as four representations — fresnel glass shell, decimated topology wire, travelling latitude contours, surface sprite cloud. Eyes are lens rings with luminous irises, folding lids, blink scheduler and micro-saccades; brows, nose bridge and a viseme-driven segmented mouth are "feature apertures" evaluated on the CPU each frame. Jaw skinning rotates the jaw-weighted region about the ear axis. |
| `entity-scene.js` | Environment: damped camera rig (framing per state + pointer parallax + slow wander), orbital particle field, inner cortex rings, mechanical gimbal rings, computation pulse pool, tool packets with projected anchor labels, and accent mixing (mint-teal ↔ amber by state; coral for error). |
| `entity-debug.js` | Developer playground, only with `?dev=1` (never auto-enables: e2e runs on localhost). Mode chips, 9 parameter sliders, synthetic viseme driver, pulse trigger, fps/draw-call readout. Toggle with `` ` ``. |
| `voice.js` | Event bridge + the single RAF loop + kinetic transcript. Exposes `window.__entity` (controller/scene/audio/client) in dev mode for inspection. |

DOM overlay (`index.html`, `voice.css`): kinetic transcript (user lines enter
from depth, agent line reveals word-by-word paced by live speech energy,
history recedes via mask + a LOG drawer), mic meter, peripheral task/tool
chips, latency readout, error notice. The whole overlay choreographs itself
from `body[data-mode]` — information recedes when the face should dominate.

## Event mapping

`voice.js` bridges Hermes events to semantic controller calls:
`input.level` → `userLevel`, VAD start/stop → `userSpeechStarted/Ended`,
`response.started` → thinking + impulse pulse, `audio.output` → `ttsFrame`,
`playback` → speaking watchdog, `task.accepted/started/progress/completed/failed`
→ tool packets + expression pulses, `tasks.changed` → background-work state,
`error`/`session.error` → disruption + recovery, `statechange` → connection.
Modes derive automatically; nothing snaps — every value springs.

## Mouth / visemes

No phoneme timing is available from providers, so visemes are inferred from
the outgoing audio's spectral shape (level 3 of the preferred hierarchy, with
amplitude fallback built in): dark+loud → open/A, mid-dominant → wide/E,
low-dominant → round/O, quiet+dark → narrow/U, bright bursts → teeth/F-V,
silence → closed. Fast attack / slower release keeps consonant articulation
without flicker. The estimator is a single class — a future phoneme-timed
source can replace it without touching the renderer.

## Hard constraints honored

- **e2e contract** (`e2e/voice.spec.ts`): exactly one `<button>` (Mute/Unmute),
  `#state[data-state]`, `canvas[data-state]` ∈ idle/listening/thinking/waiting/speaking,
  `[data-speaker]` transcript entries with unchanged accumulation semantics.
- **Serving**: exact file allowlist in `src/adapters/inbound/http/server.ts`
  under strict CSP (`script-src 'self'`, no inline styles/scripts, no CDNs).
  New browser files must be added there **and** to `package.json` `files`.
- **Plugin sync**: `hermes-live-client.js` / `mic-worklet.js` changes require
  `npm run sync:dashboard-assets` (`check:dashboard-assets` enforces byte equality).
- **Subpath mounts** (`/voice` via Tailscale Serve): all module imports are
  relative to `voice.js`'s URL; the WebSocket and worklet use the existing
  `mountPath` logic.

## Engineering lessons (baked into the code)

1. **`gl.POINTS` is unusable** — several WebGL rasterizers (notably
   ANGLE/SwiftShader configurations, i.e. headless CI) render points at the
   implementation's maximum size regardless of `gl_PointSize`. All sprites are
   camera-facing quads (`PointField`) with exact pixel sizes instead.
2. **Glow layers use screen blending** (`blendFuncSeparate(ONE,
   ONE_MINUS_SRC_COLOR, …)` with premultiplied fragments) — `dst += src·(1-dst)`
   mathematically cannot saturate, so any number of overlapping lines, rings
   and sprites composes into controlled luminance instead of white blowout.
   Pure addition was removed after the entire glow pipeline saturated.
3. **`readPixels` outside the frame callback is garbage** with
   `preserveDrawingBuffer: false` — judge visuals from screenshots (e.g. PIL
   luminance metrics), not readbacks.
4. Per-fragment ceilings (`uCap` uniforms) still matter per-pass for dense
   line stacks seen edge-on.

## Performance & accessibility

- One RAF loop; per-frame state stays in preallocated typed arrays (no
  allocation in the hot path); ~10–20 draw calls/frame; DPR capped at 2;
  hidden tabs skip drawing; sprite counts bounded (720 environment particles,
  ~580 surface sprites).
- `prefers-reduced-motion`: camera drift, idle wander, saccades and parallax
  are disabled; state changes remain via opacity/springs.
- WebGL unavailable → CSS fallback composition; the DOM UI remains fully
  functional.

## Verification status

- `npm run typecheck` ✓; vitest 759/760 (the single failure is the local
  HF S2S contract test — environmental: a concurrently running gateway holds
  the one local-provider session slot).
- Playwright e2e 2/2 ✓ (DOM contract preserved).
- `check:docs`, `check:package`, `check:browser-client`,
  `check:dashboard-assets`, `check:dashboard-plugin` ✓.
- Visual states verified per-state via screenshot luminance analysis: thinking
  is measurably warmer (+19 pts R−B) and ~2.4× brighter than baseline;
  production mode shows no dev artifacts, one button, zero console errors.

## Deployment

The gateway runs as the systemd user unit
`dev.hermes-live-voice.gateway.service` from the globally installed package.
To ship UI changes:

```sh
npm run build && npm install -g .
systemctl --user restart dev.hermes-live-voice.gateway.service
```

Visual tuning playground: `https://…/voice/?dev=1` (panel toggles with `` ` ``;
synthetic-speech chip drives the mouth without TTS).
