# Brain failover & auto-diagnosis (exodia)

The main brain — SGLang `qwen38-tuned` (qwen3.8-27b) on `http://127.0.0.1:30000/v1` —
is shared by the **voice pipeline** (s2s) and the **Hermes Agent gateway**, and it
flakily crashes (dflash speculative-decoding `RuntimeError` → SIGQUIT, container
exits code 0 so the restart policy does not bring it back; see
`docs/worklog/2026-09-22-s2s-offline-fallback.md`). This system makes that outage
survivable: the assistant keeps answering on a cloud fallback (GLM via Z.ai), the
user is told, a diagnosis agent brings the brain back, and the shift is visible in
the voice console UI.

```
                       probes /v1/models every 10s
   ┌─────────────────────────┐        sglang qwen38-tuned :30000
   │ hermes-brain-failover   │────────────────────────────►│
   │ (systemd user service)  │  3 fails → DOWN / 5 oks → UP
   └───────┬─────────────────┘
   DOWN:   │ 1. rewrite s2s-brain.env → GLM + restart hermes-s2s
           │    (+ text turn through ws://127.0.0.1:8765 to prove it answers)
           │ 2. Telegram DM → "brain offline, running on GLM"  (verified message_id)
           │ 3. herdr: workspace + claude agent → docker start qwen38-tuned,
           │    verify :30000, report DIAG-RESULT markers in its pane
           │ 4. write clients/browser/brain-status.json → UI badge (amber = failover)
   UP:     │ reverse: primary env + restart, Telegram "restored",
           │ episode + diag outcome appended to episodes.jsonl
           ▼
   The CHAT gateway needs no per-transition switch: config.yaml carries a
   hermes-native fallback_model chain (zai/glm-5.2) that the LIVE gateway
   re-reads per agent create (gateway run_config_loaders._refresh_fallback_model),
   so chat turns fail over per-run and return to the primary automatically.
```

## Pieces and where they live

| Piece | Where |
| --- | --- |
| Controller daemon | `tools/brain-failover/brain_failover.py` (python3 stdlib only) |
| systemd user unit | `~/.config/systemd/user/hermes-brain-failover.service` (copy in `tools/brain-failover/`) |
| Runtime home | `~/.hermes/hermes-live/brain-failover/` — `config.json` (knobs), `state.json` (persisted FSM, single writer = the service), `command.json` (transient manual-transition mailbox), `episodes.jsonl` (episode journal + late `diag_update` corrections), `s2s-brain.env` (current voice brain, mode 600, may hold the GLM key) |
| Diagnosis brief | `tools/brain-failover/diag-brief.md` (the prompt sent to the herdr claude agent) |
| s2s brain plumbing | `~/.hermes/hermes-live/voice-stack/run-s2s.sh` reads `HERMES_BRAIN_*` (defaults = primary); `hermes-s2s.service` loads them via `EnvironmentFile=s2s-brain.env` |
| Gateway fallback chain | `~/.hermes/config.yaml` → `fallback_model: {provider: zai, model: glm-5.2}` (zai provider reads `GLM_API_KEY` / `GLM_BASE_URL` from `~/.hermes/.env`) |
| UI badge | `clients/browser/diagnostics.js` (top row of the always-on diagnostics panel: `brain · qwen3.8-27b · primary`) fed by `GET /brain-status.json` |
| Install / uninstall | `tools/brain-failover/install.sh` (idempotent, one-time backups `*.bak-brainfailover-*`) / `uninstall.sh [--full]` |

## Safety invariants

- The controller **never** stops/restarts/kills the sglang container; recovery is
  the herdr diagnosis agent's job (`docker start` only — enforced by the brief).
- The controller can only ever `systemctl --user` **one** unit: `hermes-s2s.service`
  (`ALLOWED_UNITS` allowlist in `brain_failover.py`; anything else raises).
- It never touches the Hermes gateways (`hermes-gateway.service`,
  `dev.hermes-live-voice.gateway.service`) or itself. The node gateway is only
  restarted **once, at install time**, to serve `/brain-status.json`.
- Secrets (`GLM_API_KEY`, `TELEGRAM_BOT_TOKEN`) are read from `~/.hermes/.env` at
  runtime; they never appear in the repo, the journal, or the UI. The only place
  the GLM key is written is `s2s-brain.env` (mode 600, same dir as the rest of
  the deployment's secrets).
- Flapping: hysteresis (`down_after` fails / `up_after` oks) + `min_down_s`
  before any switch-back + a flap alert (Telegram) at ≥3 outages/30 min.

## Configuration knobs

`~/.hermes/hermes-live/brain-failover/config.json` (created by install.sh with
defaults; the controller merges over built-in defaults, so a partial file is fine):

| Key | Default | Meaning |
| --- | --- | --- |
| `probe_interval_s` | 10 | how often `GET /v1/models` on :30000 is tried |
| `probe_timeout_s` | 3 | probe timeout (short — a loaded-but-alive server answers fast) |
| `down_after` | 3 | consecutive failed probes → DOWN (≈30 s at defaults) |
| `up_after` | 5 | consecutive OK probes → UP (model load takes 2–4 min anyway) |
| `min_down_s` | 120 | minimum time in DOWN before a switch-back is allowed |
| `flap_window_s` / `flap_alert_after` | 1800 / 3 | flap detection window and Telegram alert threshold |
| `s2s.verify_timeout_s` | 150 | how long to wait for ws :8765 after a restart |
| `s2s.text_probe` | true | post-failover, send one text turn through the live voice ws to prove GLM answers (its result goes into the Telegram message) |
| `telegram.enabled` | true | set false to stop Telegram notifications |
| `dry_run` | false | log every action instead of performing it |

## What a real outage looks like, step by step

T0 — sglang crashes (connection refused on :30000).
1. **T0+30 s** (3 failed probes): controller logs `BRAIN DOWN detected`,
   writes `s2s-brain.env` with the GLM endpoint (`glm-5.2`,
   `reasoning_effort=low` — GLM is a thinking model, low effort keeps voice
   turns snappy), restarts `hermes-s2s.service` (STT/TTS restart with it —
   they live in the same process), waits for ws :8765, sends one text turn
   ("Reply with exactly: FAILOVER OK") through the live pipeline.
2. Telegram DM: *"⚠️ Hermes brain failover — main model qwen3.8-27b looks DOWN…
   Voice brain switched to GLM glm-5.2… Diagnosis task started (herdr pane wX:pY)"*.
   Delivery is verified via the Bot API `message_id` (logged).
3. herdr gets a new workspace (`brain-failover-diag-<ts>`, cwd
   `/home/armand1m/sglang-tune`) with a claude agent (bypass permissions) fed
   `diag-brief.md`: inspect logs → `docker start qwen38-tuned` → poll
   `curl :30000/v1/models` until 200 → print `DIAG-RESULT/DIAG-SUMMARY/DIAG-CAUSE`.
4. Chat (Telegram DM to the agent, background runs): each run tries the primary,
   fails over per-run to GLM while :30000 is down — no user action needed.
5. The voice console's diagnostics panel turns amber: `brain · glm-5.2 · FAILOVER`,
   and new transcript entries get a ` ·glm` tag (who answered that turn).
6. **T1** (container back, 5 OK probes + ≥120 s in DOWN): voice brain switched
   back to the primary, Telegram DM *"✅ Hermes main brain restored (was down
   38m)… Diagnosis: RECOVERED — …"*, episode closed into `episodes.jsonl` with
   the diag outcome parsed from the agent pane.
7. At any moment: `journalctl --user -u hermes-brain-failover -f` shows every
   probe decision, action, and notification.

## Manual tests

Without touching the production brain:

```bash
# 1. Full state-machine path, scripted probes, zero side effects (also run by npm test)
python3 tools/brain-failover/selftest.py

# 2. Controller's view of the world right now
python3 tools/brain-failover/brain_failover.py verify

# 3. Real transitions against the live stack (primary is UP the whole time):
python3 tools/brain-failover/brain_failover.py force-down   # voice → GLM, Telegram, herdr diag
#    … the watchdog sees the primary is healthy and flips back on its own after
#    min_down_s (120 s) — the full auto-restore path, telegram included; or end
#    the drill early:
python3 tools/brain-failover/brain_failover.py force-up
```

`force-down` is the closest safe equivalent of an outage: the real GLM switch,
the real notification, the real herdr spawn. When the service is running, the
CLI hands the transition to it via `command.json` (the service is the single
writer of `state.json`), waits for the flip, and the Telegram messages carry a
`🧪 MANUAL TEST` banner so a test can never look like a real outage. The
diagnosis agent will find :30000 healthy and report `ALREADY-UP` — often after
the (short) test episode has already closed, in which case the controller keeps
watching the pane for up to 30 min and journals a `diag_update` correction when
the markers land.

The full live drill (only from a safe moment — **it takes the real brain down**):

```bash
docker stop qwen38-tuned
# …watch: journalctl --user -u hermes-brain-failover -f
#   ~30s  BRAIN DOWN detected → s2s on GLM, Telegram, herdr diag workspace
#   ~1min diag agent runs docker start; model loads 2–4 min
#   …     /v1/models 200 → 5 OK probes → voice back on primary, Telegram, episode logged
docker start qwen38-tuned   # if you want to end the drill early by hand
```

## How to disable

```bash
tools/brain-failover/uninstall.sh          # stop controller, remove gateway chain, voice stays on primary
tools/brain-failover/uninstall.sh --full   # also restore run-s2s.sh/unit/server.ts from backups + rebuild
```

Kill switches for individual behaviors: `telegram.enabled: false` in
`config.json` (no notifications), remove the `fallback_model:` block from
`~/.hermes/config.yaml` (chat no longer fails over), `systemctl --user stop
hermes-brain-failover` (everything off; the s2s env file keeps the last brain —
`uninstall.sh` removes it and restarts s2s on the primary defaults).

## If the controller itself crashes

`Restart=on-failure` (systemd) brings it back in 5 s. On boot it reconciles:
`state.json` is the source of truth; if the s2s env file disagrees with the state
(crash mid-transition), the state wins and the switch is re-applied. Every
action is journaled in `state.json.actions` and re-run until it succeeds, so a
crash can never leave the system half-switched. State survives restarts
(`state survives restart` in the selftest).

## Known limitations

- Switching the voice brain restarts the whole s2s process (STT+TTS included);
  an in-flight utterance at that moment is lost. The brain being down makes that
  near-moot (turns were already failing).
- The hermes-live browser page keeps its ws to :8788 across an s2s restart, but
  the gateway's provider pipe is re-established per session; if voice seems
  stuck after a flip, reload the page — the amber badge tells you why.
- GLM latency is ~3 s/turn (vs the local brain's sub-second); the thinking
  model is pinned to `reasoning_effort=low` for voice.
- The GLM coding endpoint aliases `glm-5.2` → answers report `model: glm-5.3`
  server-side; the controller logs the served model id when it probes.
- `/brain-status.json` is served by the voice gateway from the repo working
  tree (static allowlist entry added by install.sh). On a fresh non-exodia
  deploy without the controller the badge shows `—` and nothing else changes.
