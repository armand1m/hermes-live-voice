import { readFile, readdir } from "node:fs/promises";

// Process-level signals behind GET /v1/metrics for the browser diagnostics
// overlay. Everything here is stdlib-only and allocation-light: the endpoint is
// polled once per second per viewer, so each sample is a few /proc reads and
// two cpuUsage() snapshots. Nothing is sampled unless somebody is polling.

/**
 * Linux USER_HZ. Node exposes no sysconf(_SC_CLK_TCK); every mainstream
 * Linux userspace (x86_64, aarch64) defines 100 ticks per second.
 */
const PROC_CLOCK_TICKS_PER_SECOND = 100;
/** Probe cadence for the event-loop lag estimator. */
const EVENT_LAG_PROBE_MS = 250;
const EVENT_LAG_INTERVAL_MS = 1_000;
const EVENT_LAG_EMA = 0.3;
/** Re-scan /proc for the voice-stack process at most this often. */
const VOICE_STACK_RESCAN_MS = 30_000;
const VOICE_STACK_RETRY_MS = 5_000;
/** Ignore CPU deltas computed over intervals this short (too noisy). */
const MIN_SAMPLE_INTERVAL_MS = 40;

export interface GatewayProcessMetrics {
  /** Gateway node process CPU as a percent of one core (can exceed 100). */
  gatewayCpuPct: number;
  /** Smoothed event-loop lag of the gateway in milliseconds. */
  eventLagMs: number;
  /** Upstream `speech-to-speech serve` CPU as a percent of one core, if resolvable. */
  voiceStackCpuPct: number | null;
  voiceStackPid: number | null;
}

export interface GatewayMetricsCollector {
  sample(): Promise<GatewayProcessMetrics>;
  stop(): void;
}

export function createGatewayMetricsCollector(): GatewayMetricsCollector {
  let gatewayCpuPct = 0;
  let lastCpuUsage = process.cpuUsage();
  let lastCpuAt = process.hrtime.bigint();

  let eventLagMs = 0;
  const lagProbe = setInterval(() => {
    const startedAt = process.hrtime.bigint();
    setTimeout(() => {
      const driftMs = Number(process.hrtime.bigint() - startedAt) / 1e6 - EVENT_LAG_PROBE_MS;
      if (driftMs >= 0) {
        const clamped = Math.min(driftMs, 500);
        eventLagMs = eventLagMs === 0 ? clamped : eventLagMs * (1 - EVENT_LAG_EMA) + clamped * EVENT_LAG_EMA;
      }
    }, EVENT_LAG_PROBE_MS).unref?.();
  }, EVENT_LAG_INTERVAL_MS);
  lagProbe.unref?.();

  let voiceStackPid: number | null = null;
  let voiceStackTicks = -1;
  let voiceStackAt = 0n;
  let voiceStackCpuPct: number | null = null;
  let voiceStackScannedAt = 0;
  let voiceStackLastErrorAt = 0;

  let sampling: Promise<GatewayProcessMetrics> | null = null;

  async function sampleVoiceStack(): Promise<void> {
    const now = Date.now();
    const scanDue = voiceStackPid === null
      ? now - voiceStackScannedAt >= VOICE_STACK_RETRY_MS
      : now - voiceStackScannedAt >= VOICE_STACK_RESCAN_MS;
    if (scanDue) {
      voiceStackScannedAt = now;
      const pid = await findVoiceStackPid();
      if (pid !== voiceStackPid) {
        voiceStackPid = pid;
        voiceStackTicks = -1;
        voiceStackCpuPct = null;
      }
    }
    if (voiceStackPid === null) {
      voiceStackCpuPct = null;
      return;
    }
    const ticks = await readProcessCpuTicks(voiceStackPid);
    const at = process.hrtime.bigint();
    if (ticks === undefined) {
      // The process exited (or restarted under a new pid): force a rescan.
      if (now - voiceStackLastErrorAt >= VOICE_STACK_RETRY_MS) {
        voiceStackLastErrorAt = now;
        voiceStackScannedAt = 0;
      }
      return;
    }
    if (voiceStackTicks >= 0) {
      const elapsedMs = Number(at - voiceStackAt) / 1e6;
      if (elapsedMs >= MIN_SAMPLE_INTERVAL_MS) {
        const deltaTicks = ticks - voiceStackTicks;
        if (deltaTicks >= 0) {
          const seconds = deltaTicks / PROC_CLOCK_TICKS_PER_SECOND;
          voiceStackCpuPct = Math.round((seconds / (elapsedMs / 1_000)) * 100 * 10) / 10;
        }
      }
    }
    voiceStackTicks = ticks;
    voiceStackAt = at;
  }

  async function doSample(): Promise<GatewayProcessMetrics> {
    const cpu = process.cpuUsage();
    const at = process.hrtime.bigint();
    const elapsedMs = Number(at - lastCpuAt) / 1e6;
    if (elapsedMs >= MIN_SAMPLE_INTERVAL_MS) {
      const { user, system } = cpu;
      const previous = lastCpuUsage;
      const deltaMs = (user - previous.user + system - previous.system) / 1_000;
      if (deltaMs >= 0) {
        gatewayCpuPct = Math.round((deltaMs / elapsedMs) * 100 * 10) / 10;
      }
    }
    lastCpuUsage = cpu;
    lastCpuAt = at;

    await sampleVoiceStack();
    return {
      gatewayCpuPct,
      eventLagMs: Math.round(eventLagMs * 10) / 10,
      voiceStackCpuPct,
      voiceStackPid,
    };
  }

  return {
    sample() {
      if (!sampling) {
        sampling = doSample().finally(() => {
          sampling = null;
        });
      }
      return sampling;
    },
    stop() {
      clearInterval(lagProbe);
    },
  };
}

/**
 * Locate the upstream voice-stack process (`speech-to-speech serve`), which
 * runs on the same host as the gateway. Matched by command-line tokens so a
 * differently-named working directory or wrapper cannot fool it.
 */
async function findVoiceStackPid(): Promise<number | null> {
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!/^[0-9]+$/.test(entry)) continue;
    try {
      const raw = await readFile(`/proc/${entry}/cmdline`, "utf8");
      const argv = raw.split("\0").filter(Boolean);
      // The stack may be launched through a venv interpreter, so the
      // executable token can appear anywhere (…/python …/speech-to-speech serve).
      const executableIndex = argv.findIndex((token) => token.split("/").pop() === "speech-to-speech");
      if (executableIndex >= 0 && argv.slice(executableIndex + 1).includes("serve")) {
        return Number(entry);
      }
    } catch {
      // Exited mid-scan or owned by another user; keep scanning.
    }
  }
  return null;
}

/** utime+stime clock ticks from /proc/<pid>/stat, or undefined when unreadable. */
async function readProcessCpuTicks(pid: number): Promise<number | undefined> {
  let stat: string;
  try {
    stat = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch {
    return undefined;
  }
  // The comm field can contain spaces and parens; fields resume after the
  // final ')'. utime/stat field 14 and stime field 15 → offsets 11 and 12.
  const closing = stat.lastIndexOf(")");
  if (closing === -1) return undefined;
  const fields = stat.slice(closing + 2).split(" ");
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return undefined;
  return utime + stime;
}
