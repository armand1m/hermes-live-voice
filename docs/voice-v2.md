# Continuous voice console

Open `http://127.0.0.1:8788/` after starting the gateway. The page connects on
load and requests microphone permission. There is no record button: the
gateway's speech detection (below) confirms human speech, keeps a short
lead-in and silence tail, and interrupts playback only for real speech.
Mute/unmute is the voice control. The
Dashboard plugin uses the same capture and canvas renderer and connects when
its tab mounts. Browser microphone access requires localhost or HTTPS; allow
microphone access. If browser autoplay is blocked, use Unmute to unlock audio.
Permission denial is displayed, never treated as an armed listener.

## Speech detection (Silero VAD, protocol v7)

Barge-in used to trigger on raw mic energy, so any noise — typing, a door, a
cough — stopped the agent mid-sentence. The gateway now runs the bundled
[Silero VAD](https://github.com/snakers4/silero-vad) speech-probability model
(v5.1.2, MIT, sha256
`2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f`, served
from `assets/models/silero_vad.onnx`) on every incoming microphone frame:

- The browser client keeps only a **permissive energy pre-gate** that decides
  when to stream audio to the gateway (bandwidth), with its 200 ms preroll.
  It never interrupts on its own in this mode.
- The gateway **confirms speech** from the model's probability with hysteresis
  (default: probability ≥ 0.5 sustained 100 ms to start, ≤ 0.25 sustained
  500 ms to stop) and forwards audio to the realtime provider only for
  confirmed speech plus a 250 ms preroll and 400 ms tail — so provider-side
  VAD never sees ungated noise either.
- On confirmation the client receives `input.speech_started
  {provider: "gateway"}` and cuts playback; the response is cancelled exactly
  once per utterance.
- **Echo guard**: while the agent itself is talking (or within 300 ms after),
  confirmation requires probability ≥ 0.7 sustained 200 ms, so the agent's own
  voice leaking through browser echo cancellation cannot stop it.

Confirmed interruption lands roughly 150–250 ms after speech onset — the
model's confirmation window — well inside natural barge-in feel.

## Memory and continuity (protocol v8)

The voice agent used to start every browser tab with a blank slate. It now
carries knowledge across sessions through three gateway-side mechanisms, all
in `HERMES_LIVE_CONTEXT_*` settings:

- **Context digest**: at every `session.start` the gateway reads Hermes'
  file-backed memory (`USER.md`, `MEMORY.md` from `HERMES_LIVE_HERMES_HOME`,
  default `~/.hermes`), the most recent conversation titles/previews, and the
  skills catalog (`GET /v1/skills`, gated on the `skills_api` capability), and
  appends a bounded block (~2.3k chars full / ~1.2k compact) to the provider
  system instruction. It is framed `[HERMES_LIVE_CONTEXT_V1]` and described to
  the model as cached reference data it must never obey. Sources are
  best-effort with a 2 s deadline; a missing file or old Hermes only shrinks
  the digest. Set `HERMES_LIVE_CONTEXT_DIGEST=false` to disable.
- **Durable voice thread**: the browser now sends
  `conversation.mode: "persistent"` (protocol v8). The gateway resolves the
  most recent Hermes session whose title exactly matches
  `HERMES_LIVE_VOICE_THREAD_TITLE` (default `Hermes Live Voice`) and resumes
  it — or creates it on first use — so every tab, browser restart, and device
  continues one conversation. Reconnects re-resolve the writable tip.
  Archiving the thread simply starts a fresh one. Installs whose Hermes lacks
  session continuity degrade to unbound instead of failing.
- **Recall and remember tools**: `search_past_chats(query)` opens a Hermes
  turn on a dedicated recall session (title
  `HERMES_LIVE_RECALL_SESSION_TITLE`) with instructions that force the
  `session_search` tool and speech-safe answers; expect roughly 10–40 s on
  local models, bounded by `HERMES_LIVE_RECALL_TIMEOUT_MS` (soft error on
  timeout — the session survives). `remember(fact)` submits a durable Hermes
  background run through Hermes' own memory tool, so writes respect its
  approval staging; the spoken receipt says the fact was *sent to Hermes*,
  never that it is already saved. Local-model regex routing (EN/ES/CA) maps
  "do you remember…", "check our previous chats", "remember that…" style
  utterances to these tools, taking precedence over delegation keywords.

`onnxruntime-node` is an **optional** dependency. When it or the model file is
missing (odd platforms, `--no-optional` installs), the gateway logs a warning
and falls back to a dependency-free energy detector with identical session
semantics. `HERMES_LIVE_VAD=disabled` disables gateway detection entirely and
restores the previous client-side VAD behavior, including for older protocol
v6 clients (which are always served the legacy path). Every threshold is
tunable; see the `HERMES_LIVE_VAD_*` settings in `.env.example` and
[setup](setup.md).

The canvas renders a procedural synthetic head: a sculpted lat/long skull shown
simultaneously as a fresnel glass shell, decimated topology wire, travelling
latitude contours, and a surface point cloud, with luminous iris apertures,
folding lids, brow arcs and a viseme-driven segmented mouth. Voice events map to
continuous visual parameters (attention, energy, thinking intensity,
uncertainty, speech activity) through a spring-interpolated state controller, so
the entity is visibly dormant while idle, attentive while listening, warm and
scan-lined while thinking, outward-facing while tools run, and lip-synced to the
actual outgoing audio while speaking (an AnalyserNode feeds smoothed
rms/low/mid/high values into a viseme estimator). Glow layers use screen
blending so overlapping lines cannot saturate. Pixel density is capped at 2 and
requestAnimationFrame targets 60 fps. Hidden tabs do not draw; reduced motion
freezes camera drift and idle wander. Hardware frame-rate measurements are not a
release guarantee. A visual-state playground (mode chips, parameter sliders, a
synthetic viseme driver) is available only with `?dev=1`.

The standalone page contains no credentials. For an authenticated direct
connection, supply your gateway token in `/#token=...` once; it is removed from
the address bar immediately and held in tab-scoped `sessionStorage` until that
tab closes. Prefer the Dashboard's existing
same-origin authenticated relay for shared installations. Never put the Hermes
or cloud provider API key in the browser. Existing API routes and plugin protocol
remain unchanged. Static assets use an exact allowlist and work independently of
process working directory, including installed npm packages.

## Explicit provider selection

Edit `~/.hermes/hermes-live/config.env` (or `HERMES_LIVE_CONFIG_FILE`). Process
environment overrides this file. A cloud key alone never silently switches provider.

```dotenv
HERMES_BASE_URL=http://127.0.0.1:8642
HERMES_AGENT_API_SERVER_KEY=<your existing Hermes bridge key>
HERMES_LIVE_PROVIDER=local
HERMES_LIVE_LOCAL_URL=ws://127.0.0.1:8765/v1/realtime
HERMES_LIVE_LOCAL_VOICE=Aiden
```

Local is now the config default, requires no cloud key, and preserves the
existing speech-to-speech protocol. `HERMES_LIVE_LOCAL_OWNS_TURN_ROUTING=true`
is for the managed patched speech runtime; leave it unset for the stock
`run-s2s.sh` stack, where the realtime model calls Hermes tools. Local pipeline
busy errors now retry for stock as well as managed servers, within the connect
deadline, so a reconnect can wait for the old pipeline to release.

For OpenAI speech-to-speech over the existing server-side WebSocket adapter:

```dotenv
HERMES_LIVE_PROVIDER=openai
OPENAI_API_KEY=<server-side key>
OPENAI_REALTIME_MODEL=gpt-realtime-2
OPENAI_REALTIME_VOICE=marin
OPENAI_REALTIME_TURN_DETECTION=server_vad
OPENAI_REALTIME_INPUT_TRANSCRIPTION_MODEL=gpt-4o-mini-transcribe
```

The default is now server VAD, with automatic response creation and interruption.
`semantic_vad` remains supported; `disabled` remains compatible for existing
SDK consumers, and the browser's local VAD automatically ends those turns.
See [OpenAI VAD documentation](https://developers.openai.com/api/docs/guides/realtime-vad).
Gemini and text-only mock remain available as explicit providers.

NVIDIA's [Nemotron VoiceChat catalog](https://build.nvidia.com/nvidia/nemotron-voicechat/experience)
currently presents an interactive full-duplex demo and early-access application,
not a documented public Realtime wire contract. This checkout contains no NVIDIA
adapter. No guessed NVIDIA endpoint or unsupported provider flag was added;
OpenAI is the supported cloud speech-to-speech option. Cloud account access and
latency have not been verified without credentials.

## Automated checks

```sh
npm ci
npx playwright install --with-deps chromium
npm run verify
# Individual gates:
npm test -- test/continuous-listener.test.ts test/voice-gateway-reach.test.ts test/local-s2s-live.test.ts
npm run test:e2e
```

- `test/continuous-listener.test.ts`: synthesized PCM attack debounce, silence
  hysteresis, turn boundaries, and rearming.
- `test/local-s2s-live.test.ts`: real local WS session, streamed speech fixture,
  provider VAD, recognized transcript, response completion and PCM output.
  Loud skip only when its TCP endpoint is down; protocol/audio failures fail.
- `test/voice-gateway-reach.test.ts`: ephemeral companion gateway, real local
  provider adapter against a deterministic speech WS fixture, actual HermesClient
  HTTP session/chat calls, transcript and PCM round trip. One CI case uses an HTTP
  fixture; another reaches `HERMES_BASE_URL` (default 8642), loading existing managed
  credentials, and calls the real agent with a greeting in a new test conversation.
  It loudly skips when Hermes is down or credentials are absent. Successful live
  calls leave a uniquely titled `Voice contract …` conversation as the audit record.
- `e2e/voice.spec.ts`: real headless Chromium, fake getUserMedia WAV device, page
  load with no click, armed listener, PCM through the gateway and HTTP Hermes
  fixture, transcript DOM, mute/unmute and reduced-motion rendering.
- `test/huggingface-realtime.test.ts`: stock/managed pipeline-busy reconnect
  regression. Existing OpenAI, Gemini, browser, plugin and task tests remain.

`test/fixtures/hello.wav` is synthetic speech, generated locally with FFmpeg's
Flite `slt` voice saying “Hello. Please say hello back.” at mono PCM16/24 kHz,
with 500 ms leading and 2 seconds trailing silence; no user recording is included.
No cloud keys are needed for CI. Tests allocate private task stores and ephemeral
ports and close their own transports. They never restart or stop host services.
Do not run multiple live S2S gates concurrently against a single-pipeline server.

## Non-blocking conversation architecture (2026-09-22)

Tool calls no longer stall the voice loop. The changes, each independently
kill-switchable:

1. **Speech-timing diagnostics** — `GET /v1/metrics` and the overlay now show
   tool-call → first-speech latency (`tool` row) and task completion → spoken
   announcement delay (`ann` row), so every change below is measurable.
2. **Filler side-channel** — pre-recorded clips in the same Aiden voice
   (`assets/filler/*.pcm`, generated by `scripts/generate-filler-clips.py` with
   the voice-stack venv) are streamed to the client as ordinary
   `audio.output` frames during slow tool waits (~2.5s delay, ~15s interval,
   max 3 per wait). Barge-in, provider speech, and receipt delivery silence a
   clip instantly. Held audio now runs through the speech gate for detection,
   so the gateway hears the user during tool waits for the first time.
   `HERMES_LIVE_FILLER_ENABLED=0` disables; `HERMES_LIVE_FILLER_DIR` overrides
   the clip directory.
3. **Async chat/recall tools** — `continue_hermes_conversation` and
   `search_past_chats` return an instant spoken receipt (`deferred: true`,
   `pending_id`); the real answer streams from Hermes' `/chat/stream` SSE and
   is spoken when the conversation is idle. Undelivered for 20s → an
   "answer ready" filler clip; `HERMES_LIVE_ASYNC_TOOLS_ENABLED=0` restores
   blocking behavior.
4. **Reliability** — client↔gateway WebSocket keepalive with a zombie reaper
   (two missed pongs terminates the half-open socket that used to 503-brick
   the single provider slot; `HERMES_LIVE_WS_KEEPALIVE_MS=0` disables), the
   same keepalive on the gateway↔s2s socket, and a hard announcement deadline
   (`HERMES_LIVE_ANNOUNCE_MAX_DELAY_MS`, default 90s) that forces pending
   speech into the next inter-turn gap even when the strict idle gate is
   wedged.
5. **TTS sidecar** — `services/tts-sidecar/tts_sidecar.py` (FastAPI + the same
   Qwen3-TTS GGML engine/speaker, run with the voice-stack venv, unit file
   `services/tts-sidecar/hermes-live-tts.service` on 127.0.0.1:8766). With
   `HERMES_LIVE_TTS_URL` set, receipts and deferred answers (including
   sentence-by-sentence streaming as deltas arrive) are synthesized by the
   sidecar: zero provider-LLM round-trips, no `busy()` serialization, and
   speech keeps working when the provider pipeline is stalled. Failure falls
   back silently to the provider exact-speech path. Unset the URL to disable.

### LLM latency isolation (recommended follow-up)

The voice loop's LLM and the Hermes agent share one sglang server, and heavy
agent turns queue voice completions behind them (measured p50 16.5s / p90 96s
on the shared server). To isolate: run a second, small-model sglang instance
(e.g. a Qwen 4B/8B class model) on `:30001` — the GB10 has roughly half its
128 GB unified memory free beside the 27B — then point the voice stack at it
in `~/.hermes/hermes-live/voice-stack/run-s2s.sh`:

```
--responses_api_base_url http://127.0.0.1:30001/v1 --model_name <small-model>
```

Restart `hermes-s2s.service`, confirm the 27B stays healthy, and compare the
`tool`/`lat` overlay rows before/after. Roll back by restoring `:30000`.

### Ops notes

- Filler clips are regenerated with:
  `~/.hermes/hermes-live/voice-stack/.venv/bin/python scripts/generate-filler-clips.py`
  (edit the phrase list in the script first; commit `assets/filler/`).
- The sidecar unit installs with
  `cp services/tts-sidecar/hermes-live-tts.service ~/.config/systemd/user/ && systemctl --user enable --now hermes-live-tts`.
- The gateway `config.env` accepts the new keys (`HERMES_LIVE_TTS_URL`,
  `HERMES_LIVE_ASYNC_TOOLS_ENABLED`, `HERMES_LIVE_FILLER_*`,
  `HERMES_LIVE_WS_KEEPALIVE_MS`, `HERMES_LIVE_ANNOUNCE_MAX_DELAY_MS`);
  values must stay double-quoted.
