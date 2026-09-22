#!/usr/bin/env bash
# Install the brain-failover system on this host (idempotent; safe to re-run).
#
#   1. ~/.hermes/hermes-live/brain-failover/{config.json,state} + initial UI status file
#   2. patch run-s2s.sh so the brain endpoint comes from HERMES_BRAIN_* env
#   3. patch hermes-s2s.service with an EnvironmentFile pointing at s2s-brain.env
#   4. append the hermes-native fallback_model chain to ~/.hermes/config.yaml
#      (the live gateway re-reads it per agent create — no gateway restart)
#   5. add /brain-status.json to the voice gateway static allowlist + rebuild +
#      restart dev.hermes-live-voice.gateway.service (brief page ws reconnect)
#   6. install + enable hermes-brain-failover.service
#
# Every patched file gets a one-time timestamped backup (bak-brainfailover-*).
# Reverse everything with uninstall.sh. Docs: docs/brain-failover.md.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BF_HOME="$HOME/.hermes/hermes-live/brain-failover"
S2S_DIR="$HOME/.hermes/hermes-live/voice-stack"
S2S_UNIT_DIR="$HOME/.config/systemd/user"
NODE_GATEWAY_UNIT="dev.hermes-live-voice.gateway.service"
export PATH="$HOME/.local/bin:$PATH"

say() { printf '\033[1;36m[brain-failover install]\033[0m %s\n' "$*"; }

backup_once() {
  local file="$1"
  local existing
  existing="$(ls -1 "$file".bak-brainfailover-* 2>/dev/null | head -1 || true)"
  if [ -z "$existing" ]; then
    cp -p "$file" "$file.bak-brainfailover-$(date +%Y%m%d-%H%M%S)"
    say "backup: $file.bak-brainfailover-*"
  fi
}

mkdir -p "$BF_HOME"

# ── 1. config + initial status file ─────────────────────────────────────────
if [ ! -f "$BF_HOME/config.json" ]; then
  cat > "$BF_HOME/config.json" <<'JSON'
{
  "probe_interval_s": 10,
  "probe_timeout_s": 3,
  "down_after": 3,
  "up_after": 5,
  "min_down_s": 120,
  "flap_window_s": 1800,
  "flap_alert_after": 3,
  "primary": {
    "name": "qwen3.8-27b",
    "models_url": "http://127.0.0.1:30000/v1/models",
    "s2s_base_url": "http://127.0.0.1:30000/v1",
    "s2s_api_key": "none",
    "reasoning_effort": ""
  },
  "fallback": {
    "name": "glm-5.2",
    "models_url_env": "GLM_BASE_URL",
    "s2s_base_url_env": "GLM_BASE_URL",
    "s2s_api_key_env": "GLM_API_KEY",
    "reasoning_effort": "low"
  },
  "telegram": { "enabled": true },
  "s2s": { "verify_timeout_s": 150, "text_probe": true },
  "dry_run": false
}
JSON
  say "wrote $BF_HOME/config.json (defaults; knobs documented in docs/brain-failover.md)"
else
  say "config.json already present — left untouched"
fi

# Initial UI status file (the controller rewrites it on every tick once up).
STATUS_FILE="$REPO/clients/browser/brain-status.json"
if [ ! -f "$STATUS_FILE" ]; then
  python3 - "$STATUS_FILE" <<'PY'
import json, sys
from datetime import datetime, timezone
payload = {
    "state": "up",
    "brain": "qwen3.8-27b",
    "kind": "primary",
    "since": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    "episodeId": None,
    "diag": None,
}
open(sys.argv[1], "w").write(json.dumps(payload, indent=2) + "\n")
print("initial brain-status.json written")
PY
  say "initial status file: $STATUS_FILE (primary)"
fi

# ── 2. patch run-s2s.sh (brain endpoint via env) ─────────────────────────────
backup_once "$S2S_DIR/run-s2s.sh"
python3 - "$S2S_DIR/run-s2s.sh" <<'PY'
import sys, time
path = sys.argv[1]
script = open(path).read()
marker = "hermes-brain-failover brain override"
if marker in script:
    print("run-s2s.sh already patched")
    sys.exit(0)
old_flags = """  --model_name qwen3.8-27b \\
  --responses_api_base_url http://127.0.0.1:30000/v1 \\
  --responses_api_api_key none \\"""
if old_flags not in script:
    sys.exit("run-s2s.sh: expected brain flag block not found — update the patcher (docs/brain-failover.md)")
block = """# --- hermes-brain-failover brain override (docs/brain-failover.md in the repo) ---
# The systemd unit injects HERMES_BRAIN_* from brain-failover/s2s-brain.env;
# these defaults keep the primary brain when the env file is absent.
BRAIN_BASE_URL="${HERMES_BRAIN_BASE_URL:-http://127.0.0.1:30000/v1}"
BRAIN_API_KEY="${HERMES_BRAIN_API_KEY:-none}"
BRAIN_MODEL="${HERMES_BRAIN_MODEL:-qwen3.8-27b}"
BRAIN_REASONING_EFFORT="${HERMES_BRAIN_REASONING_EFFORT:-}"
BRAIN_ARGS=(--model_name "$BRAIN_MODEL" --responses_api_base_url "$BRAIN_BASE_URL" --responses_api_api_key "$BRAIN_API_KEY")
if [ -n "$BRAIN_REASONING_EFFORT" ]; then
  BRAIN_ARGS+=(--responses_api_reasoning_effort "$BRAIN_REASONING_EFFORT")
fi

"""
marker_line = "exec "
idx = script.index(marker_line)
script = script[:idx] + block + script[idx:]
script = script.replace(old_flags, '  "${BRAIN_ARGS[@]}" \\')
open(path, "w").write(script)
print("run-s2s.sh patched: brain flags now come from HERMES_BRAIN_* env")
PY

# ── 3. patch hermes-s2s.service unit ────────────────────────────────────────
UNIT="$S2S_UNIT_DIR/hermes-s2s.service"
backup_once "$UNIT"
if ! grep -q 'brain-failover/s2s-brain.env' "$UNIT"; then
  python3 - "$UNIT" <<'PY'
import sys
path = sys.argv[1]
unit = open(path).read()
line = "EnvironmentFile=-/home/armand1m/.hermes/hermes-live/brain-failover/s2s-brain.env\n"
comment = "# Brain selection written by hermes-brain-failover (GLM failover; '-' = optional).\n"
anchor = "TimeoutStartSec=180\n"
if anchor not in unit:
    sys.exit("hermes-s2s.service: anchor not found")
unit = unit.replace(anchor, anchor + comment + line)
open(path, "w").write(unit)
print("hermes-s2s.service patched with EnvironmentFile")
PY
  systemctl --user daemon-reload
  say "hermes-s2s.service: EnvironmentFile added (takes effect on next service start; NOT restarting now)"
else
  say "hermes-s2s.service already patched"
fi

# ── 4. gateway fallback chain in ~/.hermes/config.yaml ───────────────────────
GW_CFG="$HOME/.hermes/config.yaml"
backup_once "$GW_CFG"
if ! grep -qE '^fallback_model:' "$GW_CFG"; then
  cat >> "$GW_CFG" <<'YAML'

# ── Brain failover (managed by hermes-brain-failover; docs: hermes-live-voice
#    repo docs/brain-failover.md; remove this block to disable) ──
# Per-run automatic fallback: when the primary (vllm :30000) is unreachable,
# runs answer on GLM via the zai coding endpoint (GLM_API_KEY / GLM_BASE_URL
# from ~/.hermes/.env). The gateway re-reads this live (no restart needed);
# new runs return to the primary once it is healthy again.
fallback_model:
  provider: zai
  model: glm-5.2
YAML
  say "config.yaml: fallback_model chain added (live gateway picks it up on the next agent create)"
else
  say "config.yaml already has a fallback_model chain"
fi

# ── 5. UI status file allowlist + rebuild + restart node gateway ─────────────
SERVER_TS="$REPO/src/adapters/inbound/http/server.ts"
ALLOW_LINE='    "/brain-status.json": ["brain-status.json", "application/json; charset=utf-8"],'
NEED_BUILD=0
if ! grep -q '"/brain-status.json"' "$SERVER_TS"; then
  backup_once "$SERVER_TS"
  python3 - "$SERVER_TS" "$ALLOW_LINE" <<'PY'
import sys
path, line = sys.argv[1], sys.argv[2] + "\n"
src = open(path).read()
anchor = '    "/task-narrator.js": ["task-narrator.js", "text/javascript; charset=utf-8"],\n'
if anchor not in src:
    sys.exit("server.ts: allowlist anchor not found")
src = src.replace(anchor, anchor + line)
open(path, "w").write(src)
print("server.ts: /brain-status.json added to the static allowlist")
PY
  NEED_BUILD=1
else
  if ! grep -q '"/brain-status.json"' "$REPO/dist/adapters/inbound/http/server.js" 2>/dev/null; then
    NEED_BUILD=1
  fi
fi
if [ "$NEED_BUILD" = 1 ]; then
  say "rebuilding dist (npm run build) so the allowlist entry is served…"
  (cd "$REPO" && npm run build >/dev/null)
  say "restarting $NODE_GATEWAY_UNIT (voice page ws reconnects automatically)…"
  systemctl --user restart "$NODE_GATEWAY_UNIT"
  for _ in $(seq 1 30); do
    if curl -sf -m 2 http://127.0.0.1:8788/health >/dev/null 2>&1; then break; fi
    sleep 1
  done
  curl -sf -m 2 http://127.0.0.1:8788/health >/dev/null || { echo "gateway did not come back" >&2; exit 1; }
  say "voice gateway healthy again"
else
  say "server.ts + dist already serve /brain-status.json"
fi

# keep the runtime-written status file out of git status
if ! grep -qx 'clients/browser/brain-status.json' "$REPO/.git/info/exclude" 2>/dev/null; then
  echo 'clients/browser/brain-status.json' >> "$REPO/.git/info/exclude"
  say "added clients/browser/brain-status.json to .git/info/exclude"
fi

# ── 6. install the controller unit ───────────────────────────────────────────
cp "$REPO/tools/brain-failover/hermes-brain-failover.service" "$S2S_UNIT_DIR/hermes-brain-failover.service"
systemctl --user daemon-reload
systemctl --user enable --now hermes-brain-failover.service
sleep 2
systemctl --user --no-pager --lines=5 status hermes-brain-failover.service | head -8 || true

python3 "$REPO/tools/brain-failover/brain_failover.py" verify || true
say "done. Watch it: journalctl --user -u hermes-brain-failover -f"
