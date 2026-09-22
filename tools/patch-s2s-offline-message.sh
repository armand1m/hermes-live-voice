#!/usr/bin/env bash
# Re-apply the hermes-live local patch to the installed Hugging Face
# `speech_to_speech` package (pip/uv install, NOT editable, so reinstalls and
# upgrades clobber it).
#
# What the patch does: when the LLM provider endpoint is unreachable
# (openai.APIConnectionError: connection refused / request timed out), the
# voice agent says "I can't reach the main model right now. It looks offline.
# Please try again in a minute." instead of the generic
# "I'm having trouble responding right now. Please try again."
# All other provider failures (4xx/5xx, mid-stream httpx.ReadTimeout, ...) keep
# the original generic line; the normal path is untouched.
#
# The script also (re-)applies the older 2026-09-21 diagnostics patch
# ("LLM failure detail: ..." logging) that lives in the same function, so a
# fresh package install gets both back.
#
# Usage (from the repo root, or anywhere):
#   tools/patch-s2s-offline-message.sh
# Override the voice-stack venv if it moved:
#   S2S_VENV=/path/to/.venv tools/patch-s2s-offline-message.sh
#
# Idempotent: exits 0 with "already applied" when every marker is present.
# After patching, the RUNNING s2s process must be restarted to pick it up:
#   systemctl --user restart hermes-s2s.service
set -euo pipefail

S2S_VENV="${S2S_VENV:-/home/armand1m/.hermes/hermes-live/voice-stack/.venv}"
TARGET="$S2S_VENV/lib/python3.12/site-packages/speech_to_speech/LLM/base_openai_compatible_language_model.py"

if [[ ! -f "$TARGET" ]]; then
  echo "ERROR: target not found: $TARGET" >&2
  echo "Set S2S_VENV=<voice-stack venv path> if the stack moved." >&2
  exit 1
fi

PY=python3
[[ -x "$S2S_VENV/bin/python" ]] && PY="$S2S_VENV/bin/python"

TARGET="$TARGET" "$PY" - <<'PYEOF'
import datetime
import os
import py_compile
import sys
import tempfile

path = os.environ["TARGET"]
with open(path, encoding="utf-8") as f:
    src = f.read()


def ensure(text: str, marker: str, old: str, new: str, what: str) -> str:
    """Insert `new` (replacing `old`) unless `marker` says it is already there."""
    if marker in text:
        return text
    n = text.count(old)
    if n != 1:
        sys.exit(
            f"ERROR: anchor for [{what}] found {n} times (expected exactly 1).\n"
            f"The upstream package changed; review and re-apply the patch manually.\n"
            f"Target: {path}"
        )
    return text.replace(old, new, 1)


# 0. Older local diagnostics patch (2026-09-21): log provider error class/body.
src = ensure(
    src,
    marker="LLM failure detail",
    old='log_exception(logger, "LLM generation failed; ending the current response", exc)\n',
    new=(
        'log_exception(logger, "LLM generation failed; ending the current response", exc)\n'
        "                # Local diagnostics patch: record the provider error class and\n"
        "                # body (no conversation content) so 4xx/5xx causes are visible.\n"
        '                logger.error("LLM failure detail: %s: %s", type(exc).__name__, str(exc)[:500])\n'
    ),
    what="diagnostics logging",
)

# 1. Import the exception class we branch on.
src = ensure(
    src,
    marker="from openai import APIConnectionError",
    old="from openai import OpenAI",
    new="from openai import APIConnectionError, OpenAI",
    what="openai import",
)

# 2. New spoken line for the provider-unreachable path.
src = ensure(
    src,
    marker="PROVIDER_OFFLINE_FALLBACK",
    old='PROVIDER_FAILURE_FALLBACK = "I\'m having trouble responding right now. Please try again."',
    new=(
        'PROVIDER_FAILURE_FALLBACK = "I\'m having trouble responding right now. Please try again."\n'
        "# hermes-live local patch (2026-09-22): when the provider endpoint itself is\n"
        "# unreachable (connection refused / request timed out), say so instead of the\n"
        "# generic failure line. Re-applied by hermes-live-voice\n"
        "# tools/patch-s2s-offline-message.sh after voice-stack reinstalls.\n"
        "PROVIDER_OFFLINE_FALLBACK = (\n"
        '    "I can\'t reach the main model right now. It looks offline. Please try again in a minute."\n'
        ")"
    ),
    what="offline constant",
)

# 3. Per-turn fallback selector, defaulting to the original generic line.
src = ensure(
    src,
    marker="fallback_line: str = PROVIDER_FAILURE_FALLBACK",
    old="        error_message: str | None = None\n        generation_completed = False",
    new=(
        "        error_message: str | None = None\n"
        "        fallback_line: str = PROVIDER_FAILURE_FALLBACK\n"
        "        generation_completed = False"
    ),
    what="fallback_line init",
)

# 4. Connection errors (incl. openai.APITimeoutError) select the offline line.
src = ensure(
    src,
    marker="isinstance(exc, APIConnectionError)",
    old='                logger.error("LLM failure detail: %s: %s", type(exc).__name__, str(exc)[:500])\n',
    new=(
        '                logger.error("LLM failure detail: %s: %s", type(exc).__name__, str(exc)[:500])\n'
        "                if isinstance(exc, APIConnectionError):\n"
        "                    fallback_line = PROVIDER_OFFLINE_FALLBACK\n"
    ),
    what="isinstance check",
)

# 5. Emit the selected line.
src = ensure(
    src,
    marker="text=fallback_line,",
    old="                    text=PROVIDER_FAILURE_FALLBACK,",
    new="                    text=fallback_line,",
    what="emission site",
)

if src == open(path, encoding="utf-8").read():
    print("Already applied - nothing to do.")
    sys.exit(0)

# Compile the patched source BEFORE touching the installed file.
tmp = tempfile.NamedTemporaryFile("w", suffix=".py", delete=False, encoding="utf-8")
tmp.write(src)
tmp.close()
try:
    py_compile.compile(tmp.name, doraise=True)
except py_compile.PyCompileError as exc:
    os.unlink(tmp.name)
    sys.exit(f"ERROR: patched source does not compile, aborting without changes:\n{exc}")

# Timestamped backup, then atomic replace via a NEW inode: the site-packages
# file may be hardlinked into uv's wheel cache, and os.replace breaks that
# link so the patch (and any future edits) stay confined to this venv.
stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
backup = f"{path}.bak-{stamp}"
with open(path, encoding="utf-8") as f:
    original = f.read()
with open(backup, "w", encoding="utf-8") as f:
    f.write(original)
os.replace(tmp.name, path)

print(f"Patched:  {path}")
print(f"Backup:   {backup}")
print("NOTE: restart the running s2s process to load the patch:")
print("  systemctl --user restart hermes-s2s.service")
PYEOF
