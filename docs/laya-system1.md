# LAYA System-1 shadow pilot (Phase 1)

[LAYA](https://huggingface.co/convaiinnovations/laya) is a 421 M-parameter
System-1 decision model: fast typed classifications with a confidence signal,
no text generation. This phase runs it as a **log-only observer** of the voice
gateway — it classifies every finalized user turn next to what the brain
actually did, so routing agreement and confidence calibration can be measured
on real traffic before any active gating is considered.

**Nothing in this feature changes gateway behavior.** Replies, tool calls,
task admission, speech, and announcements are byte-for-byte today's paths.
LAYA answers are written to a private log file and nothing else. When the
sidecar is down, slow, or misconfigured, every turn is simply logged as
`unknown`.

Why shadow-first: LAYA's own eval shows near-perfect in-task routing
(0.991 / ECE 0.009) but **0.651 overall with ECE 0.204 zero-shot**, and the
model card says the base checkpoint "ships over-confident — refit temperature
on your data first". Our voice-routing questions are zero-shot-like until
proven otherwise on this user's traffic.

## Phase 1b: re-test and new question set (2026-09-26)

The first 145 shadow turns scored at chance against the brain (route agreement 49%, AUC ≈ 0.4–0.5, median confidence 0.10, and 39% of calls timed out). An offline re-test showed the question framing was the cause, not only the model. The test used the same sidecar on 71 turns hand-labeled from the utterance text, and re-ran the original framing without its timeout.

| Framing | Latency per call | Per-intent AUC |
| --- | --- | --- |
| Original: one 4-way `route` choice over a free-text `user: … / recent turns: …` state | ~1.2 s | ≈ 0.5 (chance) |
| One yes/no question per intent, phrased like LAYA's own presets and naming a field, over `{"utterance": …}` | ~0.48 s | 0.84–0.92 |
| The same, with the recent conversation added to the state | ~1 s | worse on every intent |

- **Frustration:** a graded `score` question (0 calm … 3 very frustrated) separated frustrated from positive turns perfectly on 13 labeled turns.
- **Mood:** a one-word `choice` is a weaker, secondary signal. It often reads frustration as "curious".

The live shadow now asks two sidecar calls per turn (the sidecar allows at most four questions each):
- **mood first:** `small_talk`, `frustration`, `mood`
- **then intents:** `new_work`, `task_status`, `recall`, `remember`

The state is `{"utterance": …}`. Rows carry `schema: 2`, and `analyze_shadow.py` reports per-intent AUC against the brain's tool calls for them. Typed turns are classified too.

**Where the mood goes:**
- **Diagnostics overlay:** the latest mood appears as the `mood` row (for example `frustrated · 2.1/3 · 12s`) via `userMood` in `GET /v1/metrics`.
- **Brain hint:** with `HERMES_LIVE_LAYA_MOOD_STEERING="true"`, a frustrated, stressed, or confused previous message adds a one-line hint to the voice brain's next turn. It is never the current turn, because LAYA answers after the brain has already started.

The routing verdict stands: nothing waits on LAYA.

## Pieces

| Piece | What it is |
| --- | --- |
| `tools/laya-sidecar/laya_sidecar.py` | FastAPI service on `127.0.0.1:8767`: `POST /decide {state, questions}` → `{answers, latency_ms}`, `GET /healthz`. CPU-pinned (`CUDA_VISIBLE_DEVICES=` is asserted at boot), `torch.set_num_threads(6)`, one predict at a time. Rejects >4 questions, >2 000-char states, and ≥11-option choice questions with 400 — none of those can be answered both fast and calibrated. |
| `tools/laya-sidecar/hermes-laya.service` | systemd user unit (`MemoryMax=4G`, `Nice=10`, `Restart=on-failure`). |
| `tools/laya-sidecar/install.sh` | Idempotent: venv (`~/.hermes/hermes-live/laya-sidecar/venv`, laya 0.3.5 + fastapi), unit install + enable. **Never touches the gateway.** |
| `tools/laya-sidecar/analyze_shadow.py` | The go/no-go report (below). |
| `src/application/live-gateway/laya-shadow.ts` | Gateway shadow client: budgeted state builder, fire-and-forget `/decide` with timeout, answer cache by utterance hash, JSONL writer with rotation. |
| `~/.hermes/hermes-live/laya-shadow/turns.jsonl` | The shadow log (operator-private like `tasks-v1.json`), one line per turn, rotated at 10 MB. |

## Config keys (all default OFF)

| Key | Default | Meaning |
| --- | --- | --- |
| `HERMES_LIVE_LAYA_URL` | unset | Sidecar base URL. **Unset = feature fully inert** (same kill-switch shape as `HERMES_LIVE_TTS_URL`). Must be a loopback HTTP(S) URL. |
| `HERMES_LIVE_LAYA_SHADOW_ENABLED` | `"true"` | Master switch for logging while piloting. |
| `HERMES_LIVE_LAYA_TIMEOUT_MS` | `1500` | Hard deadline for each of the two per-turn calls; slower answers are logged as `timeout`. |
| `HERMES_LIVE_LAYA_MOOD_STEERING` | unset (off) | Add a one-line hint about a frustrated, stressed, or confused previous message to the voice brain's next turn. |

All of them are registered in `MANAGED_CONFIG_KEYS`
(`src/cli/managed-config.ts`) — unregistered keys crash the gateway at boot,
so they must only ever be set through the managed config / environment.

## Deploy (operator)

```bash
cd ~/Projects/mine/hermes-live-voice
tools/laya-sidecar/install.sh
# then point the gateway at it and restart once:
editor ~/.hermes/hermes-live/config.env   # add: HERMES_LIVE_LAYA_URL="http://127.0.0.1:8767"
systemctl --user restart dev.hermes-live-voice.gateway.service
journalctl --user -u dev.hermes-live-voice.gateway.service -n 30   # boot with the new keys
curl -s http://127.0.0.1:8788/health
```

The sidecar listens only on `127.0.0.1:8767`. First install downloads ~808 MB
of weights to `~/.cache/huggingface`; subsequent starts load in ~18 s
(`/healthz` flips healthy after a warmup predict).

## Kill switches (any one suffices)

```bash
systemctl --user stop hermes-laya.service                # sidecar gone; rows log "unknown"
# or unset HERMES_LIVE_LAYA_URL in ~/.hermes/hermes-live/config.env + restart gateway
# or set HERMES_LIVE_LAYA_SHADOW_ENABLED="false" + restart gateway
```

With no URL configured the gateway never constructs the recorder: the two
hook sites in `src/application/live-gateway/live-gateway-session.ts`
(finalized user transcript → `noteTurn`, tool outcome → `noteOutcome`)
short-circuit on an absent dependency and nothing is written or fetched.

## Reading the shadow log

One JSON line per turn, written when the brain's behavior for the turn is
known (response settled, next turn, or session close):

```json
{"ts": 0, "sessionId": "...", "utteranceHash": "sha256:...", "state": "...",
 "questions": { }, "answers": { "route": { } }, "layaLatencyMs": 512,
 "cached": false, "timeout": false,
 "brain": { "toolCalls": [ { "name": "start_background_task", "executionMode": "exclusive" } ],
            "taskAccepted": true, "turnHadSpeech": true } }
```

- `answers: null` + `timeout: true` → the sidecar exceeded
  `HERMES_LIVE_LAYA_TIMEOUT_MS`; `answers: null` + `timeout: false` → sidecar
  down/error or the answer landed after the row was finalized.
- `cached: true` → a repeated utterance was answered from the in-memory cache
  (no sidecar call).
- The three questions asked per turn (`route` choice, `trivial_chat` noul,
  `read_only` noul) are defined in `LAYA_SHADOW_QUESTIONS`
  (`src/application/live-gateway/laya-shadow.ts`).
- The state is budgeted to ~1 400 chars with the utterance first — LAYA's
  512-token window destroys decisions whose request falls off the end.

## Analyzing

```bash
python3 tools/laya-sidecar/analyze_shadow.py                 # human summary
python3 tools/laya-sidecar/analyze_shadow.py --json report.json
python3 tools/laya-sidecar/analyze_shadow.py --labels labels.json
```

Outputs: route agreement matrix (LAYA choice vs brain route), coverage and
accuracy at confidence thresholds 0.70–0.95, ECE per question before/after a
Platt refit fitted on the logged (confidence, correct) pairs, read-only
precision at P≥0.95, and p50/p95 sidecar latency. `labels.json` (optional,
`{"<utteranceHash>": {"read_only": true}}`) supplies read-only ground truth —
the log alone cannot prove a task was read-only. Note the `trivial_chat`
calibration uses the noisy proxy "brain made no tool calls".

## Go / no-go (decide on ≥200 classified turns, ≥50 in the confident bucket)

- **GO:** route agreement with the brain ≥90 % at confidence ≥0.85, that
  subset covering ≥50 % of turns; read-only precision ≥98 % at P≥0.95 on
  turns that started tasks; ECE ≤0.10 after refit; no measurable TTFT or
  announcement regression in `/v1/metrics` percentiles.
- **NO-GO:** LAYA stays a log-only curiosity (or moves to tone annotation
  only). Do not ship active gating on weaker numbers.

Phase 2 (active, only-downward gating — not built here) would reuse the
cached transcript-time answers at the task-admission point; see the plan in
`~/.hermes/cache/scratch/laya-integration-plan.md`.

## Resource notes

- ~2.8 GB RSS resident, 3.3 GB peak during predict (`MemoryMax=4G`).
- ~0.5 s per question on CPU (measured 522 ms p50 at 6 threads), once per
  finalized user turn, never per audio frame, never on the reply path.
- Six torch threads bound contention with the CPU Parakeet STT + Qwen3-TTS
  stack (~7 % over the 20-thread number; the workload is memory-bandwidth
  bound). The GPU stays with sglang — `device=None` auto-detects CUDA and
  crashes with a Triton cache permission error, so CPU pinning is mandatory.
