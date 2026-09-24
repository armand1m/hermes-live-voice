import { mkdtempSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileVadRecorder, readVadRecordings } from "../src/adapters/outbound/vad-recording/file-vad-recorder.js";
import { EnergyProbabilityEngine } from "../src/application/live-gateway/vad/energy-engine.js";
import { SpeechGate } from "../src/application/live-gateway/vad/speech-gate.js";
import { replayRecording, summarizeCandidate } from "../src/application/live-gateway/vad/vad-replay.js";
import type { VadConfig } from "../src/config.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function vadConfig(overrides: Partial<VadConfig> = {}): VadConfig {
  return {
    engine: "energy", startProbability: 0.5, stopProbability: 0.25, startSustainMs: 100, stopSustainMs: 500,
    echoStartProbability: 0.7, echoStartSustainMs: 200, prerollMs: 250, tailMs: 400, halfDuplex: false, turnTailMs: 1_000,
    ...overrides,
  };
}

/** 50 ms of 16 kHz PCM16 at a constant-ish amplitude. */
function frame(level: number): { data: string; mimeType: string } {
  const samples = new Int16Array(800);
  for (let i = 0; i < samples.length; i += 1) samples[i] = Math.round(Math.sin(i / 3) * level * 32_767);
  return { data: Buffer.from(samples.buffer).toString("base64"), mimeType: "audio/pcm;rate=16000" };
}

/**
 * Record one "live" session: speech, a mid-thought pause, speech, then
 * silence — through a real gate on a fake clock.
 */
async function recordSession(directory: string, config: VadConfig) {
  const recorder = new FileVadRecorder({ directory, maxTotalBytes: 50_000_000, retentionMs: 7 * 86_400_000 });
  const recording = recorder.start("live_test", config)!;
  let now = 1_000_000;
  const gate = new SpeechGate({ engine: new EnergyProbabilityEngine(), config, now: () => now, observer: recording.observer });
  const decisions: Array<{ at: number; started: boolean; stopped: boolean }> = [];
  // The energy engine scores one 32 ms chunk per 50 ms frame, so the pause
  // below is 20 × 32 = 640 ms of scored silence: longer than a 500 ms stop
  // window, shorter than an 800 ms one.
  const plan = [...Array(12).fill(0.3), ...Array(20).fill(0), ...Array(12).fill(0.3), ...Array(30).fill(0)];
  for (const level of plan) {
    gate.setDownlinkActive(false, config.turnTailMs);
    const decision = await gate.ingest(frame(level));
    if (decision.started || decision.stopped) decisions.push({ at: now, started: decision.started, stopped: decision.stopped });
    now += 50;
  }
  recording.note({ type: "user_final", text: "check the deploy on exodia", fromVoice: true });
  gate.reset();
  await recording.close();
  return decisions;
}

describe("VAD recording and replay", () => {
  it("records a session owner-only and reads it back", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vad-rec-"));
    directories.push(directory);
    await recordSession(directory, vadConfig());
    const [session] = readdirSync(directory);
    expect(statSync(join(directory, session!)).mode & 0o777).toBe(0o700);
    expect(statSync(join(directory, session!, "audio.pcm")).mode & 0o777).toBe(0o600);
    const [recording] = readVadRecordings(directory);
    expect(recording!.sessionId).toBe("live_test");
    expect(recording!.events.filter((event) => event.type === "frame")).toHaveLength(74);
    // Downlink is re-asserted before every frame live; only changes are kept.
    expect(recording!.events.filter((event) => event.type === "downlink")).toHaveLength(1);
    expect(recording!.audio.length).toBe(74 * 1_600);
  });

  it("reproduces the live decisions with the recorded settings, then compares candidates", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vad-rec-"));
    directories.push(directory);
    const live = await recordSession(directory, vadConfig());
    const [recording] = readVadRecordings(directory);

    const baseline = await replayRecording(recording!, recording!.vad, new EnergyProbabilityEngine());
    expect(baseline.turns).toBe(live.filter((decision) => decision.started).length);
    expect(baseline.recordedStarts).toBe(baseline.turns);
    // The 640 ms pause outlasted the 500 ms stop window: the thought was split.
    expect(baseline.turns).toBe(2);
    expect(baseline.splitTurns).toBe(1);

    const patient = await replayRecording(recording!, vadConfig({ stopSustainMs: 800 }), new EnergyProbabilityEngine());
    expect(patient.turns).toBe(1);
    expect(patient.splitTurns).toBe(0);
    const baseRow = summarizeCandidate("baseline", recording!.vad, [baseline]);
    const patientRow = summarizeCandidate("stop=800", vadConfig({ stopSustainMs: 800 }), [patient]);
    // No split, at the price of waiting longer before the turn ends.
    expect(patientRow.silenceWaitP50Ms!).toBeGreaterThan(baseRow.silenceWaitP50Ms!);
    expect(patientRow.clippedVoicedMs).toBe(0);
  });

  it("prunes sessions past retention or over the size budget", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vad-rec-"));
    directories.push(directory);
    await recordSession(directory, vadConfig());
    const [old] = readdirSync(directory);
    const longAgo = new Date(Date.now() - 30 * 86_400_000);
    utimesSync(join(directory, old!), longAgo, longAgo);
    new FileVadRecorder({ directory, maxTotalBytes: 50_000_000, retentionMs: 7 * 86_400_000 }).start("next", vadConfig());
    expect(readdirSync(directory)).not.toContain(old);
  });
});
