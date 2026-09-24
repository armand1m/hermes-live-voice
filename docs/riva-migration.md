# NVIDIA Speech NIM migration for Hermes Live Voice

The `riva` provider replaces Hugging Face speech-to-speech with NVIDIA Speech NIM ASR and TTS. Hermes keeps its existing browser gateway, SGLang brain, and tool execution. The gateway converts browser PCM to 16 kHz for ASR, sends complete transcripts to SGLang Chat Completions, and sends complete answers to Magpie TTS. By default it buffers each complete TTS utterance before sending 22.05 kHz PCM to the browser, avoiding mid-utterance playback underruns at the cost of higher first-audio latency; [sentence streaming](#latency-and-recognition-tuning) keeps that guarantee per sentence while overlapping synthesis with generation.

The linked Riva SDK support matrix targets Jetson Thor. For a DGX Spark/GB10 host, use the supported Speech NIM containers: Parakeet 1.1B CTC English ASR and Magpie Multilingual TTS. See the [Riva SDK matrix](https://docs.nvidia.com/deeplearning/riva/user-guide/docs/support-matrix/support-matrix.html), [ASR NIM matrix](https://docs.nvidia.com/nim/speech/latest/reference/support-matrix/asr.html), and [TTS NIM matrix](https://docs.nvidia.com/nim/speech/latest/reference/support-matrix/tts.html).

## Deployment template

[`examples/riva-speech-nim.compose.yml`](../examples/riva-speech-nim.compose.yml) maps ASR and TTS to loopback ports 19000 and 19001. It does not touch the existing ports 8765, 8788, 30000, or 8642. Set `NGC_API_KEY` in a private environment file outside the repository before pulling. Both containers require GPU capacity; do not launch them on a GPU reserved for SGLang until headroom and latency are measured. The template has not been exercised against a live NIM service.

Set the gateway's private config to:

```env
HERMES_LIVE_PROVIDER=riva
HERMES_LIVE_RIVA_ASR_URL=ws://127.0.0.1:19000/v1/realtime?intent=transcription
HERMES_LIVE_RIVA_TTS_URL=ws://127.0.0.1:19001/v1/realtime?intent=synthesize
HERMES_LIVE_RIVA_BRAIN_URL=http://127.0.0.1:30000/v1/chat/completions
HERMES_LIVE_RIVA_BRAIN_MODEL=qwen3.8-27b
HERMES_LIVE_RIVA_VOICE=Magpie-Multilingual.EN-US.Jason
```

Check the actual SGLang model ID before setting `HERMES_LIVE_RIVA_BRAIN_MODEL`. If Riva runs on a separate host, terminate TLS there and use `wss://` endpoints. The gateway requires TLS for non-loopback Riva endpoints. If the NIM services require mint authentication, set the same private `REALTIME_AUTH_MINT_API_KEY` on the services and `HERMES_LIVE_RIVA_MINT_API_KEY` in the gateway config; do not expose either key to the browser. An optional `HERMES_LIVE_RIVA_BRAIN_API_KEY` protects the SGLang request.

## Latency and recognition tuning

All values are double-quoted in the managed `config.env`, and every key below is allow-listed in managed config.

| Key | Default | Effect |
| --- | --- | --- |
| `HERMES_LIVE_RIVA_ASR_WORD_BOOST` | `Hermes,herdr,exodia,Mac mini` | Comma-separated phrases sent as the ASR session's `word_boosting` list. |
| `HERMES_LIVE_RIVA_ASR_WORD_BOOST_SCORE` | `30` | Boost weight. Riva recommends 20–100 for CTC models (Parakeet 1.1B CTC) and 0.5–2.0 for RNNT/TDT; `0` disables boosting. |
| `HERMES_LIVE_RIVA_BRAIN_STREAMING` | `false` | Streams the brain answer over SSE and synthesizes it sentence by sentence while generation continues. Each sentence is still emitted only after complete synthesis. Chunking never splits code fences, table rows, list markers, or decimals. |
| `HERMES_LIVE_RIVA_BRAIN_PREWARM` | `true` | Sends one 1-token request per session so the system prompt and tools are already in SGLang's prefix cache for the first turn. |
| `HERMES_LIVE_RIVA_BRAIN_THINKING` | `true` | `false` sends `chat_template_kwargs.enable_thinking=false`: no reasoning phase before the answer. Faster, but tool routing may be less careful. |

Measured on exodia (2026-09-24, Qwen3.8 27B on SGLang, prompt ~3.6k tokens):

- A cold prompt costs about 1.5 s of prefill on the first turn of a session; prewarm removes it.
- Thinking adds about 0.4–0.9 s before the first answer token.
- Sentence streaming moved first audio on a four-sentence answer from 6.9 s to 2.9 s, and on a long answer from 12.0 s to 7.8 s.

Every voice and typed turn logs a `turn latency` journal line, and `GET /v1/metrics` reports p50/p95 per stage under `turnLatency`. Voice turns report endpoint, ASR, brain, TTS, response, and total. Typed turns report brain, TTS, and response.

To roll back streaming, remove `HERMES_LIVE_RIVA_BRAIN_STREAMING` from `config.env` (or set it to `"false"`) and restart the gateway.

## Cutover checks

Before cutover, verify both NIM `/v1/health/ready` endpoints, the ASR and TTS WebSocket flows, a Hermes text turn, a spoken turn, a tool call, and barge-in. Keep the old speech-to-speech service available for rollback until those checks pass. Then switch the gateway provider and restart only the gateway in an agreed maintenance window; stop the old speech-to-speech service after the Riva path is stable.

NVIDIA API references: [ASR WebSocket](https://docs.nvidia.com/nim/speech/latest/reference/api-references/asr/realtime-asr.html), [TTS WebSocket](https://docs.nvidia.com/nim/speech/latest/reference/api-references/tts/realtime-tts.html), [deployment](https://docs.nvidia.com/nim/speech/latest/deployment/docker/runtime-parameters.html).
