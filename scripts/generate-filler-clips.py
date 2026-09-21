#!/usr/bin/env python3
"""Generate pre-recorded filler clips for the live-voice filler side-channel.

Uses the same Qwen3-TTS GGML engine, model, and speaker as the deployed
speech-to-speech stack (see ~/.hermes/hermes-live/voice-stack/run-s2s.sh) so
gateway-injected fillers are indistinguishable by voice from provider speech.

Run with the voice-stack venv interpreter so the TTS packages are importable:

    ~/.hermes/hermes-live/voice-stack/.venv/bin/python scripts/generate-filler-clips.py

Output: assets/filler/<name>.pcm (raw PCM16 mono 24 kHz, the rate the
provider's realtime boundary publishes) plus <name>.txt with the spoken text
and a manifest.json listing every clip. Commit the directory like
assets/models/silero_vad.onnx. Re-run with different phrasing any time.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

DEFAULT_MODEL = "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"
DEFAULT_SPEAKER = "Aiden"
DEFAULT_QUANT = "BF16"
OUTPUT_SAMPLE_RATE = 24_000
MAX_NEW_TOKENS = 512

# Placeholder phrasing — regenerate with your own words or languages whenever.
CLIPS: list[tuple[str, str]] = [
    ("still_working", "Still working on it."),
    ("checking", "Let me check with Hermes."),
    ("taking_longer", "This one's taking a bit longer."),
    ("almost_there", "Almost there."),
    ("still_digging", "Hermes is still digging into it."),
    ("answer_ready", "Hermes has your answer whenever you're ready."),
    ("one_moment", "One moment."),
    ("reconnecting", "Give me a second, I'm reconnecting."),
]


def to_int16(audio: np.ndarray) -> np.ndarray:
    return np.clip(audio * 32768, -32768, 32767).astype(np.int16)


def prepare_chunk(item: object) -> tuple[np.ndarray, int] | tuple[None, None]:
    """Mirror the s2s TTS handler's chunk shapes (tuple or .audio object)."""
    if isinstance(item, tuple):
        audio_chunk, sample_rate, _timing = item
        return np.asarray(audio_chunk, dtype=np.float32).squeeze(), int(sample_rate)
    audio = getattr(item, "audio", None)
    if audio is None:
        return None, None
    chunk = np.asarray(audio, dtype=np.float32).squeeze()
    rate = int(getattr(item, "sample_rate", 0) or 24_000)
    return chunk, rate


def trim_leading_silence(audio: np.ndarray, sample_rate: int) -> np.ndarray:
    """Mirror the TTS handler's preroll trim so clips start crisply."""
    threshold = int(32768 * 0.01)
    above = np.abs(audio) > threshold
    if not np.any(above):
        return audio
    start = max(0, int(np.argmax(above)) - int(sample_rate * 0.040))
    return audio[start:]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--speaker", default=DEFAULT_SPEAKER)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--quant", default=DEFAULT_QUANT, choices=("BF16", "Q8_0", "Q4_K_M", "F32"))
    parser.add_argument("--output-dir", default=None, help="default: assets/filler next to this script's repo root")
    parser.add_argument("--language", default="auto")
    args = parser.parse_args()

    output_dir = Path(args.output_dir) if args.output_dir else Path(__file__).resolve().parents[1] / "assets" / "filler"
    output_dir.mkdir(parents=True, exist_ok=True)

    try:
        import torch
        from faster_qwen3_tts import FasterQwen3TTS
    except ImportError as error:
        print(f"Missing TTS dependencies ({error}). Run me with the voice-stack venv python.", file=sys.stderr)
        return 1

    dtype = torch.float32 if args.device == "cpu" else (torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16)
    print(f"Loading {args.model} (backend=ggml quant={args.quant}, device={args.device})...")
    model = FasterQwen3TTS.from_pretrained(
        args.model,
        device=args.device,
        dtype=dtype,
        attn_implementation="eager",
        backend="ggml",
        quant=args.quant,
    )

    manifest = {"sampleRateHz": OUTPUT_SAMPLE_RATE, "format": "pcm16-mono-raw", "speaker": args.speaker, "clips": []}

    for name, text in CLIPS:
        print(f"Synthesizing {name}: {text!r}")
        collected: list[np.ndarray] = []
        sample_rate = OUTPUT_SAMPLE_RATE
        for item in model.generate_custom_voice_streaming(
            text=text,
            speaker=args.speaker,
            language=args.language,
            chunk_size=8,
            max_new_tokens=MAX_NEW_TOKENS,
            non_streaming_mode=True,
        ):
            chunk, rate = prepare_chunk(item)
            if chunk is None or rate is None or chunk.size == 0:
                continue
            sample_rate = rate
            collected.append(chunk)

        if not collected:
            print(f"  no audio produced for {name}; skipping", file=sys.stderr)
            continue

        pcm = to_int16(np.concatenate(collected))
        if sample_rate != OUTPUT_SAMPLE_RATE:
            from scipy.signal import resample_poly

            gcd = np.gcd(OUTPUT_SAMPLE_RATE, sample_rate)
            pcm = to_int16(
                resample_poly(pcm.astype(np.float32) / 32768.0, OUTPUT_SAMPLE_RATE // gcd, sample_rate // gcd),
            )
        pcm = trim_leading_silence(pcm, OUTPUT_SAMPLE_RATE)

        (output_dir / f"{name}.pcm").write_bytes(pcm.tobytes())
        (output_dir / f"{name}.txt").write_text(text, encoding="utf-8")
        duration_ms = int(pcm.size * 1000 / OUTPUT_SAMPLE_RATE)
        manifest["clips"].append({"name": name, "text": text, "durationMs": duration_ms})
        print(f"  wrote {name}.pcm ({duration_ms} ms)")

    (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Done: {len(manifest['clips'])} clips in {output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
