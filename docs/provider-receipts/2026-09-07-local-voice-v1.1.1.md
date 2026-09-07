# Local voice v1.1.1 validation

Date: 2026-09-07. Provider: managed Hugging Face speech-to-speech 0.2.12.
Environment: macOS, Node 24.19.0, source checkout. Live result: **blocked**.

## Reproduced failure and fix

Issue [#79](https://github.com/bielcarpi/hermes-live-voice/issues/79) reports
completed Hermes work with no spoken answer. The gateway used the
`conversation_answer` purpose both for exact speech and for model summaries.
The managed Python patch requires exact-speech metadata for that purpose, so
summaries raised `RuntimeError: Hermes Live exact speech metadata is invalid.`
before generating any output. Markdown, multiline answers, links, answers over
500 characters, empty answers, and failures all selected that summary path.

The regression test passes real gateway-built response payloads to the shipped
Python patch stack with a model-free upstream fixture. It reproduced the exact
exception before the fix. Summary payloads now use `conversation_summary` and
reach the normal model with tools disabled. Exact answers still bypass the model.
The provider version, handshake, audio format, and model settings are unchanged.

## Automated evidence

- `npm run verify`: 749 tests passed, including the gateway-to-Python regression,
  plus CLI, plugin, gateway, build, and clean packed-package installation smokes.
- `npm audit --audit-level=moderate`: zero vulnerabilities.
- Speech cases include short Chinese text, Chinese Markdown with a source link,
  the 500/501-character boundary, long results, empty results, and request errors.
- Fake-clock tests prove saved-chat work can finish after the ordinary request
  deadline, honors explicit and longer existing limits, still cancels, and never
  automatically repeats the chat request on timeout or cancellation.
- Dashboard fixtures cover both auth module locations, credential rejection,
  request-boundary rejection, missing/incomplete modules, and import failures.
  An available but failing current auth module never falls back to legacy auth.
- The real Hermes image smoke checks API capabilities, agent/Dashboard plugin
  discovery, version parity, and callable WebSocket auth helpers. CI runs the
  pinned v0.20.0 image; a separately dispatched compatibility run checks latest.

The released Hermes v0.21.0 tag still contains the helpers in
[`web_server.py`](https://github.com/NousResearch/hermes-agent/blob/v2026.8.31/hermes_cli/web_server.py).
The later source tree moves them to
[`web_server_chat.py`](https://github.com/NousResearch/hermes-agent/blob/a99340c247170ab0082f1248234952ddbc137f7c/hermes_cli/web_server_chat.py).
Version labels alone therefore do not identify the auth module layout.

## Live attempts and limits

`HERMES_LIVE_PROVIDER=local node dist/cli.js provider-smoke --timeout-ms 10000`
failed before opening a provider session. The local speech runtime was not
running, no managed Hermes configuration was installed, and no hosted-provider
credentials were available.

`HERMES_LIVE_PROVIDER=local node dist/cli.js launch-check --json --timeout-ms 10000`
returned `Runtime readiness failed`. This is a blocked live check, not a pass.
No current microphone, speaker, STT accuracy, TTS quality, or real model/tool
round-trip is claimed. Chinese text fixtures do not establish Mandarin STT
support for the managed Parakeet profile.

## Operational boundaries

Accepted background work survives voice/client disconnects. Gateway restart
recovery requires the same live Hermes process; restarting Hermes does not
recover in-progress computation. Ambiguous dispatch remains fenced as
`dispatch_unknown`. Spoken notifications remain out-of-band with OpenAI and
best-effort with Gemini. Interactive approvals are unavailable; the safe
fallback remains deny-all followed by exact stop.

After upgrading, restart Hermes Dashboard to load the plugin, run
`hermes-live launch-check` in the configured environment, and verify both a
short reply and a formatted tool-backed answer through the actual audio device.
