import { readVadRecordings } from "../adapters/outbound/vad-recording/file-vad-recorder.js";
import { EnergyProbabilityEngine } from "../application/live-gateway/vad/energy-engine.js";
import { SileroProbabilityEngine } from "../application/live-gateway/vad/silero-engine.js";
import { loadSileroModel } from "../application/live-gateway/vad/silero-model.js";
import {
  replayRecording,
  summarizeCandidate,
  type CandidateSummary,
} from "../application/live-gateway/vad/vad-replay.js";
import type { SpeechProbabilityEngine } from "../application/live-gateway/vad/speech-gate.js";
import type { AppConfig, VadConfig } from "../config.js";
import { createLogger } from "../logger.js";

export function vadCommandHelp(): string {
  return `hermes-live vad replay [options]

Replay recorded voice sessions (HERMES_LIVE_VAD_RECORDING) through the speech
gate with a grid of endpointing settings and compare them with the live ones.

Options:
  --dir <path>          Recordings directory (default: next to the task state)
  --stop <ms,...>       HERMES_LIVE_VAD_STOP_SUSTAIN_MS candidates
  --tail <ms,...>       HERMES_LIVE_VAD_TAIL_MS candidates
  --stop-prob <p,...>   HERMES_LIVE_VAD_STOP_PROBABILITY candidates

Columns: turns; split = turns that ended and restarted within 1.5 s (likely
cut-offs); wait = silence between your last voiced audio and the turn end
(p50/p95); clipped = voiced audio that never reached the ASR. A candidate is
marked ✓ when it waits less than the live settings without more turns, more
splits, or more clipped speech.`;
}

export async function runVadCommand(args: readonly string[], config: AppConfig): Promise<void> {
  const [action, ...rest] = args;
  if (action !== "replay") {
    console.log(vadCommandHelp());
    if (action && !["help", "--help", "-h"].includes(action)) process.exitCode = 1;
    return;
  }
  const options = parseOptions(rest);
  const directory = options.dir ?? config.vadRecording?.directory;
  if (!directory) throw new Error("No recordings directory configured; pass --dir.");
  const recordings = readVadRecordings(directory);
  if (recordings.length === 0) {
    console.log(`No recordings in ${directory}. Enable HERMES_LIVE_VAD_RECORDING="true" and use the assistant for a while.`);
    return;
  }

  const baseline = recordings.at(-1)!.vad;
  const createEngine = await engineFactory(baseline);
  const candidates = candidateConfigs(baseline, options);
  const rows: CandidateSummary[] = [];
  for (const candidate of candidates) {
    const runs = [];
    for (const recording of recordings) runs.push(await replayRecording(recording, candidate.config, createEngine()));
    rows.push(summarizeCandidate(candidate.label, candidate.config, runs));
  }

  const live = rows[0]!;
  const totalMinutes = recordings.reduce((sum, recording) => sum + recording.audio.length / 2 / 16_000 / 60, 0);
  console.log(`${recordings.length} session(s), ~${totalMinutes.toFixed(1)} min of gated audio, ${live.turns} live-setting turns.\n`);
  console.log(formatTable(rows, live));
}

interface ReplayOptions {
  dir?: string;
  stop?: number[];
  tail?: number[];
  stopProbability?: number[];
}

function parseOptions(args: readonly string[]): ReplayOptions {
  const options: ReplayOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined) throw new Error(`${flag} needs a value.`);
    index += 1;
    const numbers = () => value.split(",").map((item) => {
      const parsed = Number(item.trim());
      if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${flag}: "${item}" is not a number.`);
      return parsed;
    });
    if (flag === "--dir") options.dir = value;
    else if (flag === "--stop") options.stop = numbers();
    else if (flag === "--tail") options.tail = numbers();
    else if (flag === "--stop-prob") options.stopProbability = numbers();
    else throw new Error(`Unknown option ${flag}.`);
  }
  return options;
}

/** The live settings first, then every grid combination that differs from them. */
function candidateConfigs(baseline: VadConfig, options: ReplayOptions): Array<{ label: string; config: VadConfig }> {
  const stops = options.stop ?? [250, 350, 500, 700];
  const tails = options.tail ?? [150, 250, 400];
  const stopProbabilities = options.stopProbability ?? [baseline.stopProbability];
  const candidates = [{ label: "live", config: baseline }];
  for (const stopSustainMs of stops) {
    for (const tailMs of tails) {
      for (const stopProbability of stopProbabilities) {
        if (stopSustainMs === baseline.stopSustainMs && tailMs === baseline.tailMs && stopProbability === baseline.stopProbability) continue;
        candidates.push({
          label: `stop=${stopSustainMs} tail=${tailMs}${stopProbabilities.length > 1 ? ` p=${stopProbability}` : ""}`,
          config: { ...baseline, stopSustainMs, tailMs, stopProbability },
        });
      }
    }
  }
  return candidates;
}

/** The same engine the live gate used: Silero when its model loads, else energy. */
async function engineFactory(baseline: VadConfig): Promise<() => SpeechProbabilityEngine> {
  if (baseline.engine === "energy") return () => new EnergyProbabilityEngine();
  const model = await loadSileroModel({ ...(baseline.modelPath ? { modelPath: baseline.modelPath } : {}), logger: createLogger("warn") });
  if (!model) {
    console.warn("Silero model unavailable: replaying with the energy engine (numbers will differ from live).");
    return () => new EnergyProbabilityEngine();
  }
  return () => new SileroProbabilityEngine(model);
}

function formatTable(rows: readonly CandidateSummary[], live: CandidateSummary): string {
  // More turns than live means utterances were chopped apart, even when the
  // restart window happens not to count every piece as a split.
  const better = (row: CandidateSummary) => row !== live
    && row.turns <= live.turns
    && row.splitTurns <= live.splitTurns
    && row.clippedVoicedMs <= live.clippedVoicedMs
    && (row.silenceWaitP50Ms ?? Infinity) < (live.silenceWaitP50Ms ?? -Infinity);
  const sorted = [live, ...rows.filter((row) => row !== live).sort((a, b) =>
    Number(better(b)) - Number(better(a)) || (a.silenceWaitP50Ms ?? 0) - (b.silenceWaitP50Ms ?? 0))];
  const header = ["", "candidate", "turns", "split", "wait p50", "wait p95", "clipped"];
  const lines = sorted.map((row) => [
    better(row) ? "✓" : "",
    row.label,
    String(row.turns),
    `${row.splitTurns} (${(row.splitRate * 100).toFixed(0)}%)`,
    row.silenceWaitP50Ms === null ? "-" : `${Math.round(row.silenceWaitP50Ms)} ms`,
    row.silenceWaitP95Ms === null ? "-" : `${Math.round(row.silenceWaitP95Ms)} ms`,
    `${row.clippedVoicedMs} ms`,
  ]);
  const widths = header.map((_, column) => Math.max(header[column]!.length, ...lines.map((line) => line[column]!.length)));
  const render = (cells: readonly string[]) => cells.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd();
  return [render(header), ...lines.map(render)].join("\n");
}
