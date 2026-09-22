#!/usr/bin/env python3
"""Hermes Live Voice LAYA System-1 sidecar (docs/laya-system1.md).

Serves the convaiinnovations/laya checkpoint (laya 0.3.5) over plain HTTP so
the voice gateway can classify turns without a Python runtime in-process.
Shadow-mode Phase 1: answers are logged by the gateway and never gate
behavior.

Endpoints (127.0.0.1:8767 by default):
  GET  /healthz -> {"ok": true, "model": ..., "device": "cpu", "threads": N,
                    "warm": true}   (only after the warmup predict)
  POST /decide  {"state": str, "questions": {name: spec}} ->
                 {"answers": {name: {...}}, "latency_ms": float}

Measured on this host (exodia, GB10 CPU): ~0.5 s per question, batching gives
no CPU win (10 questions ≈ 4.4 s), so the gateway asks at most 3 and this
service hard-rejects batches that could build a multi-second predict:
  - more than 4 questions                  -> 400
  - state longer than 2 000 chars          -> 400
  - a choice question with >= 11 criteria  -> 400 (the checkpoint ships
    temperatures outside [0.5, 5] for that bucket and clamps them; confidence
    from affected buckets is uncalibrated — the load-time RuntimeWarning about
    "clamping choice:11+" refers to exactly this)

CPU pinning is mandatory: device=None auto-detects CUDA and crashes with a
Triton cache PermissionError on this host (the GPU belongs to sglang), so
CUDA_VISIBLE_DEVICES is forced empty and torch threads are capped at 6
(measured 522 ms p50 vs 487 ms at 20 threads — memory-bandwidth-bound, and 6
threads bounds contention with the CPU Parakeet STT + Qwen3-TTS stack).

Run with the laya venv interpreter (install.sh creates it):

  ~/.hermes/hermes-live/laya-sidecar/venv/bin/python laya_sidecar.py
"""

from __future__ import annotations

import logging
import os
import threading
import time

# Must be set before torch/transformers import. USE_TF=0 avoids the TF abseil
# import deadlock the model card warns about; empty CUDA_VISIBLE_DEVICES pins
# CPU (the double-assignment below also guards a service-level env override).
os.environ["USE_TF"] = "0"
os.environ["CUDA_VISIBLE_DEVICES"] = ""

from fastapi import FastAPI, HTTPException  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402
import uvicorn  # noqa: E402

MODEL_ID = "convaiinnovations/laya"
DEFAULT_PORT = 8767
DEFAULT_THREADS = 6
MAX_QUESTIONS = 4
MAX_STATE_CHARS = 2_000
MAX_CHOICE_OPTIONS = 10  # >=11 hits the clamped-temperature bucket
WARMUP_ROUNDS = 3

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("laya-sidecar")

# Refuse to boot mis-pinned (a service env with CUDA visible would crash on
# the first predict with the Triton permission error, not at load).
assert os.environ.get("CUDA_VISIBLE_DEVICES", "") == "", "laya sidecar must run with CUDA_VISIBLE_DEVICES=\"\""


class DecideRequest(BaseModel):
    # Length/count guards run in the handler so callers get a 400 with the
    # policy reason, not a pydantic 422.
    state: str = Field(min_length=1)
    questions: dict[str, dict]


class DecideResponse(BaseModel):
    answers: dict[str, object]
    latency_ms: float


class Sidecar:
    def __init__(self, threads: int) -> None:
        # One predict at a time: concurrent 6-thread predicts would contend
        # for the same cores and stretch every caller's latency.
        self.predict_lock = threading.Lock()
        import torch

        torch.set_num_threads(threads)
        if torch.cuda.is_available():  # pragma: no cover - pinned off above
            raise RuntimeError("laya sidecar started with CUDA visible; refusing to use the GPU")
        import laya

        started = time.perf_counter()
        self.agent = laya.load(MODEL_ID, device="cpu")
        self.threads = threads
        logger.info(
            "laya loaded model=%s device=cpu threads=%d load_s=%.1f",
            MODEL_ID, threads, time.perf_counter() - started,
        )

    def warmup(self) -> None:
        state = "user: hello"
        question = {"ping": {"type": "noul", "instructions": "Is this a greeting?"}}
        started = time.perf_counter()
        for _ in range(WARMUP_ROUNDS):
            self.agent.predict(state, question)
        logger.info("warmup predict done in %.1fs", time.perf_counter() - started)

    def validate(self, questions: dict[str, dict]) -> None:
        if not (1 <= len(questions) <= MAX_QUESTIONS):
            raise HTTPException(
                status_code=400,
                detail=f"send 1-{MAX_QUESTIONS} questions (CPU latency is ~0.5s per question; batching does not help)",
            )
        for name, spec in questions.items():
            kind = spec.get("type")
            if kind == "choice":
                criteria = spec.get("criteria")
                if not isinstance(criteria, dict) or len(criteria) < 2:
                    raise HTTPException(status_code=400, detail=f"question {name!r}: choice requires a criteria dict")
                if len(criteria) > MAX_CHOICE_OPTIONS:
                    raise HTTPException(
                        status_code=400,
                        detail=(f"question {name!r}: {len(criteria)} options exceeds {MAX_CHOICE_OPTIONS}; "
                                "the >=11-option bucket ships clamped temperatures (uncalibrated confidence)"),
                    )


app = FastAPI(title="hermes-laya", docs_url=None, redoc_url=None)
sidecar: Sidecar | None = None


@app.get("/healthz")
def healthz() -> dict[str, object]:
    if sidecar is None:
        raise HTTPException(status_code=503, detail="model not loaded")
    return {"ok": True, "model": MODEL_ID, "device": "cpu", "threads": sidecar.threads, "warm": True}


@app.post("/decide", response_model=DecideResponse)
def decide(request: DecideRequest) -> DecideResponse:
    if sidecar is None:
        raise HTTPException(status_code=503, detail="model not loaded")
    if len(request.state) > MAX_STATE_CHARS:
        raise HTTPException(
            status_code=400,
            detail=f"state exceeds {MAX_STATE_CHARS} chars (the gateway state builder budgets ~1400; "
                   "long states truncate LAYA's 512-token window and destroy the decision)",
        )
    sidecar.validate(request.questions)
    started = time.perf_counter()
    with sidecar.predict_lock:
        result = sidecar.agent.predict(request.state, request.questions)
    answers = result.get("answers", {}) if isinstance(result, dict) else {}
    return DecideResponse(answers=answers, latency_ms=(time.perf_counter() - started) * 1_000.0)


def main() -> None:
    global sidecar
    host = os.environ.get("LAYA_HOST", "127.0.0.1")
    port = int(os.environ.get("LAYA_PORT", str(DEFAULT_PORT)))
    threads = int(os.environ.get("LAYA_TORCH_THREADS", str(DEFAULT_THREADS)))
    sidecar = Sidecar(threads)
    sidecar.warmup()
    uvicorn.run(app, host=host, port=port, log_level="info", access_log=False)


if __name__ == "__main__":
    main()
