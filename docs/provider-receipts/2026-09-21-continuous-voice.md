# Continuous voice repair validation — 2026-09-21

Environment: Linux, Node 24, local speech-to-speech at `127.0.0.1:8765`,
Hermes Agent v0.21.2 at `127.0.0.1:8642`. No cloud voice credentials used.

## Reproduction and diagnosis

- The running gateway returned 404 at `/`; `/health`, `/ready` and `/v1/live`
  existed. The standalone UI had been intentionally removed in v1.1.0.
- `/ready` reported `sessionChecked: false`; it did not prove provider connection.
  An immediate connection after closing a local session failed because the
  upstream single pipeline had not yet released. Logs confirmed “all 1 pipeline
  slots in use.” The adapter retried this only for managed turn routing, which
  the host's stock `run-s2s.sh` does not enable. A subsequent connection succeeded.
- Streaming synthetic speech through the already-running gateway produced
  “Hello, please say hello back.” and PCM output. The underlying local audio
  engine was functional; the missing browser entry point and fragile connection
  path were reproduced. OpenAI's config default separately required manual commits.

## Results

- Restored root page automatically connected and armed a headless Chromium
  microphone without clicks. A synthetic spoken WAV passed through a temporary
  gateway to the real local provider and rendered both user and assistant
  transcripts. Reply observed: “Hello! Good to hear you. What can I help you with?”
  Browser screenshots were inspected. This was a fake microphone device, not a
  physical microphone or a human listening test.
- The automated local provider contract verified session configuration, input
  VAD boundaries, actual speech recognition, PCM output and response completion.
- The automated gateway reach contract used an ephemeral gateway and deterministic
  speech WS fixture with the real HermesClient against the running API on 8642.
  It created a uniquely titled test conversation, submitted the recognized greeting
  via Sessions Chat, and verified a successful answer's spoken-response envelope
  and client PCM output. No in-process Hermes stub was used in that live case.
- Deterministic CI HTTP and speech fixtures cover the same gateway path when the
  host services are absent. Chromium automation additionally verifies transcript
  DOM updates, mute/unmute and reduced-motion rendering. PCM unit tests cover
  debounce, pauses, rearming, barge-in, and exactly-once manual commits versus
  provider-owned turns. Packed-install checks load browser assets from another cwd.
- `npm run verify` passed: 758 Vitest tests and two Playwright cases, plus the
  build, CLI and installed-package smoke gates. The broader verification includes
  existing provider, protocol, dashboard plugin,
  task, CLI and package checks. See [commands and test files](../voice-v2.md#automated-checks).

## Boundaries

No running user service, config, model stack or global package was modified or
restarted. Only contract calls reached existing services; newly created gateways,
browser processes, sockets and private task stores were cleaned up. Test-created
Hermes conversations remain as audit records. The installed gateway still needs
an operator-controlled upgrade/restart to serve this branch's new page.

OpenAI cloud voice was verified against the existing deterministic adapter tests,
not a live paid account. NVIDIA's catalog was checked; its VoiceChat demo offers
early access without a public wire contract established by the inspected page,
and this checkout has no NVIDIA adapter to extend. No NVIDIA support is claimed.
The renderer uses bounded geometry and requestAnimationFrame; laptop hardware
60 fps performance and physical microphone echo/barge-in remain manual checks.
