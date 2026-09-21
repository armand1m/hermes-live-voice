import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FillerSpeaker, FILLER_SAMPLE_RATE, type FillerEmit } from "../src/application/live-gateway/filler-speaker.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** Two frames (200 ms) of a recognizable byte pattern at 24 kHz PCM16. */
function clipPcm(mark: number): Buffer {
  const frameBytes = FILLER_SAMPLE_RATE * 2 * 100 / 1_000; // one 100 ms frame
  const buffer = Buffer.alloc(frameBytes * 2);
  for (let index = 0; index < buffer.length; index += 1) buffer[index] = (mark + index) % 251;
  return buffer;
}

async function clipDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "filler-clips-"));
  temporaryDirectories.push(directory);
  await writeFile(join(directory, "one.pcm"), clipPcm(1));
  await writeFile(join(directory, "one.txt"), "One moment.");
  await writeFile(join(directory, "two.pcm"), clipPcm(100));
  await writeFile(join(directory, "two.txt"), "Two moments.");
  return directory;
}

describe("FillerSpeaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function harness(overrides: Partial<ConstructorParameters<typeof FillerSpeaker>[0]> = {}) {
    const emitted: FillerEmit[] = [];
    const injections: number[] = [];
    let gated = true;
    const speaker = new FillerSpeaker({
      emit: (message) => emitted.push(message),
      gate: () => gated,
      onInjection: () => injections.push(emitted.length),
      delayMs: 500,
      intervalMs: 1_000,
      maxPerSequence: 2,
      ...overrides,
    });
    return { speaker, emitted, injections, setGate: (value: boolean) => (gated = value) };
  }

  it("waits the delay, streams frames, emits the transcript, then spaces the next clip", async () => {
    const directory = await clipDirectory();
    const { speaker, emitted } = harness({ directory });
    await speaker.preload();
    speaker.beginSequence();

    await vi.advanceTimersByTimeAsync(499);
    expect(emitted).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    // First frame of clip one is out; remaining frames pace at 100 ms.
    expect(emitted.filter((message) => message.kind === "audio")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(100);
    const audioMessages = emitted.filter((message) => message.kind === "audio");
    expect(audioMessages).toHaveLength(2);
    expect(audioMessages.at(-1)).toMatchObject({ kind: "audio", final: true, mimeType: "audio/pcm;rate=24000" });

    await vi.advanceTimersByTimeAsync(1);
    expect(emitted.at(-1)).toEqual({ kind: "transcript", text: "One moment." });

    // The next clip waits for the interval (t≈1601), then cycles to clip two.
    await vi.advanceTimersByTimeAsync(500);
    expect(emitted.filter((message) => message.kind === "audio")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(emitted.filter((message) => message.kind === "transcript")).toHaveLength(2);
    expect(emitted.at(-1)).toEqual({ kind: "transcript", text: "Two moments." });
  });

  it("stops the sequence at the per-sequence clip budget", async () => {
    const directory = await clipDirectory();
    const { speaker, emitted } = harness({ directory, maxPerSequence: 1 });
    await speaker.preload();
    speaker.beginSequence();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(emitted.filter((message) => message.kind === "transcript")).toHaveLength(1);

    // Budget exhausted: no further clips, no lingering timers matter.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(emitted.filter((message) => message.kind === "transcript")).toHaveLength(1);
    expect(speaker.active).toBe(false);
  });

  it("defers a clip while the gate refuses and retries", async () => {
    const directory = await clipDirectory();
    const { speaker, emitted, setGate } = harness({ directory });
    await speaker.preload();
    setGate(false);
    speaker.beginSequence();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(emitted).toEqual([]);

    setGate(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(emitted.filter((message) => message.kind === "audio").length).toBeGreaterThan(0);
  });

  it("stop() silences a mid-flight clip immediately and drops its transcript", async () => {
    const directory = await clipDirectory();
    const { speaker, emitted } = harness({ directory });
    await speaker.preload();
    speaker.beginSequence();
    await vi.advanceTimersByTimeAsync(550);
    expect(emitted.filter((message) => message.kind === "audio")).toHaveLength(1);

    speaker.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(emitted.filter((message) => message.kind === "audio")).toHaveLength(1);
    expect(emitted.filter((message) => message.kind === "transcript")).toHaveLength(0);
    expect(speaker.active).toBe(false);
  });

  it("beginSequence on an active sequence is a no-op (no reset, no double timers)", async () => {
    const directory = await clipDirectory();
    const { speaker, emitted } = harness({ directory });
    await speaker.preload();
    speaker.beginSequence();
    await vi.advanceTimersByTimeAsync(100);
    speaker.beginSequence();
    await vi.advanceTimersByTimeAsync(400);
    expect(emitted.filter((message) => message.kind === "audio")).toHaveLength(1);
  });

  it("no-ops without clips (fresh deploy before generation) instead of erroring", async () => {
    const unavailable = vi.fn();
    const { speaker, emitted } = harness({ directory: "/nonexistent-filler-directory", onUnavailable: unavailable });
    speaker.beginSequence();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(unavailable).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
    expect(speaker.active).toBe(false);
  });
});
