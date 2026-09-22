#!/usr/bin/env bash
# Install the LAYA System-1 sidecar (idempotent; safe to re-run).
#
#   1. venv at ~/.hermes/hermes-live/laya-sidecar/venv (laya==0.3.5 + fastapi)
#      - reuses an existing venv as-is when the packages are already present
#   2. shadow-log directory ~/.hermes/hermes-live/laya-shadow/
#   3. install + enable hermes-laya.service (systemd user unit, 127.0.0.1:8767)
#
# Deliberately does NOT touch the voice gateway: the gateway wiring is the
# HERMES_LIVE_LAYA_* config keys, which default to OFF (no URL = feature
# fully inert). See docs/laya-system1.md for the enable steps.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LAYA_HOME="$HOME/.hermes/hermes-live/laya-sidecar"
VENV="$LAYA_HOME/venv"
VENV_PYTHON="$VENV/bin/python"
SHADOW_DIR="$HOME/.hermes/hermes-live/laya-shadow"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="hermes-laya.service"
PORT="${LAYA_PORT:-8767}"

say() { printf '\033[1;36m[laya-sidecar install]\033[0m %s\n' "$*"; }

# ── 1. venv bootstrap ────────────────────────────────────────────────────────
mkdir -p "$LAYA_HOME" "$SHADOW_DIR"
if [ ! -x "$VENV_PYTHON" ]; then
  say "creating venv at $VENV (python3 -m venv)…"
  python3 -m venv "$VENV"
fi
if ! "$VENV_PYTHON" -c "import laya, fastapi, uvicorn" >/dev/null 2>&1; then
  say "installing laya==0.3.5 + fastapi + uvicorn (large torch download on first run)…"
  "$VENV/bin/pip" install --upgrade pip >/dev/null
  "$VENV/bin/pip" install "laya==0.3.5" fastapi "uvicorn[standard]"
else
  say "venv already has laya + fastapi — left untouched"
fi

# ── 2. systemd user unit ─────────────────────────────────────────────────────
mkdir -p "$UNIT_DIR"
python3 - "$REPO/tools/laya-sidecar/hermes-laya.service" "$UNIT_DIR/$UNIT" "$VENV_PYTHON" "$REPO" <<'PY'
import sys
src_path, dest_path, venv_python, repo = sys.argv[1:5]
unit = open(src_path).read()
unit = unit.replace("__VENV_PYTHON__", venv_python).replace("__REPO__", repo)
open(dest_path, "w").write(unit)
print(f"unit written: {dest_path}")
PY
systemctl --user daemon-reload
systemctl --user enable --now "$UNIT"

# ── 3. wait for /healthz (model load ~18 s warm; first-ever run downloads) ──
say "waiting for /healthz on 127.0.0.1:$PORT (model load can take a couple of minutes on first run)…"
for _ in $(seq 1 300); do
  if curl -sf -m 2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    say "sidecar healthy: $(curl -sf -m 2 "http://127.0.0.1:$PORT/healthz")"
    say "done. Shadow logging is OFF until the gateway gets HERMES_LIVE_LAYA_URL (docs/laya-system1.md)."
    exit 0
  fi
  sleep 1
done
echo "sidecar did not become healthy within 300s — check: journalctl --user -u $UNIT -n 50" >&2
exit 1
