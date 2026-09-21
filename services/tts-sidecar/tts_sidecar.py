#!/usr/bin/env python3
"""Gateway TTS sidecar: the same Qwen3-TTS GGML engine and speaker as the
speech-to-speech stack (see ~/.hermes/hermes-live/voice-stack/run-s2s.sh),
served over plain HTTP so the gateway can synthesize speech without a
provider-LLM round-trip and keep speaking when the provider pipeline is
stalled or dead.

Endpoints (127.0.0.1:8766 by default):
  GET  /health -> {"ok": true, "speaker": ...}
  POST /v1/tts {"text": "..."} -> chunked raw PCM16 mono 24 kHz stream

Run with the voice-stack venv interpreter so the TTS packages resolve:

  ~/.hermes/hermes-live/voice-stack/.venv/bin/python services/tts-sidecar/tts_sidecar.py
"""

from __future__ import annotations

import argparse
import logging
import re
from typing import Iterator

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import uvicorn

DEFAULT_MODEL = "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"
DEFAULT_SPEAKER = "Aiden"
DEFAULT_QUANT = "BF16"
OUTPUT_SAMPLE_RATE = 24_000
MAX_NEW_TOKENS = 512
CHUNK_SIZE = 8
MAX_TEXT_CHARS = 2_000
# Sentence buffering keeps long text from truncating at the token cap and
# mirrors the s2s handler's estimate-then-synthesize cadence.
SENTENCE_PATTERN = re.compile(r"[^.!?]*[.!?]+(?:\s|$)")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("tts-sidecar")


def to_int16(audio: np.ndarray) -> np.ndarray:
    return np.clip(audio * 32768, -32768, 32767).astype(np.int16)


def prepare_chunk(item: object) -> tuple[np.ndarray | None, int | None]:
    """Mirror the s2s TTS handler's chunk shapes (tuple or .audio object)."""
    if isinstance(item, tuple):
        chunk, rate, _timing = item
        return np.asarray(chunk, dtype=np.float32).squeeze(), int(rate)
    audio = getattr(item, "audio", None)
    if audio is None:
        return None, None
    return np.asarray(audio, dtype=np.float32).squeeze(), int(getattr(item, "sample_rate", 0) or OUTPUT_SAMPLE_RATE)


class Sidecar:
    def __init__(self, model_name: str, speaker: str, device: str, quant: str, language: str) -> None:
        from faster_qwen3_tts import FasterQwen3TTS
        import torch

        dtype = torch.float32 if device == "cpu" else (torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16)
        logger.info("loading %s (backend=ggml quant=%s device=%s)", model_name, quant, device)
        self.model = FasterQwen3TTS.from_pretrained(
            model_name,
            device=device,
            dtype=dtype,
            attn_implementation="eager",
            backend="ggml",
            quant=quant,
        )
        self.speaker = speaker
        self.language = language

    def synthesize(self, text: str) -> bytes:
        """Full PCM16 payload for one utterance (CPU-bound; threadpool call)."""
        collected: list[np.ndarray] = []
        for item in self.model.generate_custom_voice_streaming(
            text=text,
            speaker=self.speaker,
            language=self.language,
            chunk_size=CHUNK_SIZE,
            max_new_tokens=MAX_NEW_TOKENS,
            non_streaming_mode=True,
        ):
            chunk, _rate = prepare_chunk(item)
            if chunk is not None and chunk.size > 0:
                collected.append(chunk)
        if not collected:
            return b""
        return to_int16(np.concatenate(collected)).tobytes()


def split_sentences(text: str) -> list[str]:
    sentences = [match.group(0).strip() for match in SENTENCE_PATTERN.finditer(text)]
    remainder = SENTENCE_PATTERN.sub("", text).strip()
    if remainder:
        sentences.append(remainder)
    return [sentence for sentence in sentences if sentence]


class TtsRequest(BaseModel):
    text: str


def build_app(sidecar: Sidecar) -> FastAPI:
    app = FastAPI(title="hermes-live-voice tts sidecar")

    @app.get("/health")
    async def health() -> dict:
        return {"ok": True, "speaker": sidecar.speaker, "sampleRateHz": OUTPUT_SAMPLE_RATE}

    @app.post("/v1/tts")
    def tts(request: TtsRequest):
        text = request.text.strip()[:MAX_TEXT_CHARS]
        if not text:
            raise HTTPException(status_code=400, detail="text is required")

        def stream() -> Iterator[bytes]:
            # Synthesis is CPU/GPU-bound; FastAPI runs sync generators in the
            # threadpool, so health probes stay responsive.
            for sentence in split_sentences(text):
                yield sidecar.synthesize(sentence)

        return StreamingResponse(
            stream(),
            media_type="audio/pcm",
            headers={"X-Sample-Rate": str(OUTPUT_SAMPLE_RATE)},
        )

    return app


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--speaker", default=DEFAULT_SPEAKER)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--quant", default=DEFAULT_QUANT, choices=("BF16", "Q8_0", "Q4_K_M", "F32"))
    parser.add_argument("--language", default="auto")
    args = parser.parse_args()

    sidecar = Sidecar(args.model, args.speaker, args.device, args.quant, args.language)
    logger.info("warmup synthesis")
    sidecar.synthesize("Warmup.")
    logger.info("sidecar ready on %s:%d", args.host, args.port)

    app = build_app(sidecar)
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
