#!/usr/bin/env bash
# Reverse everything install.sh did (idempotent).
#   --full  also restore run-s2s.sh / hermes-s2s.service / server.ts from their
#           oldest backups, rebuild dist and restart the voice gateway.
# Without --full it only disables the controller + removes the config.yaml
# fallback chain (the live gateway drops the chain on its next re-read), so
# failover simply stops happening while voice stays on the primary brain.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BF_HOME="$HOME/.hermes/hermes-live/brain-failover"
S2S_DIR="$HOME/.hermes/hermes-live/voice-stack"
S2S_UNIT_DIR="$HOME/.config/systemd/user"
NODE_GATEWAY_UNIT="dev.hermes-live-voice.gateway.service"
export PATH="$HOME/.local/bin:$PATH"

say() { printf '\033[1;33m[brain-failover uninstall]\033[0m %s\n' "$*"; }

oldest_backup() {
  ls -1 "$1".bak-brainfailover-* 2>/dev/null | head -1 || true
}

# 1. stop + disable the controller
systemctl --user disable --now hermes-brain-failover.service 2>/dev/null || true
rm -f "$S2S_UNIT_DIR/hermes-brain-failover.service"
systemctl --user daemon-reload
say "controller stopped and unit removed"

# 2. put the voice brain back on the primary before removing the env plumbing
if [ -f "$BF_HOME/s2s-brain.env" ]; then
  rm -f "$BF_HOME/s2s-brain.env"
  say "removed $BF_HOME/s2s-brain.env"
  if systemctl --user is-active --quiet hermes-s2s.service; then
    say "restarting hermes-s2s on the primary brain defaults…"
    systemctl --user restart hermes-s2s.service
  fi
fi

# 3. drop the gateway fallback chain
GW_CFG="$HOME/.hermes/config.yaml"
if [ -f "$GW_CFG" ] && grep -qE '^fallback_model:' "$GW_CFG"; then
  cp -p "$GW_CFG" "$GW_CFG.bak-brainfailover-uninstall-$(date +%Y%m%d-%H%M%S)"
  python3 - "$GW_CFG" <<'PY'
import sys
path = sys.argv[1]
lines = open(path).read().splitlines(keepends=True)
out, skipping = [], False
for line in lines:
    if line.startswith("fallback_model:"):
        skipping = True
        # also swallow the managed comment block right above it
        while out and out[-1].lstrip().startswith("#") and "brain failover" in "".join(out[-3:]).lower():
            out.pop()
        continue
    if skipping:
        stripped = line.strip()
        if stripped.startswith("#") or not stripped:
            # only skip comments/blank lines directly under the block
            if stripped.startswith("#"):
                continue
            if not stripped:
                skipping = False
                continue
        skipping = False
    out.append(line)
open(path, "w").write("".join(out))
print("fallback_model block removed")
PY
  say "gateway fallback chain removed (live gateway drops it on next re-read)"
fi

if [ "${1:-}" = "--full" ]; then
  for pair in "$S2S_DIR/run-s2s.sh" "$S2S_UNIT_DIR/hermes-s2s.service" "$REPO/src/adapters/inbound/http/server.ts"; do
    backup="$(oldest_backup "$pair")"
    if [ -n "$backup" ]; then
      cp -p "$backup" "$pair"
      say "restored $pair from $backup"
    fi
  done
  systemctl --user daemon-reload
  if [ -f "$REPO/dist/adapters/inbound/http/server.js" ]; then
    say "rebuilding dist…"
    (cd "$REPO" && npm run build >/dev/null)
    systemctl --user restart "$NODE_GATEWAY_UNIT" || true
  fi
  if systemctl --user is-active --quiet hermes-s2s.service; then
    systemctl --user restart hermes-s2s.service
  fi
  sed -i '\#^clients/browser/brain-status.json$#d' "$REPO/.git/info/exclude" 2>/dev/null || true
  rm -f "$REPO/clients/browser/brain-status.json"
  say "full restore done"
else
  say "kept run-s2s.sh/unit/server.ts patches (harmless without the controller); re-run with --full to restore backups"
fi
