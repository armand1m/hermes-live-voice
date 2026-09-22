#!/usr/bin/env python3
"""Analyze the LAYA shadow log (docs/laya-system1.md) — the Phase-1 go/no-go
evidence. Read-only; stdlib only (runs with system python3).

  python3 tools/laya-sidecar/analyze_shadow.py [--log PATH] [--json OUT]
                  [--labels PATH]

Reads ~/.hermes/hermes-live/laya-shadow/turns.jsonl (one row per turn, schema
in docs/laya-system1.md) and prints:

  - agreement matrix: LAYA route choice vs the brain's actual tool route
  - coverage + accuracy at confidence thresholds {0.70,0.80,0.85,0.90,0.95}
  - ECE per question bucket before/after a Platt (2-parameter) refit fitted
    on the logged (confidence, correct) pairs
  - read-only precision at P>=0.95 on turns that started tasks (needs
    --labels for ground truth; the log alone cannot prove read-only-ness)
  - p50/p95 layaLatencyMs (fresh calls only; cached rows excluded)

Brain route derivation from brain.toolCalls (first call wins):
  none                            -> answer_directly
  start_background_task, remember -> start_background_task
  continue_hermes_conversation,
  search_past_chats               -> continue_hermes_conversation
  list/get/stop/follow_up         -> task_control
  client-control tools            -> unmapped (excluded from agreement)
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
from collections import Counter
from pathlib import Path

DEFAULT_LOG = Path.home() / ".hermes" / "hermes-live" / "laya-shadow" / "turns.jsonl"
CONFIDENCE_THRESHOLDS = (0.70, 0.80, 0.85, 0.90, 0.95)
ECE_BINS = 10

ROUTE_FROM_TOOL = {
    "start_background_task": "start_background_task",
    "remember": "start_background_task",
    "continue_hermes_conversation": "continue_hermes_conversation",
    "search_past_chats": "continue_hermes_conversation",
    "list_background_tasks": "task_control",
    "get_background_task": "task_control",
    "stop_background_task": "task_control",
    "follow_up_background_task": "task_control",
}
ROUTE_CHOICES = ("answer_directly", "continue_hermes_conversation", "start_background_task", "task_control")


def brain_route(row: dict) -> str | None:
    calls = (row.get("brain") or {}).get("toolCalls") or []
    if not calls:
        return "answer_directly"
    return ROUTE_FROM_TOOL.get(str(calls[0].get("name", "")), "unmapped")


def load_rows(path: Path) -> tuple[list[dict], int]:
    rows: list[dict] = []
    skipped = 0
    if not path.exists():
        return rows, 0
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            skipped += 1
    return rows, skipped


def route_answer(row: dict) -> tuple[str, float] | None:
    answer = (row.get("answers") or {}).get("route")
    if not isinstance(answer, dict):
        return None
    choice, confidence = answer.get("choice"), answer.get("confidence")
    if not isinstance(choice, str) or not isinstance(confidence, (int, float)):
        return None
    return choice, float(confidence)


def agreement_matrix(joined: list[dict]) -> tuple[Counter, float, int]:
    matrix: Counter = Counter()
    agree = 0
    unmapped = 0
    for row in joined:
        pair = route_answer(row)
        route = brain_route(row)
        if pair is None or route is None:
            continue
        if route == "unmapped":
            unmapped += 1
            continue
        matrix[(pair[0], route)] += 1
        agree += int(pair[0] == route)
    classified = sum(matrix.values())
    return matrix, (agree / classified if classified else 0.0), unmapped


def coverage_accuracy(joined: list[dict]) -> list[dict]:
    pairs = []
    for row in joined:
        pair = route_answer(row)
        route = brain_route(row)
        if pair is None or route is None or route == "unmapped":
            continue
        pairs.append((pair[1], int(pair[0] == route)))
    table = []
    for threshold in CONFIDENCE_THRESHOLDS:
        covered = [(conf, correct) for conf, correct in pairs if conf >= threshold]
        table.append({
            "threshold": threshold,
            "covered": len(covered),
            "coverage": len(covered) / len(pairs) if pairs else None,
            "accuracy": (sum(c for _, c in covered) / len(covered)) if covered else None,
        })
    return table


def ece(pairs: list[tuple[float, int]]) -> float | None:
    if not pairs:
        return None
    total = len(pairs)
    acc = 0.0
    for bin_index in range(ECE_BINS):
        low, high = bin_index / ECE_BINS, (bin_index + 1) / ECE_BINS
        bucket = [p for p in pairs if (low <= p[0] < high) or (bin_index == ECE_BINS - 1 and p[0] == 1.0)]
        if not bucket:
            continue
        mean_conf = sum(p[0] for p in bucket) / len(bucket)
        mean_acc = sum(p[1] for p in bucket) / len(bucket)
        acc += len(bucket) / total * abs(mean_acc - mean_conf)
    return acc


def fit_platt(pairs: list[tuple[float, int]], iterations: int = 4000, lr: float = 0.05) -> tuple[float, float]:
    """Standard 2-parameter Platt fit on logged confidence (the temperature
    refit needs raw logits, which the shadow log does not keep)."""
    a, b = 1.0, 0.0
    n = len(pairs)
    for _ in range(iterations):
        grad_a = grad_b = 0.0
        for conf, correct in pairs:
            z = max(-30.0, min(30.0, a * conf + b))
            p = 1.0 / (1.0 + math.exp(-z))
            grad_a += (p - correct) * conf
            grad_b += p - correct
        grad_a = grad_a / n + 1e-3 * a
        grad_b = grad_b / n + 1e-3 * b
        a -= lr * grad_a
        b -= lr * grad_b
    return a, b


def calibration(rows: list[dict], labels: dict[str, dict]) -> list[dict]:
    buckets: dict[str, list[tuple[float, int]]] = {}
    notes: dict[str, str] = {}
    for row in rows:
        answers = row.get("answers") or {}
        route = brain_route(row)
        for name, answer in answers.items():
            if not isinstance(answer, dict):
                continue
            confidence = answer.get("confidence")
            if not isinstance(confidence, (int, float)):
                continue
            if name == "route":
                if route is None or route == "unmapped" or route_answer(row) is None:
                    continue
                buckets.setdefault("route", []).append((float(confidence), int(route_answer(row)[0] == route)))
            elif name == "trivial_chat":
                if not row.get("brain"):
                    continue
                # Noisy proxy label: the brain made no tool calls this turn.
                no_tools = not (row["brain"].get("toolCalls") or [])
                noul = answer.get("noul")
                buckets.setdefault("trivial_chat", []).append(
                    (float(confidence), int((noul or 0) >= 0.5) if no_tools else int((noul or 0) < 0.5)))
                notes["trivial_chat"] = "label is the noisy proxy 'brain made no tool calls'"
            elif name == "read_only":
                label = labels.get(str(row.get("utteranceHash", "")), {}).get("read_only")
                if label is None:
                    continue
                noul = answer.get("noul")
                buckets.setdefault("read_only", []).append(
                    (float(confidence), int(((noul or 0) >= 0.5) == bool(label))))
    report = []
    for name, pairs in sorted(buckets.items()):
        if len(pairs) < 10:
            report.append({"question": name, "n": len(pairs), "note": "too few pairs to refit (<10)"})
            continue
        a, b = fit_platt(pairs)
        calibrated = [(1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, a * conf + b)))), correct) for conf, correct in pairs]
        report.append({
            "question": name,
            "n": len(pairs),
            "ece_before": ece(pairs),
            "ece_after": ece(calibrated),
            "platt_a": a,
            "platt_b": b,
            **({"note": notes[name]} if name in notes else {}),
        })
    if "read_only" not in buckets:
        report.append({"question": "read_only", "n": 0, "note": "no ground truth — rerun with --labels (docs/laya-system1.md)"})
    return report


def read_only_precision(rows: list[dict], labels: dict[str, dict]) -> dict:
    flagged = []
    for row in rows:
        answer = (row.get("answers") or {}).get("read_only")
        brain = row.get("brain") or {}
        started = any(call.get("name") == "start_background_task" for call in brain.get("toolCalls") or [])
        if isinstance(answer, dict) and isinstance(answer.get("noul"), (int, float)) and answer["noul"] >= 0.95 and started:
            flagged.append(row)
    result: dict = {"flagged_p095_started_task": len(flagged)}
    labeled = [row for row in flagged if str(row.get("utteranceHash", "")) in labels]
    if labeled:
        correct = sum(
            1 for row in labeled
            if (labels[str(row["utteranceHash"])].get("read_only") is True)
        )
        result["labeled"] = len(labeled)
        result["precision"] = correct / len(labeled) if labeled else None
    else:
        result["note"] = "precision needs --labels ground truth; the log cannot prove read-only-ness"
    return result


def latency_summary(rows: list[dict]) -> dict:
    fresh = [row["layaLatencyMs"] for row in rows
             if isinstance(row.get("layaLatencyMs"), (int, float)) and not row.get("cached")]
    cached = sum(1 for row in rows if row.get("cached"))
    timeouts = sum(1 for row in rows if row.get("timeout"))
    unknown = sum(1 for row in rows if row.get("answers") is None)
    fresh.sort()
    if not fresh:
        return {"n": 0, "cached": cached, "timeouts": timeouts, "unknown_answers": unknown}
    return {
        "n": len(fresh),
        "p50_ms": statistics.median(fresh),
        "p95_ms": fresh[max(0, math.ceil(0.95 * len(fresh)) - 1)],
        "cached": cached,
        "timeouts": timeouts,
        "unknown_answers": unknown,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--log", type=Path, default=DEFAULT_LOG, help=f"shadow turns.jsonl (default {DEFAULT_LOG})")
    parser.add_argument("--json", type=Path, help="also write the full report as JSON to this path")
    parser.add_argument("--labels", type=Path, help="optional JSON: {utteranceHash: {read_only: bool}} ground truth")
    args = parser.parse_args()

    rows, skipped = load_rows(args.log)
    labels = json.loads(args.labels.read_text(encoding="utf-8")) if args.labels else {}
    joined = [row for row in rows if row.get("brain")]
    matrix, overall, unmapped = agreement_matrix(joined)
    report = {
        "log": str(args.log),
        "rows": len(rows),
        "rows_skipped_malformed": skipped,
        "rows_with_brain_outcome": len(joined),
        "route_agreement": {
            "overall": overall,
            "unmapped_tool_turns": unmapped,
            "matrix": {f"laya={laya} | brain={brain}": count for (laya, brain), count in sorted(matrix.items())},
        },
        "coverage_accuracy": coverage_accuracy(joined),
        "calibration": calibration(rows, labels),
        "read_only_precision": read_only_precision(rows, labels),
        "latency": latency_summary(rows),
    }

    print(f"LAYA shadow report — {args.log}")
    print(f"  rows: {len(rows)} (joined with brain outcome: {len(joined)}; malformed skipped: {skipped})")
    print(f"\nRoute agreement (LAYA choice vs brain route): {overall:.1%}"
          + (f"  [{unmapped} turns with unmapped client-control tools excluded]" if unmapped else ""))
    print("  laya\\brain          " + "  ".join(f"{choice[:18]:>18}" for choice in ROUTE_CHOICES))
    for laya in ROUTE_CHOICES:
        cells = [str(matrix.get((laya, brain), 0)) for brain in ROUTE_CHOICES]
        print(f"  {laya[:18]:>18}" + "".join(f"{cell:>20}" for cell in cells))
    print("\nCoverage / accuracy by confidence threshold (route):")
    for entry in report["coverage_accuracy"]:
        covered = entry["covered"]
        coverage = f"{entry['coverage']:.1%}" if entry["coverage"] is not None else "—"
        accuracy = f"{entry['accuracy']:.1%}" if entry["accuracy"] is not None else "—"
        print(f"  conf >= {entry['threshold']:.2f}: coverage {coverage:>5} ({covered} turns), accuracy {accuracy}")
    print("\nCalibration (ECE before/after Platt refit on logged confidence):")
    for entry in report["calibration"]:
        if "ece_before" in entry:
            line = (f"  {entry['question']:<14} n={entry['n']:<4} ECE {entry['ece_before']:.3f} -> "
                    f"{entry['ece_after']:.3f}  (platt a={entry['platt_a']:.2f} b={entry['platt_b']:.2f})")
        else:
            line = f"  {entry['question']:<14} n={entry['n']:<4} {entry.get('note', '')}"
        print(line + (f"   [{entry['note']}]" if "ece_before" in entry and "note" in entry else ""))
    precision = report["read_only_precision"]
    print(f"\nRead-only precision at P>=0.95 (turns that started tasks): flagged {precision['flagged_p095_started_task']}")
    if "precision" in precision:
        print(f"  precision {precision['precision']:.1%} over {precision['labeled']} labeled turns")
    else:
        print(f"  {precision.get('note', '')}")
    latency = report["latency"]
    if latency["n"]:
        print(f"\nLatency (fresh /decide calls): p50 {latency['p50_ms']:.0f} ms  p95 {latency['p95_ms']:.0f} ms  "
              f"(cached {latency['cached']}, timeouts {latency['timeouts']}, unknown answers {latency['unknown_answers']})")
    else:
        print(f"\nLatency: no fresh /decide answers yet (cached {latency['cached']}, timeouts {latency['timeouts']})")
    print("\nGo/no-go (plan §5): route agreement >= 90% at conf >= 0.85 covering >= 50% of turns, "
          "read-only precision >= 98% at P >= 0.95, ECE <= 0.10 after refit.")

    if args.json:
        args.json.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(f"\nJSON report written to {args.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
