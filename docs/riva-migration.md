# NVIDIA Speech NIM migration for Hermes Live Voice

The `riva` provider replaces Hugging Face speech-to-speech with NVIDIA Speech NIM ASR and TTS. Hermes keeps its existing browser gateway, SGLang brain, and tool execution. The gateway converts browser PCM to 16 kHz for ASR, sends complete transcripts to SGLang Chat Completions, and sends complete answers to Magpie TTS. It buffers each complete TTS utterance before sending 22.05 kHz PCM to the browser, avoiding mid-utterance playback underruns at the cost of higher first-audio latency.

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

Before cutover, verify both NIM `/v1/health/ready` endpoints, the ASR and TTS WebSocket flows, a Hermes text turn, a spoken turn, a tool call, and barge-in. Keep the old speech-to-speech service available for rollback until those checks pass. Then switch the gateway provider and restart only the gateway in an agreed maintenance window; stop the old speech-to-speech service after the Riva path is stable.

NVIDIA API references: [ASR WebSocket](https://docs.nvidia.com/nim/speech/latest/reference/api-references/asr/realtime-asr.html), [TTS WebSocket](https://docs.nvidia.com/nim/speech/latest/reference/api-references/tts/realtime-tts.html), [deployment](https://docs.nvidia.com/nim/speech/latest/deployment/docker/runtime-parameters.html).
