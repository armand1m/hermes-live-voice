#!/usr/bin/env python3
"""hermes-brain-failover — brain watchdog + GLM failover for the exodia voice stack.

Watches the shared main brain (SGLang `qwen38-tuned` on http://127.0.0.1:30000/v1,
used by BOTH the s2s voice pipeline and the Hermes Agent gateway). When it goes
down, the controller:

  1. switches the VOICE brain (hermes-s2s.service) to the GLM fallback by
     rewriting the brain env file and restarting the service,
  2. notifies the user over Telegram (Bot API, delivery is verified by
     message_id),
  3. spawns a herdr claude agent that diagnoses and recovers the sglang
     container (it runs `docker start`; the controller itself NEVER touches
     docker),
  4. logs everything (journald + episodes.jsonl) and mirrors its state to
     clients/browser/brain-status.json, which the voice console's diagnostics
     overlay renders as the active-brain indicator.

When the main brain comes back it switches the voice brain back, notifies the
user again, and records the diagnosis outcome parsed from the agent pane.

The CHAT gateway does not need per-transition switching: ~/.hermes/config.yaml
carries a hermes-native `fallback_model` chain (zai/glm-5.2) that the live
gateway re-reads per agent create (gateway run_config_loaders._refresh_fallback_
model), so chat turns fail over per-run and return to the primary automatically.
The controller only verifies that block exists at startup.

Safety invariants (enforced below, not just documented):
  * the only systemd unit this process may act on is hermes-s2s.service;
  * it never runs docker / never stops anything — recovery is the herdr
    agent's job (`docker start` only);
  * it never touches the Hermes gateways or itself.

Stdlib only. Configuration: <home>/config.json over HERMES_BRAIN_FAILOVER_HOME
(default ~/.hermes/hermes-live/brain-failover). See docs/brain-failover.md.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import re
import secrets
import socket
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

REPO_ROOT = Path(__file__).resolve().parents[2]
STATE_VERSION = 1

# The ONLY systemd unit the controller is ever allowed to manage. Every
# systemctl call goes through _systemctl(), which enforces this allowlist.
ALLOWED_UNITS = frozenset({"hermes-s2s.service"})

DEFAULT_HOME = Path.home() / ".hermes" / "hermes-live" / "brain-failover"

DEFAULTS: dict[str, Any] = {
    "probe_interval_s": 10.0,
    "probe_timeout_s": 3.0,
    "down_after": 3,          # consecutive failed probes -> DOWN
    "up_after": 5,            # consecutive OK probes -> UP (hysteresis)
    "min_down_s": 120,        # no flip-back before this, even if probes pass
    "flap_window_s": 1800,    # down-transitions counted for flap detection
    "flap_alert_after": 3,
    "primary": {
        "name": "qwen3.8-27b",
        "models_url": "http://127.0.0.1:30000/v1/models",
        "s2s_base_url": "http://127.0.0.1:30000/v1",
        "s2s_api_key": "none",
        "reasoning_effort": "",
    },
    # Fallback endpoint values come from ~/.hermes/.env at runtime (never stored
    # in the repo, never logged, never shown in the UI).
    "fallback": {
        "name": "glm-5.2",
        "models_url_env": "GLM_BASE_URL",
        "s2s_base_url_env": "GLM_BASE_URL",
        "s2s_api_key_env": "GLM_API_KEY",
        "reasoning_effort": "low",
    },
    "hermes_env_file": str(Path.home() / ".hermes" / ".env"),
    "s2s": {
        "unit": "hermes-s2s.service",
        "env_file": "",  # default: <home>/s2s-brain.env
        "ws_host": "127.0.0.1",
        "ws_port": 8765,
        "ws_path": "/v1/realtime",
        "verify_timeout_s": 150.0,
        "text_probe": True,          # post-failover turn through the live ws
        "text_probe_timeout_s": 60.0,
    },
    "telegram": {
        "enabled": True,
        "api": "https://api.telegram.org",
        "bot_token_env": "TELEGRAM_BOT_TOKEN",
        "chat_id_env": "TELEGRAM_HOME_CHANNEL",
        "thread_id_env": "TELEGRAM_HOME_CHANNEL_THREAD_ID",
        "retries": 3,
    },
    "herdr": {
        "bin": str(Path.home() / ".local" / "bin" / "herdr"),
        "cwd": "/home/armand1m/sglang-tune",
        "label_prefix": "brain-failover-diag",
        "agent_prefix": "bfdiag",
        "agent_kind": "claude",
        "start_timeout_ms": 180_000,
    },
    "diag_brief": str(REPO_ROOT / "tools" / "brain-failover" / "diag-brief.md"),
    "status_file": str(REPO_ROOT / "clients" / "browser" / "brain-status.json"),
    "gateway_fallback_block": "fallback_model:",  # marker checked in config.yaml
    "gateway_config": str(Path.home() / ".hermes" / "config.yaml"),
    "dry_run": False,
}

log = logging.getLogger("brain-failover")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.isoformat(timespec="seconds")


def local_ts(dt: datetime) -> str:
    return dt.astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")


def human_duration(seconds: float) -> str:
    seconds = int(seconds)
    if seconds < 60:
        return f"{seconds}s"
    minutes, sec = divmod(seconds, 60)
    if minutes < 60:
        return f"{minutes}m{sec:02d}s"
    hours, minutes = divmod(minutes, 60)
    return f"{hours}h{minutes:02d}m"


def deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    merged = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def atomic_write_text(path: Path, text: str, mode: int = 0o644) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with open(tmp, "w", encoding="utf-8") as handle:
        handle.write(text)
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def atomic_write_json(path: Path, payload: Any, mode: int = 0o644) -> None:
    atomic_write_text(path, json.dumps(payload, indent=2, sort_keys=False) + "\n", mode)


def parse_env_file(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.is_file():
        return env
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        env[key.strip()] = value
    return env


class CommandError(RuntimeError):
    pass


def run_command(
    argv: list[str],
    timeout: float = 60.0,
    check: bool = True,
) -> subprocess.CompletedProcess:
    """Run a subprocess, logging the argv (never env values / secrets)."""
    shown = " ".join(argv)
    if len(shown) > 300:
        shown = shown[:300] + "…"
    log.debug("exec: %s", shown)
    try:
        proc = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except FileNotFoundError as error:
        raise CommandError(f"command not found: {argv[0]}") from error
    except subprocess.TimeoutExpired as error:
        raise CommandError(f"command timed out after {timeout}s: {argv[0]}") from error
    if check and proc.returncode != 0:
        excerpt = (proc.stderr or proc.stdout or "").strip()[-500:]
        raise CommandError(f"command failed ({argv[0]} rc={proc.returncode}): {excerpt}")
    return proc


def _systemctl(action: str, unit: str) -> subprocess.CompletedProcess:
    if unit not in ALLOWED_UNITS:
        # Hard safety rail: the controller manages exactly one unit.
        raise CommandError(f"refusing to systemctl {action} {unit}: not in allowlist {sorted(ALLOWED_UNITS)}")
    return run_command(["systemctl", "--user", action, unit], timeout=30)


def http_get_json(url: str, timeout: float, headers: Optional[dict[str, str]] = None) -> tuple[int, Any]:
    request = urllib.request.Request(url, headers={"accept": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read(1_000_000)
            return response.status, json.loads(body or b"null")
    except urllib.error.HTTPError as error:
        return error.code, None
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError, ValueError) as error:
        raise ConnectionError(str(error) or error.__class__.__name__) from error


def ws_listening(host: str, port: int, timeout: float = 1.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


# ---------------------------------------------------------------------------
# Minimal RFC6455 client — enough for one text turn against the local s2s
# realtime endpoint (std-lib only; used ONLY as a post-failover sanity probe).
# ---------------------------------------------------------------------------

def _ws_frame(opcode: int, payload: bytes) -> bytes:
    mask = secrets.token_bytes(4)
    header = bytes([0x80 | opcode])
    length = len(payload)
    if length < 126:
        header += bytes([0x80 | length])
    elif length < 65536:
        header += bytes([0x80 | 126]) + struct.pack(">H", length)
    else:
        header += bytes([0x80 | 127]) + struct.pack(">Q", length)
    masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
    return header + mask + masked


def _ws_read_frame(sock: socket.socket) -> tuple[int, bytes]:
    def read_exact(count: int) -> bytes:
        chunks = b""
        while len(chunks) < count:
            chunk = sock.recv(count - len(chunks))
            if not chunk:
                raise ConnectionError("socket closed mid-frame")
            chunks += chunk
        return chunks

    head = read_exact(2)
    opcode = head[0] & 0x0F
    length = head[1] & 0x7F
    masked = bool(head[1] & 0x80)
    if length == 126:
        length = struct.unpack(">H", read_exact(2))[0]
    elif length == 127:
        length = struct.unpack(">Q", read_exact(8))[0]
    if length > 4_000_000:
        raise ConnectionError(f"frame too large: {length}")
    mask = read_exact(4) if masked else b""
    payload = read_exact(length) if length else b""
    if masked:
        payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
    return opcode, payload


def realtime_text_turn(
    host: str,
    port: int,
    path: str,
    prompt: str,
    timeout_s: float,
) -> dict[str, Any]:
    """One text turn over the s2s realtime ws; returns {ok, text, error}."""
    result: dict[str, Any] = {"ok": False, "text": "", "error": ""}
    sock = socket.create_connection((host, port), timeout=timeout_s)
    try:
        sock.settimeout(timeout_s)
        key = base64_key = __import__("base64").b64encode(secrets.token_bytes(16)).decode()
        request = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {base64_key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        sock.sendall(request.encode())
        response = b""
        while b"\r\n\r\n" not in response:
            chunk = sock.recv(4096)
            if not chunk:
                raise ConnectionError("closed during handshake")
            response += chunk
        status_line = response.split(b"\r\n", 1)[0].decode(errors="replace")
        if " 101 " not in status_line:
            result["error"] = f"handshake rejected: {status_line}"
            return result

        item = {
            "type": "conversation.item.create",
            "item": {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": prompt}],
            },
        }
        sock.sendall(_ws_frame(0x1, json.dumps(item).encode()))
        sock.sendall(_ws_frame(0x1, b'{"type":"response.create"}'))

        deadline = time.monotonic() + timeout_s
        fragments: list[bytes] = []
        while time.monotonic() < deadline:
            try:
                opcode, payload = _ws_read_frame(sock)
            except socket.timeout:
                result["error"] = "timeout waiting for response events"
                break
            if opcode == 0x8:  # close
                result["error"] = result["error"] or "socket closed by server"
                break
            if opcode == 0x9:  # ping -> pong
                sock.sendall(_ws_frame(0xA, payload))
                continue
            if opcode not in (0x0, 0x1):
                continue
            fragments.append(payload)
            if opcode == 0x1 and fragments:
                text = b"".join(fragments).decode(errors="replace")
                fragments = []
                try:
                    event = json.loads(text)
                except ValueError:
                    continue
                event_type = event.get("type", "")
                if event_type in ("response.output_audio_transcript.delta", "response.audio_transcript.delta"):
                    result["text"] += event.get("delta", "")
                elif event_type in ("response.output_audio_transcript.done", "response.audio_transcript.done"):
                    done_text = event.get("transcript")
                    if done_text:
                        result["text"] = done_text
                    result["ok"] = bool(result["text"].strip())
                    result["error"] = "" if result["ok"] else "empty transcript"
                    return result
                elif event_type == "response.output_item.done":
                    # Final fallback: the completed item carries the transcript.
                    for content in (event.get("item") or {}).get("content", []) or []:
                        if isinstance(content, dict) and content.get("transcript"):
                            result["text"] = content["transcript"]
                elif event_type == "error":
                    result["error"] = json.dumps(event.get("error", event))[:300]
                    return result
                elif event_type in ("response.done", "response.completed", "response.failed"):
                    result["ok"] = bool(result["text"].strip())
                    result["error"] = "" if result["ok"] else f"{event_type} without transcript"
                    return result
        result["error"] = result["error"] or "no terminal event before timeout"
        return result
    except (OSError, ConnectionError, struct.error) as error:
        result["error"] = str(error)[:300]
        return result
    finally:
        try:
            sock.close()
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Controller
# ---------------------------------------------------------------------------

class BrainFailover:
    def __init__(
        self,
        config: dict[str, Any],
        probe_impl: Optional[Callable[[], dict[str, Any]]] = None,
    ) -> None:
        self.cfg = config
        self.home = Path(os.environ.get("HERMES_BRAIN_FAILOVER_HOME", str(DEFAULT_HOME)))
        self.state_path = self.home / "state.json"
        self.episodes_path = self.home / "episodes.jsonl"
        self.s2s_env_path = Path(self.cfg["s2s"]["env_file"] or (self.home / "s2s-brain.env"))
        self.status_path = Path(self.cfg["status_file"])
        self.dry_run = bool(self.cfg.get("dry_run"))
        self.probe_impl = probe_impl or self._probe_primary_http
        self.state = self._load_state()
        self._flap_alerted_episode: str | None = None

    # -- state persistence ---------------------------------------------------

    def _load_state(self) -> dict[str, Any]:
        if self.state_path.is_file():
            try:
                state = json.loads(self.state_path.read_text(encoding="utf-8"))
                if isinstance(state, dict) and state.get("version") == STATE_VERSION:
                    state.setdefault("actions", {})
                    state.setdefault("consecutive_failures", 0)
                    state.setdefault("consecutive_oks", 0)
                    state.setdefault("history", [])
                    return state
                log.warning("state.json has unsupported version/content; reinitializing")
            except ValueError as error:
                log.warning("state.json unreadable (%s); reinitializing", error)
        return self._initial_state()

    def _initial_state(self) -> dict[str, Any]:
        now = utcnow()
        return {
            "version": STATE_VERSION,
            "state": "up",
            "since": iso(now),
            "episode_id": "",
            "consecutive_failures": 0,
            "consecutive_oks": 0,
            "last_probe": None,
            "actions": {},
            "diag": None,
            "history": [],
            "controller_started": iso(now),
        }

    def _save_state(self) -> None:
        atomic_write_json(self.state_path, self.state)

    # -- env plumbing ----------------------------------------------------------

    def _hermes_env(self) -> dict[str, str]:
        return parse_env_file(Path(self.cfg["hermes_env_file"]))

    def brain_values(self, kind: str) -> dict[str, str]:
        if kind == "primary":
            primary = self.cfg["primary"]
            return {
                "HERMES_BRAIN_BASE_URL": primary["s2s_base_url"],
                "HERMES_BRAIN_API_KEY": primary.get("s2s_api", "") or primary.get("s2s_api_key", "none"),
                "HERMES_BRAIN_MODEL": primary["name"],
                "HERMES_BRAIN_REASONING_EFFORT": primary.get("reasoning_effort", ""),
            }
        env = self._hermes_env()
        fallback = self.cfg["fallback"]
        base_url = env.get(fallback["s2s_base_url_env"], "").rstrip("/")
        api_key = env.get(fallback["s2s_api_key_env"], "")
        if not base_url or not api_key:
            raise RuntimeError(
                f"fallback env incomplete: needs {fallback['s2s_base_url_env']} and "
                f"{fallback['s2s_api_key_env']} in {self.cfg['hermes_env_file']}"
            )
        return {
            "HERMES_BRAIN_BASE_URL": base_url,
            "HERMES_BRAIN_API_KEY": api_key,
            "HERMES_BRAIN_MODEL": fallback["name"],
            "HERMES_BRAIN_REASONING_EFFORT": fallback.get("reasoning_effort", ""),
        }

    def _write_s2s_env(self, kind: str, values: dict[str, str]) -> None:
        header = (
            "# Managed by hermes-brain-failover — do not edit by hand.\n"
            f"# Current voice brain: {kind} ({values['HERMES_BRAIN_MODEL']}) set {iso(utcnow())}\n"
            f"# Docs: {REPO_ROOT / 'docs' / 'brain-failover.md'}\n"
        )
        body = "\n".join(
            f'{key}="{value}"' for key, value in values.items() if value != "" or key == "HERMES_BRAIN_API_KEY"
        )
        if not values.get("HERMES_BRAIN_REASONING_EFFORT", ""):
            body += '\n# HERMES_BRAIN_REASONING_EFFORT unset (primary brain needs none)'
        atomic_write_text(self.s2s_env_path, header + body + "\n", mode=0o600)
        # The env file can carry the GLM key; keep it user-readable only.
        os.chmod(self.s2s_env_path, 0o600)

    def _read_s2s_env_brain(self) -> Optional[str]:
        """Which brain kind does the s2s env file currently select?"""
        if not self.s2s_env_path.is_file():
            return None
        text = self.s2s_env_path.read_text(encoding="utf-8")
        match = re.search(r"Current voice brain: (\w+)", text)
        return match.group(1) if match else None

    # -- probes ----------------------------------------------------------------

    def _probe_primary_http(self) -> dict[str, Any]:
        primary = self.cfg["primary"]
        try:
            status, payload = http_get_json(primary["models_url"], self.cfg["probe_timeout_s"])
            models = [m.get("id") for m in (payload or {}).get("data", []) if isinstance(m, dict)]
            ok = status == 200 and bool(models)
            return {"ok": ok, "detail": f"HTTP {status} models={models[:3]}"}
        except ConnectionError as error:
            return {"ok": False, "detail": f"conn: {str(error)[:120]}"}

    def probe_fallback(self) -> dict[str, Any]:
        env = self._hermes_env()
        fallback = self.cfg["fallback"]
        base_url = env.get(fallback["models_url_env"], "").rstrip("/")
        if not base_url:
            return {"ok": False, "detail": f"{fallback['models_url_env']} not set in {self.cfg['hermes_env_file']}"}
        try:
            status, payload = http_get_json(
                f"{base_url}/models",
                10.0,
                headers={"authorization": f"Bearer {env.get(fallback['s2s_api_key_env'], '')}"},
            )
            models = [m.get("id") for m in (payload or {}).get("data", []) if isinstance(m, dict)]
            wanted = fallback["name"]
            return {
                "ok": status == 200 and any(wanted in m for m in models),
                "detail": f"HTTP {status} models~{len(models)} has={wanted in models}",
            }
        except ConnectionError as error:
            return {"ok": False, "detail": f"conn: {str(error)[:120]}"}

    # -- status mirror for the UI -----------------------------------------------

    def _current_brain_view(self) -> dict[str, Any]:
        kind = "failover" if self.state["state"] == "down" else "primary"
        name = self.cfg["fallback"]["name"] if kind == "failover" else self.cfg["primary"]["name"]
        return kind, name

    def write_status_file(self) -> None:
        kind, name = self._current_brain_view()
        diag = self.state.get("diag") or {}
        payload = {
            "state": self.state["state"],
            "brain": name,
            "kind": kind,
            "since": self.state["since"],
            "ts": iso(utcnow()),
            "episodeId": self.state.get("episode_id") or None,
            "diag": {"pane": diag.get("pane"), "agent": diag.get("agent")} if diag else None,
        }
        try:
            atomic_write_json(self.status_path, payload)
        except OSError as error:
            log.warning("could not write status file %s: %s", self.status_path, error)

    # -- actions (each idempotent, journaled in state["actions"]) ----------------

    def _action(self, name: str) -> dict[str, Any]:
        return self.state["actions"].setdefault(name, {"status": "pending"})

    def _mark(self, name: str, **fields: Any) -> None:
        entry = self._action(name)
        entry.update(fields)
        entry["status"] = "done"
        self._save_state()

    def apply_brain(self, kind: str, verify_text_probe: bool = False) -> dict[str, Any]:
        """Point hermes-s2s at `kind` brain. Idempotent: restarts only when the
        env file content actually changes or the service is not healthy."""
        s2s = self.cfg["s2s"]
        values = self.brain_values(kind)
        safe = {k: (v if k != "HERMES_BRAIN_API_KEY" else f"<{len(v)} chars>") for k, v in values.items()}
        if self.dry_run:
            log.info("[dry-run] would write %s and restart %s: %s", self.s2s_env_path, s2s["unit"], safe)
            return {"changed": True, "verified": True, "text_probe": None, "dry_run": True}
        current = self._read_s2s_env_brain()
        changed = current != kind
        if changed:
            self._write_s2s_env(kind, values)
            log.info("s2s brain env -> %s (%s)", kind, values["HERMES_BRAIN_MODEL"])
        else:
            log.info("s2s brain env already %s; checking service health", kind)
        service_ok = False
        try:
            proc = _systemctl("is-active", s2s["unit"])
            service_ok = proc.stdout.strip() == "active"
        except CommandError as error:
            log.warning("systemctl is-active failed: %s", error)
        needs_restart = changed or not service_ok
        if needs_restart:
            log.info("restarting %s (changed=%s active=%s)", s2s["unit"], changed, service_ok)
            _systemctl("restart", s2s["unit"])
        deadline = time.monotonic() + s2s["verify_timeout_s"]
        listening = False
        while time.monotonic() < deadline:
            if ws_listening(s2s["ws_host"], s2s["ws_port"]):
                listening = True
                break
            time.sleep(2)
        if not listening:
            log.error("s2s websocket %s:%s not listening after %.0fs", s2s["ws_host"], s2s["ws_port"], s2s["verify_timeout_s"])
        proc_uses = self._s2s_process_uses(values["HERMES_BRAIN_BASE_URL"])
        text_probe: Optional[dict[str, Any]] = None
        if verify_text_probe and s2s.get("text_probe") and listening:
            text_probe = realtime_text_turn(
                s2s["ws_host"],
                s2s["ws_port"],
                s2s["ws_path"],
                "Reply with exactly: FAILOVER OK",
                s2s.get("text_probe_timeout_s", 60.0),
            )
            log.info("post-switch text probe: ok=%s text=%r error=%s",
                     text_probe["ok"], text_probe["text"][:80], text_probe["error"])
        verified = listening and proc_uses
        return {
            "changed": needs_restart,
            "verified": verified,
            "ws_listening": listening,
            "process_uses_brain": proc_uses,
            "text_probe": text_probe,
        }

    def _s2s_process_uses(self, base_url: str) -> bool:
        """True when the running speech-to-speech process argv carries the
        expected brain base URL (proves the switch reached the live process)."""
        needle = base_url.rstrip("/")
        for proc_dir in Path("/proc").iterdir():
            if not proc_dir.name.isdigit():
                continue
            try:
                argv = (proc_dir / "cmdline").read_bytes().split(b"\0")
            except OSError:
                continue
            argv_str = b" ".join(argv).decode(errors="replace")
            if "speech-to-speech" in argv_str or "speech_to_speech" in argv_str:
                return needle in argv_str
        return False

    def notify(self, text: str, action_name: str) -> Optional[int]:
        """Send the Telegram notification; returns message_id when delivered."""
        banner = str(self.cfg.get("notification_banner", ""))
        if banner:
            text = banner + text
        if self.dry_run:
            log.info("[dry-run] telegram message not sent:\n%s", text)
            self._mark(action_name, at=iso(utcnow()), message_id=None, dry_run=True)
            return None
        tg = self.cfg["telegram"]
        if not tg.get("enabled"):
            log.info("telegram disabled; message not sent:\n%s", text)
            self._mark(action_name, at=iso(utcnow()), message_id=None, disabled=True)
            return None
        env = self._hermes_env()
        token = env.get(tg["bot_token_env"], "")
        chat_id = env.get(tg["chat_id_env"], "")
        if not token or not chat_id:
            log.error("telegram env incomplete (%s/%s); cannot notify", tg["bot_token_env"], tg["chat_id_env"])
            self._mark(action_name, at=iso(utcnow()), message_id=None, error="missing env")
            return None
        payload: dict[str, Any] = {"chat_id": chat_id, "text": text, "disable_notification": False}
        thread = env.get(tg.get("thread_id_env", ""), "")
        if thread.strip().isdigit():
            payload["message_thread_id"] = int(thread.strip())
        body = json.dumps(payload).encode()
        last_error = ""
        for attempt in range(1, tg.get("retries", 3) + 1):
            request = urllib.request.Request(
                f"{tg['api']}/bot{token}/sendMessage",
                data=body,
                headers={"content-type": "application/json"},
            )
            try:
                with urllib.request.urlopen(request, timeout=15) as response:
                    result = json.loads(response.read())
                if result.get("ok") and result.get("result", {}).get("message_id"):
                    message_id = result["result"]["message_id"]
                    log.info("telegram delivered to chat %s: message_id=%s", chat_id, message_id)
                    self._mark(action_name, at=iso(utcnow()), message_id=message_id)
                    return message_id
                last_error = json.dumps(result)[:200]
            except (urllib.error.URLError, OSError, ValueError) as error:
                last_error = str(error)[:200]
            log.warning("telegram attempt %d failed: %s", attempt, last_error)
            time.sleep(min(2 ** attempt, 10))
        self._mark(action_name, at=iso(utcnow()), message_id=None, error=last_error)
        return None

    def spawn_diag(self, episode_id: str) -> dict[str, Any]:
        """Create the herdr workspace + claude agent that diagnoses/recovers :30000."""
        herdr = self.cfg["herdr"]
        suffix = episode_id.split("-", 1)[-1] if "-" in episode_id else episode_id
        suffix = re.sub(r"[^a-z0-9]+", "", suffix.lower())[:12] or "adhoc"
        label = f"{herdr['label_prefix']}-{suffix}"
        agent_name = f"{herdr['agent_prefix']}-{suffix}"
        if self.dry_run:
            log.info("[dry-run] would spawn herdr diag workspace=%s agent=%s cwd=%s", label, agent_name, herdr["cwd"])
            self.state["diag"] = {"workspace": label, "pane": "dry-run", "agent": agent_name, "label": label}
            self._mark("spawn_diag", at=iso(utcnow()), dry_run=True)
            return self.state["diag"]
        brief_path = Path(self.cfg["diag_brief"])
        brief = brief_path.read_text(encoding="utf-8")
        created = run_command(
            [herdr["bin"], "workspace", "create", "--cwd", herdr["cwd"], "--label", label, "--no-focus"],
            timeout=60,
        )
        info = json.loads(created.stdout)
        result = info.get("result", {})
        pane = result.get("root_pane", {}).get("pane_id", "")
        workspace = result.get("workspace", {}).get("workspace_id", "")
        if not pane:
            raise CommandError(f"herdr workspace create returned no pane: {created.stdout[:200]}")
        log.info("herdr diag workspace %s pane %s", workspace, pane)
        run_command(
            [
                herdr["bin"], "agent", "start", agent_name,
                "--kind", herdr["agent_kind"],
                "--pane", pane,
                "--timeout", str(herdr["start_timeout_ms"]),
                "--", "--dangerously-skip-permissions",
            ],
            timeout=herdr["start_timeout_ms"] / 1000 + 30,
        )
        log.info("herdr diag agent %s started in %s", agent_name, pane)
        # Long prompt: herdr agent prompt takes the text as one argv element.
        run_command([herdr["bin"], "agent", "prompt", pane, brief], timeout=60, check=False)
        self.state["diag"] = {
            "workspace": workspace,
            "pane": pane,
            "agent": agent_name,
            "label": label,
            "spawned_at": iso(utcnow()),
        }
        self._mark("spawn_diag", at=iso(utcnow()), pane=pane, agent=agent_name, workspace=workspace)
        return self.state["diag"]

    def collect_diag_outcome(self) -> dict[str, Any]:
        """Read the diag agent's pane tail and parse the markers the brief asks
        for (DIAG-RESULT / DIAG-SUMMARY / DIAG-CAUSE)."""
        diag = self.state.get("diag") or {}
        pane = diag.get("pane", "")
        outcome: dict[str, Any] = {"pane": pane, "result": "unknown", "summary": "", "cause": ""}
        if not pane or pane == "dry-run":
            outcome["result"] = "dry-run"
            return outcome
        if self.dry_run:
            outcome["result"] = "dry-run"
            return outcome
        try:
            proc = run_command(
                [self.cfg["herdr"]["bin"], "pane", "read", pane, "--lines", "400", "--format", "text"],
                timeout=30, check=False,
            )
            text = proc.stdout
        except CommandError as error:
            outcome["summary"] = f"pane read failed: {str(error)[:120]}"
            return outcome
        def marker(name: str) -> str:
            # Take the LAST occurrence (agent may restate the marker in prose).
            matches = re.findall(rf"{name}:\s*(.+)", text)
            return matches[-1].strip().strip("`*")[:200] if matches else ""
        outcome["result"] = marker("DIAG-RESULT") or "unknown"
        outcome["summary"] = marker("DIAG-SUMMARY")
        outcome["cause"] = marker("DIAG-CAUSE")
        return outcome

    # -- transitions --------------------------------------------------------------

    def _new_episode_id(self) -> str:
        return "ep-" + utcnow().strftime("%Y%m%d-%H%M%S")

    def transition_down(self) -> None:
        now = utcnow()
        episode = self._new_episode_id()
        self.state.update({
            "state": "down",
            "since": iso(now),
            "episode_id": episode,
            "actions": {},
            "diag": None,
            "last_down_transition": iso(now),
        })
        history = self.state.setdefault("history", [])
        history.append({"episode": episode, "down_at": iso(now)})
        self._save_state()
        log.warning("BRAIN DOWN detected at %s (episode %s) — failing over", local_ts(now), episode)
        self.write_status_file()

        fallback_probe = self.probe_fallback()
        log.info("fallback probe: %s", fallback_probe)

        switch = None
        try:
            switch = self.apply_brain("failover", verify_text_probe=True)
            self._mark("s2s_failover",
                       at=iso(utcnow()),
                       verified=switch.get("verified"),
                       text_probe_ok=(switch.get("text_probe") or {}).get("ok"))
        except Exception as error:  # noqa: BLE001 — journal and retry next tick
            log.error("s2s failover switch failed (will retry): %s", error)

        voice_status = "switched"
        if switch is None:
            voice_status = "switch pending (retrying)"
        elif not switch.get("verified"):
            voice_status = "switched but NOT verified"
        probe_line = ""
        if switch and switch.get("text_probe"):
            probe_line = "\n- Voice check on GLM: " + ("OK — " + switch["text_probe"]["text"][:60]
                         if switch["text_probe"].get("ok")
                         else "no answer yet (" + switch["text_probe"].get("error", "")[:60] + ")")
        diag_line = ""
        try:
            diag = self.spawn_diag(episode)
            diag_line = f"\n- Diagnosis task started (herdr pane {diag.get('pane')}); it will run `docker start qwen38-tuned` and verify."
        except Exception as error:  # noqa: BLE001
            log.error("herdr diag spawn failed (will retry next tick): %s", error)
            diag_line = "\n- Diagnosis task: spawn failed, retrying."

        fallback_note = "" if fallback_probe["ok"] else f"\n- WARNING: GLM fallback probe failed ({fallback_probe['detail']}) — voice may stay offline."
        message = (
            "⚠️ Hermes brain failover\n\n"
            f"The main model {self.cfg['primary']['name']} (sglang :30000) looks DOWN "
            f"(detected {local_ts(now)} after {self.cfg['down_after']} failed probes).\n"
            f"- Voice brain: {voice_status} to GLM {self.cfg['fallback']['name']}.{probe_line}"
            "\n- Chat gateway: fails over per-run to GLM (hermes native fallback chain)."
            f"{diag_line}{fallback_note}\n\n"
            "You will get another message when the main model is back."
        )
        try:
            self.notify(message, "notify_down")
        except Exception as error:  # noqa: BLE001
            log.error("down notification failed: %s", error)
        self.write_status_file()
        self._check_flapping()

    def transition_up(self) -> None:
        now = utcnow()
        episode = self.state.get("episode_id", "")
        down_since = self.state.get("since", "")
        duration = ""
        if down_since:
            try:
                started = datetime.fromisoformat(down_since)
                duration = human_duration((now - started).total_seconds())
            except ValueError:
                pass
        self.state.update({
            "state": "up",
            "since": iso(now),
            "last_up_transition": iso(now),
        })
        self._save_state()
        log.warning("BRAIN RECOVERED at %s (episode %s, down %s) — restoring primary", local_ts(now), episode, duration)
        self.write_status_file()

        switch = None
        try:
            switch = self.apply_brain("primary")
            self._mark("s2s_restore", at=iso(utcnow()), verified=switch.get("verified"))
        except Exception as error:  # noqa: BLE001
            log.error("s2s restore switch failed (will retry): %s", error)

        outcome = self.collect_diag_outcome()
        log.info("diag outcome for %s: %s", episode, outcome)
        # The diag agent often finishes AFTER the brain comes back (outages can
        # end faster than the inspection). Keep watching its pane for the
        # markers and journal a correction when they land.
        if outcome.get("result") in ("unknown", "") and outcome.get("pane") not in ("", None, "dry-run"):
            self.state["diag_watch"] = {
                "pane": outcome["pane"],
                "episode": episode,
                "until_ts": time.time() + 30 * 60,
                "next_check_ts": time.time() + 30,
            }
            self._save_state()
            log.info("diag outcome pending; watching pane %s for up to 30 min", outcome["pane"])

        voice_status = "switched back"
        if switch is None:
            voice_status = "restore pending (retrying)"
        elif not switch.get("verified"):
            voice_status = "switched back but NOT verified"
        diag_line = ""
        if outcome.get("result") not in ("unknown", ""):
            diag_line = (f"\n- Diagnosis: {outcome['result']}"
                         + (f" — {outcome['summary']}" if outcome.get("summary") else "")
                         + (f"\n- Cause: {outcome['cause']}" if outcome.get("cause") else ""))
        message = (
            "✅ Hermes main brain restored\n\n"
            f"{self.cfg['primary']['name']} (sglang :30000) is answering again "
            f"(recovered {local_ts(now)}; was down {duration or 'unknown'}).\n"
            f"- Voice brain: {voice_status} to the primary.\n"
            "- Chat gateway: new runs use the primary again automatically."
            f"{diag_line}"
        )
        try:
            self.notify(message, "notify_up")
        except Exception as error:  # noqa: BLE001
            log.error("up notification failed: %s", error)

        record = {
            "episode": episode,
            "detected_at": down_since,
            "restored_at": iso(now),
            "duration": duration,
            "actions": self.state.get("actions", {}),
            "diag": outcome,
            "closed_at": iso(utcnow()),
        }
        try:
            with open(self.episodes_path, "a", encoding="utf-8") as handle:
                handle.write(json.dumps(record) + "\n")
        except OSError as error:
            log.warning("could not append episode log: %s", error)
        self.state["episode_id"] = ""
        self.state["actions"] = {}
        self.state["diag"] = None
        self._save_state()
        self.write_status_file()

    def _check_flapping(self) -> None:
        window = self.cfg["flap_window_s"]
        cutoff = utcnow().timestamp() - window
        recent = []
        for entry in self.state.get("history", []):
            try:
                if datetime.fromisoformat(entry["down_at"]).timestamp() >= cutoff:
                    recent.append(entry)
            except (KeyError, ValueError):
                continue
        if len(recent) >= self.cfg["flap_alert_after"] and self._flap_alerted_episode != recent[-1].get("episode"):
            self._flap_alerted_episode = recent[-1].get("episode")
            log.error("FLAPPING: %d down-transitions in the last %dmin", len(recent), window // 60)
            self.notify(
                f"⚠️ Hermes brain is flapping: {len(recent)} outages in {window // 60} min. "
                "Check the sglang container / dflash worker (docs/brain-failover.md).",
                "notify_flap",
            )

    # -- main loop -----------------------------------------------------------------

    def poll_command_file(self) -> None:
        """Manual transitions go through <home>/command.json so the RUNNING
        service stays the single writer of state.json (a CLI force-* while the
        service is up would otherwise be clobbered on its next tick)."""
        path = self.home / "command.json"
        try:
            raw = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return
        except OSError:
            return
        try:
            command = json.loads(raw)
        except ValueError:
            log.warning("command.json unreadable; ignoring")
            return
        # Consume first: never execute the same command twice, even on crash.
        try:
            path.unlink()
        except OSError:
            pass
        name = command.get("command")
        log.info("command file: %s (id=%s)", name, command.get("id"))
        if command.get("banner"):
            self.cfg["notification_banner"] = str(command["banner"])
        if name == "force_down" and self.state["state"] == "up":
            self.transition_down()
        elif name == "force_up" and self.state["state"] == "down":
            self.transition_up()
        elif name == "reconcile":
            self.reconcile()
        else:
            log.warning("command file: nothing to do for %r in state %s", name, self.state["state"])

    def _watch_diag_outcome(self) -> None:
        """Re-read a still-quiet diag pane until its markers land (or 30 min)."""
        watch = self.state.get("diag_watch")
        if not watch:
            return
        now_ts = time.time()
        if now_ts < watch.get("next_check_ts", 0):
            return
        if now_ts > watch.get("until_ts", 0):
            log.info("diag watch for %s expired without markers", watch.get("episode"))
            self.state["diag_watch"] = None
            return
        watch["next_check_ts"] = now_ts + 30
        try:
            proc = run_command(
                [self.cfg["herdr"]["bin"], "pane", "read", watch["pane"], "--lines", "400", "--format", "text"],
                timeout=30, check=False,
            )
            text = proc.stdout
        except CommandError:
            # Pane/workspace may be gone; stop watching.
            self.state["diag_watch"] = None
            return
        def marker(name: str) -> str:
            matches = re.findall(rf"{name}:\s*(.+)", text)
            return matches[-1].strip().strip("`*")[:200] if matches else ""
        result = marker("DIAG-RESULT")
        if not result:
            return
        outcome = {"pane": watch["pane"], "result": result, "summary": marker("DIAG-SUMMARY"), "cause": marker("DIAG-CAUSE")}
        log.info("diag outcome (late) for %s: %s", watch.get("episode"), outcome)
        try:
            with open(self.episodes_path, "a", encoding="utf-8") as handle:
                handle.write(json.dumps({
                    "episode": watch.get("episode"),
                    "diag_update": outcome,
                    "at": iso(utcnow()),
                }) + "\n")
        except OSError as error:
            log.warning("could not append diag correction: %s", error)
        self.state["diag_watch"] = None

    def reconcile(self) -> None:
        """Adopt whatever the s2s env file says after a controller restart."""
        env_brain = self._read_s2s_env_brain()
        state_brain = "failover" if self.state["state"] == "down" else "primary"
        if env_brain is not None and env_brain != state_brain:
            log.warning("reconcile: state=%s but s2s env says %s — re-applying %s",
                        self.state["state"], env_brain, state_brain)
            try:
                self.apply_brain(state_brain)
            except Exception as error:  # noqa: BLE001
                log.error("reconcile re-apply failed (will keep trying via transitions): %s", error)
        # Warn (once per start) when the gateway-side fallback chain is missing.
        gateway_cfg = Path(self.cfg["gateway_config"])
        marker = self.cfg["gateway_fallback_block"]
        try:
            has_fallback = marker in gateway_cfg.read_text(encoding="utf-8")
        except OSError:
            has_fallback = False
        if not has_fallback:
            log.warning(
                "gateway config %s has no '%s' block — chat turns will NOT fail over. "
                "Run tools/brain-failover/install.sh (see docs/brain-failover.md).",
                gateway_cfg, marker,
            )
        self.write_status_file()

    def tick(self) -> None:
        self.poll_command_file()
        self._watch_diag_outcome()
        probe = self.probe_impl()
        self.state["last_probe"] = {"ok": probe["ok"], "detail": probe["detail"], "at": iso(utcnow())}
        if probe["ok"]:
            self.state["consecutive_failures"] = 0
            self.state["consecutive_oks"] += 1
        else:
            self.state["consecutive_oks"] = 0
            self.state["consecutive_failures"] += 1
        if probe["ok"]:
            log.debug("probe ok (%s) oks=%d state=%s", probe["detail"],
                      self.state["consecutive_oks"], self.state["state"])
        else:
            # Visible in the journal while an outage builds up toward the
            # down_after threshold (ok probes stay debug-quiet).
            log.info("probe FAILED (%s) fails=%d/%d state=%s", probe["detail"],
                     self.state["consecutive_failures"], self.cfg["down_after"], self.state["state"])
        if self.state["state"] == "up" and self.state["consecutive_failures"] >= self.cfg["down_after"]:
            self.transition_down()
        elif self.state["state"] == "down":
            min_down_elapsed = True
            try:
                min_down_elapsed = (utcnow() - datetime.fromisoformat(self.state["since"])).total_seconds() >= self.cfg["min_down_s"]
            except ValueError:
                pass
            if (self.state["consecutive_oks"] >= self.cfg["up_after"] and min_down_elapsed):
                self.transition_up()
            else:
                # Finish any pending down-actions from a partially failed switch.
                pending = [name for name, entry in self.state.get("actions", {}).items() if entry.get("status") != "done"]
                if pending:
                    log.info("retrying pending down-actions: %s", pending)
                    if "s2s_failover" in pending:
                        try:
                            switch = self.apply_brain("failover", verify_text_probe=True)
                            self._mark("s2s_failover", at=iso(utcnow()), verified=switch.get("verified"))
                        except Exception as error:  # noqa: BLE001
                            log.error("s2s failover retry failed: %s", error)
                    if "spawn_diag" in pending:
                        try:
                            self.spawn_diag(self.state.get("episode_id") or self._new_episode_id())
                        except Exception as error:  # noqa: BLE001
                            log.error("diag spawn retry failed: %s", error)
                    if "notify_down" in pending and "s2s_failover" not in pending:
                        self.notify("⚠️ Hermes brain still down; failover actions retried.", "notify_down")
        self._save_state()
        self.write_status_file()

    def serve(self) -> None:
        log.info(
            "hermes-brain-failover serving: probe %ss timeout %ss, down_after=%d up_after=%d min_down=%ds dry_run=%s",
            self.cfg["probe_interval_s"], self.cfg["probe_timeout_s"], self.cfg["down_after"],
            self.cfg["up_after"], self.cfg["min_down_s"], self.dry_run,
        )
        self.reconcile()
        while True:
            started = time.monotonic()
            try:
                self.tick()
            except Exception as error:  # noqa: BLE001 — a tick must never kill the daemon
                log.exception("tick failed (continuing): %s", error)
            elapsed = time.monotonic() - started
            time.sleep(max(1.0, self.cfg["probe_interval_s"] - elapsed))


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def load_config(home: Path, overrides: dict[str, Any]) -> dict[str, Any]:
    config = dict(DEFAULTS)
    config_file = home / "config.json"
    if config_file.is_file():
        try:
            config = deep_merge(config, json.loads(config_file.read_text(encoding="utf-8")))
        except ValueError as error:
            log.warning("config.json unreadable (%s); using defaults", error)
    if overrides:
        config = deep_merge(config, overrides)
    if not config["s2s"].get("env_file"):
        config["s2s"]["env_file"] = str(home / "s2s-brain.env")
    return config


def setup_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S%z",
    )


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="hermes brain failover controller")
    parser.add_argument("--home", default=str(Path(os.environ.get("HERMES_BRAIN_FAILOVER_HOME", DEFAULT_HOME))))
    parser.add_argument("--dry-run", action="store_true", help="log actions instead of performing them")
    parser.add_argument("--verbose", action="store_true")
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("serve", help="run the watchdog loop (default)")
    sub.add_parser("probe", help="probe primary + fallback once and print")
    sub.add_parser("status", help="print current state")
    sub.add_parser("verify", help="component checks (probes, env, s2s service, gateway config)")
    sub.add_parser("force-down", help="perform the DOWN transition now (manual test)")
    sub.add_parser("force-up", help="perform the UP transition now (manual test)")
    args = parser.parse_args(argv)
    setup_logging(args.verbose)
    home = Path(args.home)
    overrides: dict[str, Any] = {}
    if args.dry_run:
        overrides["dry_run"] = True
    controller = BrainFailover(load_config(home, overrides))
    command = args.command or "serve"
    if command == "serve":
        controller.serve()
        return 0
    if command == "probe":
        primary = controller._probe_primary_http()
        fallback = controller.probe_fallback()
        print(json.dumps({"primary": primary, "fallback": fallback}, indent=2))
        return 0 if primary["ok"] else 1
    if command == "status":
        print(json.dumps(controller.state, indent=2))
        return 0
    if command == "verify":
        ok = True
        primary = controller._probe_primary_http()
        fallback = controller.probe_fallback()
        print(f"primary probe : {'OK' if primary['ok'] else 'FAIL'} ({primary['detail']})")
        print(f"fallback probe: {'OK' if fallback['ok'] else 'FAIL'} ({fallback['detail']})")
        ok = ok and primary["ok"] and fallback["ok"]
        env_brain = controller._read_s2s_env_brain()
        print(f"s2s env file  : {controller.s2s_env_path} -> {env_brain or '(none)'}")
        s2s = controller.cfg["s2s"]
        try:
            active = run_command(["systemctl", "--user", "is-active", s2s["unit"]]).stdout.strip()
        except CommandError:
            active = "unknown"
        print(f"s2s service   : {active}; ws :{s2s['ws_port']} listening={ws_listening(s2s['ws_host'], s2s['ws_port'])}")
        ok = ok and active == "active"
        try:
            gateway_has = controller.cfg["gateway_fallback_block"] in Path(controller.cfg["gateway_config"]).read_text(encoding="utf-8")
        except OSError:
            gateway_has = False
        print(f"gateway chain : {'configured' if gateway_has else 'MISSING (run install.sh)'}")
        ok = ok and gateway_has
        print(f"state         : {controller.state['state']} since {controller.state['since']}")
        print("overall       : " + ("OK" if ok else "DEGRADED"))
        return 0 if ok else 1
    if command in ("force-down", "force-up"):
        wanted = "down" if command == "force-down" else "up"
        banner = (
            "🧪 MANUAL TEST (force-down; the primary brain is actually UP).\n\n"
            if command == "force-down" else
            "🧪 MANUAL TEST (force-up).\n\n"
        )
        if controller.state["state"] == wanted:
            print(f"already {wanted}")
            return 1
        # Single-writer rule: when the service is running, IT must perform the
        # transition (its next tick would otherwise clobber a CLI-written
        # state.json). Hand over via command.json and wait for the flip.
        service_active = False
        try:
            service_active = run_command(
                ["systemctl", "--user", "is-active", "hermes-brain-failover.service"],
                timeout=15,
            ).stdout.strip() == "active"
        except CommandError:
            service_active = False
        if service_active:
            command_id = f"cmd-{utcnow().strftime('%H%M%S')}"
            atomic_write_json(home / "command.json", {"command": command.replace("-", "_"), "id": command_id, "banner": banner})
            print(f"handed '{command}' to the running service ({command_id}); waiting for the transition…")
            deadline = time.monotonic() + 180
            while time.monotonic() < deadline:
                time.sleep(2)
                state = BrainFailover(load_config(home, overrides)).state
                if state["state"] == wanted:
                    print(f"transition to {wanted} complete (episode {state.get('episode_id')}).")
                    print("Watch: journalctl --user -u hermes-brain-failover -f")
                    return 0
            print("service did not transition in time — check journalctl --user -u hermes-brain-failover", file=sys.stderr)
            return 1
        controller.cfg["notification_banner"] = banner
        if command == "force-down":
            controller.transition_down()
        else:
            controller.transition_up()
        return 0
    parser.error(f"unknown command {command}")
    return 2


if __name__ == "__main__":
    sys.exit(main())
