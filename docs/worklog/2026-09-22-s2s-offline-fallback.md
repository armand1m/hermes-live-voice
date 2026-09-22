# 2026-09-22 — Voice agent now says when the main model is offline

## Incident (root cause)

Between **08:57:22 and 08:58:26 CEST** the voice agent repeated
`I'm having trouble responding right now. Please try again.` on every turn.
The brain LLM (SGLang `qwen3.8-27b`, container `qwen38-tuned`, port 30000) had
just died:

- `docker logs qwen38-tuned`: at 06:57:05 UTC (= 08:57:05 CEST)
  `RuntimeError: The size of tensor a (4) must match the size of tensor b (7)`
  in `sglang/srt/speculative/dflash_worker_v2.py:269 stage_sampling_params`,
  then `SIGQUIT received` → container exited 06:57:11 UTC. This is the known
  flaky dflash speculative-decoding crash (batch-state dependent, not content
  deterministic).
- Not OOM: `docker inspect` reports `OOMKilled=false`, no kernel OOM entries in
  `journalctl -k`.
- `journalctl --user -u hermes-s2s`: 7 × `LLM failure detail:
  APIConnectionError: Connection error.` each followed by
  `ASSISTANT: I'm having trouble responding right now. Please try again.`
- `~/.hermes/logs/errors.log` (agent gateway, session `20260921_180048_3234e5ec`):
  same `APIConnectionError`s 08:59:20–08:59:59, then
  `Provider unavailable (timeout) — auto-recovery cycle 1/5`.
- Container was manually restarted at **09:35:27 CEST** (docker events show
  `container update` + `start` + diagnostic `exec`s). It was down for ~38 min;
  restart policy is now `unless-stopped` (future crashes should self-recover,
  but exit-code-0 SIGQUIT exits may still need watching).

## The message change

**File** (installed pip package, not editable):
`~/.hermes/hermes-live/voice-stack/.venv/lib/python3.12/site-packages/speech_to_speech/LLM/base_openai_compatible_language_model.py`
(pre-patch backup kept next to it as `base_openai_compatible_language_model.py.bak-20260922`)

**Old** (still used for every other provider failure — 4xx/5xx, mid-stream
`httpx.ReadTimeout`, serialization errors):

```
I'm having trouble responding right now. Please try again.
```

**New** (only on `openai.APIConnectionError`, which includes
`APITimeoutError` — i.e. connection refused or request timed out):

```
I can't reach the main model right now. It looks offline. Please try again in a minute.
```

Mechanics: `PROVIDER_OFFLINE_FALLBACK` constant + a per-turn
`fallback_line` selector in `_generate()`; the `except Exception` handler sets
it to the offline line when `isinstance(exc, APIConnectionError)`. The
emission site (`yield LLMResponseChunk(text=fallback_line, ...)`) and all
normal-path behavior are otherwise untouched. The s2s package exposes no
config/env override for this string (checked: `PROVIDER_FAILURE_FALLBACK` has
exactly one definition + one use, no env plumbing), hence the in-place patch.

## Durability

`s2s` is a pip/uv install — a reinstall clobbers the patch. Re-apply with:

```bash
tools/patch-s2s-offline-message.sh            # idempotent; S2S_VENV=... to relocate
```

The script re-applies both local patches in that file (this one and the older
`LLM failure detail:` diagnostics logging), anchors on exact strings, compiles
before replacing, makes a timestamped `.bak-YYYYMMDD-HHMMSS`, and writes via a
new inode (`os.replace`) so it cannot write through the uv hardlink into
`~/.cache/uv`. After patching, restart the service:
`systemctl --user restart hermes-s2s.service`.

## Verification (throwaway instance, 2026-09-22 ~10:02)

Second `speech-to-speech serve` on ws port 4602 (all-CPU flags identical to
`run-s2s.sh`), warmed up against a fake LLM on 127.0.0.1:4601, then the fake
was killed → connection refused, i.e. the exact incident condition. A text
turn (`conversation.item.create` + `response.create`) produced:

- ws event `response.audio_transcript.delta`:
  `I can't reach the main model right now. It looks offline. Please try again in a minute.`
  (audio synthesized; `response.output_audio.done` followed)
- throwaway server log:
  `LLM generation failed; ending the current response (APIConnectionError)` /
  `LLM failure detail: APIConnectionError: Connection error.` /
  `ASSISTANT: I can't reach the main model right now. It looks offline. Please try again in a minute.`
- terminal `error` event `Language model generation failed: Connection error.`
  (`response_failed`) — identical failure semantics to the incident, only the
  spoken line changed.

Receipts kept at `/tmp/s2s-throwaway.log` and `/tmp/fake-llm-4601.log`.

## Open risks / follow-ups

- The dflash tensor-size crash is unfixed upstream; it will take :30000 down
  again (recovery via `docker start qwen38-tuned`, ~2–4 min model load — see
  `/home/armand1m/sglang-tune/launch-dflash2.sh`). Consider the planned second
  sglang on :30001 so voice keeps a dedicated model, and/or a watchdog that
  pings `/v1/models` and restarts the container.
- During an outage the agent still retries per turn; the new line will be
  spoken on each failed turn (acceptable — it is now truthful).
