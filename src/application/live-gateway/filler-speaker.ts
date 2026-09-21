import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// The filler side-channel: short pre-recorded clips in the same voice as the
// provider, streamed straight to the client as ordinary audio.output frames
// while a slow tool call (or a provider outage) would otherwise be dead air.
// Clips are synthesized offline by scripts/generate-filler-clips.py with the
// same Qwen3-TTS engine/speaker as the deployed speech-to-speech stack.

/** PCM rate the provider's realtime boundary publishes (24 kHz PCM16 mono). */
export const FILLER_SAMPLE_RATE = 24_000;
const FILLER_MIME_TYPE = `audio/pcm;rate=${FILLER_SAMPLE_RATE}`;
const FRAME_MS = 100;
/** Re-check the speech gate this often while a clip sequence is waiting. */
const GATE_RETRY_MS = 1_000;
/** Cap concurrent clip bytes so a corrupt asset cannot flood a session. */
const MAX_TOTAL_CLIP_BYTES = 8 * 1024 * 1024;

export interface FillerClip {
  name: string;
  text: string;
  pcm: Buffer;
}

export type FillerEmit =
  | { kind: "audio"; data: string; mimeType: string; final: boolean }
  | { kind: "transcript"; text: string };

export interface FillerSpeakerOptions {
  /** Emits paced audio frames and one transcript line per spoken clip. */
  emit: (message: FillerEmit) => void;
  /** Asked before every clip; false defers the clip by GATE_RETRY_MS. */
  gate: () => boolean;
  /** Called once per clip actually spoken (diagnostics counter). */
  onInjection?: () => void;
  /** Quieter than throwing when the clip library cannot be read. */
  onUnavailable?: (error: unknown) => void;
  /** Delay before the first clip of a sequence. */
  delayMs: number;
  /** Pause between clips of the same sequence. */
  intervalMs: number;
  /** Clip budget per sequence (bound the "still working" loop). */
  maxPerSequence: number;
  /** Override the asset directory (tests). */
  directory?: string;
}

/**
 * Paces one sequence of filler clips. Purely mechanical: the session owns the
 * gating policy (who may speak when) and the wire format; this class only
 * loads clips, chunks them into frames, and respects stop() instantly.
 */
export class FillerSpeaker {
  private readonly options: FillerSpeakerOptions;
  private clips: FillerClip[] | null = null;
  private loadFailed = false;
  private nextClipIndex = 0;
  private playedInSequence = 0;
  private waiting = false;
  private speaking = false;
  private beginRequested = false;
  private waitTimer?: ReturnType<typeof setTimeout>;
  private frameTimer?: ReturnType<typeof setInterval>;
  private currentClip?: FillerClip;
  private frameOffset = 0;
  private readonly frameBytes = FILLER_SAMPLE_RATE * 2 * FRAME_MS / 1_000;

  constructor(options: FillerSpeakerOptions) {
    this.options = options;
  }

  get active(): boolean {
    return this.waiting || this.speaking;
  }

  /** Start (or keep) a filler sequence for a new slow wait. */
  beginSequence(): void {
    if (this.active || this.beginRequested) return;
    this.beginRequested = true;
    void this.preload().then(() => {
      if (!this.beginRequested) return;
      if (!this.clips || this.clips.length === 0) return;
      this.playedInSequence = 0;
      this.waiting = true;
      this.scheduleWait(this.options.delayMs);
    });
  }

  /**
   * Speak one named clip as soon as the gate allows (escalations such as
   * "your answer is ready"). Best-effort: no retry when the gate refuses.
   */
  speakOnce(clipName: string): void {
    void this.preload().then(() => {
      if (this.active) return;
      const clip = this.clips?.find((candidate) => candidate.name === clipName);
      if (!clip || !this.options.gate()) return;
      this.playedInSequence = 0;
      this.speak(clip);
    });
  }

  /** Stop everything; a clip mid-flight stops emitting frames immediately. */
  stop(): void {
    this.beginRequested = false;
    this.clearTimers();
    this.waiting = false;
    this.speaking = false;
    this.currentClip = undefined;
    this.playedInSequence = 0;
  }

  /** Loads the clip library once; safe to call before beginSequence. */
  preload(): Promise<void> {
    this.loadPromise ??= this.loadClips();
    return this.loadPromise;
  }

  private loadPromise?: Promise<void>;

  private async loadClips(): Promise<void> {
    if (this.clips !== null || this.loadFailed) return;
    try {
      this.clips = await loadFillerClips(this.options.directory);
    } catch (error) {
      this.loadFailed = true;
      this.options.onUnavailable?.(error);
    }
  }

  private clearTimers(): void {
    if (this.waitTimer !== undefined) {
      clearTimeout(this.waitTimer);
      this.waitTimer = undefined;
    }
    if (this.frameTimer !== undefined) {
      clearInterval(this.frameTimer);
      this.frameTimer = undefined;
    }
  }

  private scheduleWait(delayMs: number): void {
    if (this.waitTimer !== undefined) clearTimeout(this.waitTimer);
    this.waitTimer = setTimeout(() => {
      this.waitTimer = undefined;
      void this.trySpeak();
    }, Math.max(1, delayMs));
    this.waitTimer.unref?.();
  }

  private async trySpeak(): Promise<void> {
    if (!this.waiting || this.speaking) return;
    if (this.playedInSequence >= this.options.maxPerSequence) {
      this.waiting = false;
      return;
    }
    if (!this.options.gate()) {
      this.scheduleWait(GATE_RETRY_MS);
      return;
    }
    const clips = this.clips!;
    const clip = clips[this.nextClipIndex % clips.length]!;
    this.nextClipIndex = (this.nextClipIndex + 1) % clips.length;
    this.speak(clip);
  }

  private speak(clip: FillerClip): void {
    this.speaking = true;
    this.currentClip = clip;
    this.frameOffset = 0;
    this.playedInSequence += 1;
    this.options.onInjection?.();
    // First frame goes out immediately; the interval paces the remainder.
    this.emitClipFrame(clip);
    if (!this.speaking || this.currentClip !== clip) return;
    this.frameTimer = setInterval(() => {
      if (!this.speaking || this.currentClip !== clip) {
        this.finishClip(true);
        return;
      }
      this.emitClipFrame(clip);
    }, FRAME_MS);
    this.frameTimer.unref?.();
  }

  private emitClipFrame(clip: FillerClip): void {
    const frame = clip.pcm.subarray(this.frameOffset, this.frameOffset + this.frameBytes);
    this.frameOffset += this.frameBytes;
    const final = this.frameOffset >= clip.pcm.length;
    this.options.emit({
      kind: "audio",
      data: frame.toString("base64"),
      mimeType: FILLER_MIME_TYPE,
      final,
    });
    if (final) this.finishClip(false);
  }

  private finishClip(interrupted: boolean): void {
    if (this.frameTimer !== undefined) {
      clearInterval(this.frameTimer);
      this.frameTimer = undefined;
    }
    const clip = this.currentClip;
    this.speaking = false;
    this.currentClip = undefined;
    // A clipped-off filler still deserves its transcript line so the UI does
    // not show a mystery caption later; an interrupted one does not.
    if (clip && !interrupted) {
      this.options.emit({ kind: "transcript", text: clip.text });
    }
    if (this.waiting && !interrupted) {
      this.scheduleWait(this.options.intervalMs);
    } else {
      this.waiting = false;
      this.playedInSequence = 0;
    }
  }
}

async function loadFillerClips(directoryOverride?: string): Promise<FillerClip[]> {
  const directory = directoryOverride
    ?? fileURLToPath(new URL("../../../assets/filler", import.meta.url));
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }
  const clips: FillerClip[] = [];
  let totalBytes = 0;
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".pcm")) continue;
    const name = entry.slice(0, -".pcm".length);
    const [pcm, text] = await Promise.all([
      readFile(`${directory}/${entry}`),
      readFile(`${directory}/${name}.txt`, "utf8").catch(() => ""),
    ]);
    if (pcm.length === 0 || pcm.length % 2 !== 0) continue;
    totalBytes += pcm.length;
    if (totalBytes > MAX_TOTAL_CLIP_BYTES) break;
    clips.push({ name, text: text.trim(), pcm });
  }
  return clips;
}
