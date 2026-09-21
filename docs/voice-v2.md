# Continuous voice console

Open `http://127.0.0.1:8788/` after starting the gateway. The page connects on
load and requests microphone permission. There is no record button: local PCM
VAD detects speech, keeps a 200 ms lead-in and a 1 second silence tail, and
interrupts playback when you speak. Mute/unmute is the voice control. The
Dashboard plugin uses the same capture and canvas renderer and connects when
its tab mounts. Browser microphone access requires localhost or HTTPS; allow
microphone access. If browser autoplay is blocked, use Unmute to unlock audio.
Permission denial is displayed, never treated as an armed listener.

The canvas renders breathing ambient rings while idle, microphone-driven rings
while listening, accelerating orbit particles while thinking, and playback
spectrum petals while speaking. Playback goes through an AnalyserNode. Geometry
is bounded (four 128-segment rings, 24 particles), pixel density is capped at 2,
and requestAnimationFrame targets 60 fps. Hidden tabs do not draw; reduced motion
uses a static phase and 4 fps level updates. Hardware frame-rate measurements
are not a release guarantee.

The standalone page contains no credentials. For an authenticated direct local
connection, supply your gateway token in `/#token=...`; it is removed from the
address bar immediately and held only in memory. Prefer the Dashboard's existing
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
