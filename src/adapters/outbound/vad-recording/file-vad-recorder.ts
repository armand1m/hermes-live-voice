import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import type { VadConfig } from "../../../config.js";
import type {
  VadContextEvent,
  VadRecorderPort,
  VadSessionRecording,
} from "../../../application/live-gateway/ports/vad-recorder.port.js";
import type { SpeechGateObserver } from "../../../application/live-gateway/vad/speech-gate.js";
import type { RecordedEvent, VadRecording } from "../../../application/live-gateway/vad/vad-replay.js";

// On-disk layout, one directory per voice session:
//   <dir>/<ISO start>_<sessionId>/events.jsonl   header + ordered gate/context events
//   <dir>/<ISO start>_<sessionId>/audio.pcm      raw PCM16 LE frames, as the gate received them
// Frame events point into audio.pcm by byte offset. Everything is owner-only,
// local, and pruned by age and total size on every new session.

export const VAD_RECORDING_FORMAT_VERSION = 1;

export interface FileVadRecorderOptions {
  directory: string;
  maxTotalBytes: number;
  retentionMs: number;
  /** One session never grows past this; audio stops being written beyond it. */
  maxSessionBytes?: number;
  now?: () => number;
}

export class FileVadRecorder implements VadRecorderPort {
  private readonly now: () => number;

  constructor(private readonly options: FileVadRecorderOptions) {
    this.now = options.now ?? Date.now;
  }

  start(sessionId: string, vad: VadConfig): VadSessionRecording | undefined {
    try {
      mkdirSync(this.options.directory, { recursive: true, mode: 0o700 });
      this.prune();
      const startedAt = this.now();
      const directory = join(this.options.directory, `${new Date(startedAt).toISOString().replaceAll(":", "-")}_${safeName(sessionId)}`);
      mkdirSync(directory, { mode: 0o700 });
      return new FileVadSessionRecording(directory, sessionId, vad, startedAt, this.options.maxSessionBytes ?? 64 * 1024 * 1024);
    } catch {
      return undefined;
    }
  }

  /** Drop sessions older than the retention window, then oldest-first over budget. */
  private prune(): void {
    const cutoff = this.now() - this.options.retentionMs;
    const sessions = readdirSync(this.options.directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const path = join(this.options.directory, entry.name);
        return { path, modified: statSync(path).mtimeMs, bytes: directoryBytes(path) };
      })
      .sort((a, b) => a.modified - b.modified);
    let total = sessions.reduce((sum, session) => sum + session.bytes, 0);
    for (const session of sessions) {
      if (session.modified >= cutoff && total <= this.options.maxTotalBytes) continue;
      rmSync(session.path, { recursive: true, force: true });
      total -= session.bytes;
    }
  }
}

class FileVadSessionRecording implements VadSessionRecording {
  readonly observer: SpeechGateObserver;
  private readonly events: WriteStream;
  private readonly audio: WriteStream;
  private audioBytes = 0;
  private closed = false;
  private lastDownlink: string | undefined;

  constructor(directory: string, sessionId: string, vad: VadConfig, startedAt: number, private readonly maxBytes: number) {
    this.events = createWriteStream(join(directory, "events.jsonl"), { flags: "a", mode: 0o600 });
    this.audio = createWriteStream(join(directory, "audio.pcm"), { flags: "a", mode: 0o600 });
    // Swallow late I/O errors: recording is diagnostics, never a session failure.
    this.events.on("error", () => undefined);
    this.audio.on("error", () => undefined);
    this.write({ type: "header", v: VAD_RECORDING_FORMAT_VERSION, sessionId, startedAt, vad });
    this.observer = {
      onDownlink: (active, holdMs, at) => {
        // The session re-asserts downlink state before every frame; only
        // changes alter gate behavior, so only changes are recorded.
        const key = `${active}:${holdMs}`;
        if (key === this.lastDownlink) return;
        this.lastDownlink = key;
        this.write({ type: "downlink", t: at, active, holdMs });
      },
      onIngest: (record) => {
        const pcm = Buffer.from(record.frame.data, "base64");
        let offset = -1;
        if (this.audioBytes + pcm.length <= this.maxBytes) {
          offset = this.audioBytes;
          this.audio.write(pcm);
          this.audioBytes += pcm.length;
        }
        this.write({
          type: "frame",
          t: record.at,
          mimeType: record.frame.mimeType,
          offset,
          length: pcm.length,
          p: record.probabilities.map((value) => Math.round(value * 1_000) / 1_000),
          started: record.started,
          stopped: record.stopped,
          forwarded: record.forwarded,
        });
      },
      onReset: (at) => {
        this.lastDownlink = undefined;
        this.write({ type: "reset", t: at });
      },
      onExpired: (at) => this.write({ type: "expired", t: at }),
    };
  }

  note(event: VadContextEvent): void {
    this.write({ ...event, t: Date.now() });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([
      new Promise<void>((resolve) => this.events.end(resolve)),
      new Promise<void>((resolve) => this.audio.end(resolve)),
    ]);
  }

  private write(event: Record<string, unknown>): void {
    if (this.closed) return;
    this.events.write(`${JSON.stringify(event)}\n`);
  }
}

/**
 * Load every recorded session under `directory`, oldest first. A session cut
 * off mid-write keeps its complete lines; unreadable sessions are skipped.
 */
export function readVadRecordings(directory: string): VadRecording[] {
  if (!existsSync(directory)) return [];
  const recordings: VadRecording[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    try {
      const lines = readFileSync(join(path, "events.jsonl"), "utf8").split("\n").filter(Boolean);
      const parsed: Array<Record<string, unknown>> = [];
      for (const line of lines) {
        try {
          parsed.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // Truncated final line of an interrupted session.
        }
      }
      const header = parsed[0];
      if (header?.type !== "header" || header.v !== VAD_RECORDING_FORMAT_VERSION) continue;
      recordings.push({
        sessionId: String(header.sessionId),
        startedAt: Number(header.startedAt),
        vad: header.vad as VadRecording["vad"],
        events: parsed.slice(1) as unknown as RecordedEvent[],
        audio: existsSync(join(path, "audio.pcm")) ? readFileSync(join(path, "audio.pcm")) : Buffer.alloc(0),
      });
    } catch {
      continue;
    }
  }
  return recordings;
}

function directoryBytes(path: string): number {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isFile()) total += statSync(join(path, entry.name)).size;
  }
  return total;
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 80);
}
