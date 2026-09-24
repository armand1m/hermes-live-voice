# Tuning end-of-turn detection

The gateway's speech gate decides when you have finished speaking. Each turn waits for `HERMES_LIVE_VAD_STOP_SUSTAIN_MS` (default 500) of silence and then drains `HERMES_LIVE_VAD_TAIL_MS` (default 400) before the transcript is committed.

- Too long, and every answer starts later.
- Too short, and a mid-thought pause splits one request into two.

Tune these values from your own recorded speech, not by guesswork.

## The cycle

1. **Record.** Set `HERMES_LIVE_VAD_RECORDING="true"` and restart the gateway.
   - Each voice session is written to `vad-recordings/` next to the task state (for example `~/.hermes/hermes-live/vad-recordings/`). Directories are `0700` and files are `0600`.
   - A session contains the audio frames the gate received, their arrival times, the gate's per-chunk speech probabilities and decisions, echo-window changes, and the final transcripts.
   - Recording is pruned after `HERMES_LIVE_VAD_RECORDING_RETENTION_DAYS` (default 7) or beyond `HERMES_LIVE_VAD_RECORDING_MAX_MB` (default 500). Nothing leaves the machine.
   - The browser pre-gate drops very quiet audio before sending it, so recordings start where the gateway hears you.
2. **Use the assistant normally** for a few days, so the recordings include natural pauses, thinking aloud, and background noise.
3. **Replay.** Run `hermes-live vad replay`.
   - It runs every recorded session through the real speech gate and the same Silero model, on a virtual clock. It tries a grid of settings (`--stop`, `--tail`, `--stop-prob`) and compares each candidate with the live settings.
   - Columns:
     - **turns:** turns the gate opened. More than live means utterances were chopped apart.
     - **split:** turns that ended and restarted within 1.5 s (likely cut-offs).
     - **wait p50/p95:** silence between your last voiced audio and the end of the turn.
     - **clipped:** voiced audio that never reached the ASR (lost words).
   - ✓ marks candidates that wait less than live with no more turns, splits, or clipped audio.
4. **Apply.** Put the chosen values in `config.env` (double-quoted) and restart. No code changes are needed.
5. **Watch.** `GET /v1/metrics` reports two numbers live:
   - `silenceWait` (p50/p95): the wait the user actually experiences.
   - `gateResumes / gateStops`: the fraction of turn ends followed by speech within 1.5 s.

   If the resume rate climbs after a change, restore the previous values.
6. **Repeat** after changing microphone, room, or model.

A baseline replay with the recorded settings reproduces the live decisions. That makes a quick sanity check that replay and live behavior agree.
