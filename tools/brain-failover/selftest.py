#!/usr/bin/env python3
"""Dry-run self-test for the brain-failover controller.

Proves the full state-machine path with scripted probe results and NO real
side effects: no service restarts, no notifications, no herdr spawns, no
network. Two layers:

  1. FSM layer — action performers replaced by recorders; asserts the exact
     transition + action order and the status-file contents the UI reads.
  2. dry-run layer — real action methods with dry_run=True, with subprocess /
     urlopen / systemctl booby-trapped to explode, proving the dry-run guards
     hold even in code paths that forgot to check.

Plus a codec round-trip for the minimal websocket framer used by the
post-failover text probe.

Exit code 0 = all passed. The last stdout line is a JSON summary
{"passed": N, "failed": N} for the vitest wrapper.
"""

from __future__ import annotations

import io
import json
import logging
import os
import sys
import tempfile
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import brain_failover as bf  # noqa: E402


PASS = 0
FAIL = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  ok   {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name} {detail}")


class RecordingController(bf.BrainFailover):
    """FSM layer: record every action instead of performing it."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.calls: list[tuple] = []

    def probe_fallback(self):
        return {"ok": True, "detail": "fake fallback probe"}

    def apply_brain(self, kind, verify_text_probe=False):
        self.calls.append(("apply_brain", kind))
        return {
            "changed": True,
            "verified": True,
            "ws_listening": True,
            "process_uses_brain": True,
            "text_probe": {"ok": True, "text": "FAILOVER OK", "error": ""},
        }

    def notify(self, text, action_name):
        self.calls.append(("notify", action_name, text))
        self._mark(action_name, at=bf.iso(bf.utcnow()), message_id=4242)
        return 4242

    def spawn_diag(self, episode_id):
        self.calls.append(("spawn_diag", episode_id))
        self.state["diag"] = {"workspace": "wT", "pane": "wT:p1", "agent": "bfdiag-test"}
        self._mark("spawn_diag", at=bf.iso(bf.utcnow()), pane="wT:p1")
        return self.state["diag"]

    def collect_diag_outcome(self):
        self.calls.append(("collect_diag_outcome",))
        return {"pane": "wT:p1", "result": "RECOVERED", "summary": "docker start; verified /v1/models", "cause": "dflash tensor-size crash"}


class ExplodingController(bf.BrainFailover):
    """Dry-run layer: real methods; any real-world escape hatch explodes."""

    def probe_fallback(self):
        return {"ok": True, "detail": "fake fallback probe (hermetic)"}


def make_config(home: Path, status: Path, dry_run: bool = False) -> dict:
    config = bf.deep_merge(bf.DEFAULTS, {
        "down_after": 3,
        "up_after": 3,
        "min_down_s": 0,
        "probe_interval_s": 0.01,
        "dry_run": dry_run,
        "s2s": {"env_file": str(home / "s2s-brain.env")},
        "status_file": str(status),
        "hermes_env_file": str(home / "fake-hermes.env"),
        "diag_brief": str(home / "diag-brief.md"),
        "gateway_config": str(home / "config.yaml"),
    })
    home.mkdir(parents=True, exist_ok=True)
    (home / "diag-brief.md").write_text("test brief\nDIAG markers here\n", encoding="utf-8")
    (home / "config.yaml").write_text("model:\n  default: qwen3.8-27b\n", encoding="utf-8")
    # Fake hermes env with a dummy GLM key so brain_values() resolves offline.
    (home / "fake-hermes.env").write_text(
        "GLM_BASE_URL=https://fake.invalid/api\nGLM_API_KEY=fake-key-for-selftest\n"
        "TELEGRAM_BOT_TOKEN=fake\nTELEGRAM_HOME_CHANNEL=1\n",
        encoding="utf-8",
    )
    return config


def fsm_layer(tmp: Path) -> None:
    print("layer 1: FSM transitions on scripted probes (recorder actions)")
    home = tmp / "fsm-home"
    status = tmp / "brain-status.json"
    os.environ["HERMES_BRAIN_FAILOVER_HOME"] = str(home)
    controller = RecordingController(make_config(home, status))

    def probe(ok: bool):
        return lambda: {"ok": ok, "detail": "scripted"}

    # UP and healthy.
    controller.probe_impl = probe(True)
    controller.tick()
    check("starts up", controller.state["state"] == "up")
    check("status file says primary brain",
          json.loads(status.read_text())["kind"] == "primary"
          and json.loads(status.read_text())["brain"] == "qwen3.8-27b")

    # Two failures: hysteresis must hold.
    controller.probe_impl = probe(False)
    controller.tick()
    controller.tick()
    check("2/3 failures do not trip failover", controller.state["state"] == "up")

    # Third failure: DOWN.
    controller.tick()
    check("3rd failure trips failover", controller.state["state"] == "down")
    down_status = json.loads(status.read_text())
    check("status file says failover brain",
          down_status["kind"] == "failover" and down_status["brain"] == "glm-5.2",
          str(down_status))
    kinds = [(call[0], call[1]) for call in controller.calls]
    check("s2s switched to fallback first", kinds[0] == ("apply_brain", "failover"), str(kinds))
    check("diag spawned before notify", kinds.index(("spawn_diag", controller.state["episode_id"])) < 3, str(kinds))
    check("down notification sent", ("notify", "notify_down") in kinds, str(kinds))
    check("notification mentions GLM fallback",
          any("GLM" in call[2] for call in controller.calls if call[0] == "notify" and call[1] == "notify_down"))
    check("notification mentions diagnosis task",
          any("iagnosis" in call[2] for call in controller.calls if call[0] == "notify" and call[1] == "notify_down"))
    check("down actions all done",
          all(entry.get("status") == "done" for entry in controller.state["actions"].values()),
          str(controller.state["actions"]))

    # Recovery: two oks are not enough (up_after=3).
    controller.probe_impl = probe(True)
    controller.tick()
    controller.tick()
    check("2/3 oks keep failover", controller.state["state"] == "down")

    controller.tick()
    check("3rd ok restores primary", controller.state["state"] == "up")
    up_status = json.loads(status.read_text())
    check("status file back to primary", up_status["kind"] == "primary", str(up_status))
    up_calls = [(call[0], call[1]) for call in controller.calls if call[0] == "apply_brain"]
    check("voice restored to primary", ("apply_brain", "primary") in up_calls, str(up_calls))
    check("up notification sent", any(call[0] == "notify" and call[1] == "notify_up" for call in controller.calls))
    check("up notification mentions recovery",
          any("restored" in call[2] for call in controller.calls if call[0] == "notify" and call[1] == "notify_up"))
    episodes = [json.loads(line) for line in (home / "episodes.jsonl").read_text().splitlines()]
    check("episode journaled once", len(episodes) == 1, str(len(episodes)))
    check("episode carries diag outcome",
          episodes[0]["diag"]["result"] == "RECOVERED" and "dflash" in episodes[0]["diag"]["cause"],
          str(episodes[0].get("diag")))

    # State survives a controller restart (new instance, same home).
    reborn = RecordingController(make_config(home, status))
    check("state survives restart", reborn.state["state"] == "up" and reborn.state["episode_id"] == "")


def dryrun_layer(tmp: Path) -> None:
    print("layer 2: dry-run mode performs no real side effects")
    home = tmp / "dry-home"
    status = tmp / "dry-brain-status.json"
    os.environ["HERMES_BRAIN_FAILOVER_HOME"] = str(home)
    config = make_config(home, status, dry_run=True)
    controller = ExplodingController(config)

    real_run = bf.run_command
    real_urlopen = urllib.request.urlopen

    def explode_run(argv, **kwargs):
        raise AssertionError(f"real subprocess in dry-run: {argv}")

    def explode_urlopen(*args, **kwargs):
        raise AssertionError(f"real HTTP in dry-run: {args}")

    bf.run_command = explode_run
    urllib.request.urlopen = explode_urlopen
    log_stream = io.StringIO()
    handler = logging.StreamHandler(log_stream)
    bf.log.addHandler(handler)
    bf.log.setLevel(logging.INFO)
    try:
        controller.probe_impl = lambda: {"ok": False, "detail": "scripted outage"}
        for _ in range(3):
            controller.tick()
        check("dry-run reaches DOWN state", controller.state["state"] == "down")
        controller.probe_impl = lambda: {"ok": True, "detail": "scripted recovery"}
        for _ in range(3):
            controller.tick()
        check("dry-run returns to UP state", controller.state["state"] == "up")
    finally:
        bf.run_command = real_run
        urllib.request.urlopen = real_urlopen
        bf.log.removeHandler(handler)

    check("no s2s env file written", not (home / "s2s-brain.env").exists())
    check("dry-run logged the would-be restart", "dry-run" in log_stream.getvalue().lower())
    check("dry-run logged the would-be telegram", "telegram message not sent" in log_stream.getvalue().lower()
          or "would spawn herdr" in log_stream.getvalue().lower())
    check("status file still tracks state", json.loads(status.read_text())["state"] == "up")


class FakeSock:
    def __init__(self, data: bytes):
        self.data = data

    def recv(self, count):
        chunk, self.data = self.data[:count], self.data[count:]
        return chunk


def ws_codec_layer() -> None:
    print("layer 3: websocket framer round-trip")
    payload = json.dumps({"type": "response.audio_transcript.delta", "delta": "héllo ✓"}).encode()
    frame = bf._ws_frame(0x1, payload)
    sock = FakeSock(frame)
    opcode, decoded = bf._ws_read_frame(sock)
    check("opcode round-trips", opcode == 0x1)
    check("payload round-trips (masked)", decoded == payload)
    long_payload = b"x" * 70_000
    sock = FakeSock(bf._ws_frame(0x2, long_payload))
    opcode, decoded = bf._ws_read_frame(sock)
    check("64-bit length frames round-trip", opcode == 0x2 and decoded == long_payload)
    sock = FakeSock(bf._ws_frame(0x9, b"ping"))
    opcode, decoded = bf._ws_read_frame(sock)
    check("control frames round-trip", opcode == 0x9 and decoded == b"ping")


def main() -> int:
    logging.basicConfig(level=logging.CRITICAL)
    with tempfile.TemporaryDirectory(prefix="brain-failover-selftest-") as tmp_name:
        tmp = Path(tmp_name)
        fsm_layer(tmp)
        dryrun_layer(tmp)
    ws_codec_layer()
    print(f"\nselftest summary: {PASS} passed, {FAIL} failed")
    print(json.dumps({"passed": PASS, "failed": FAIL}))
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
