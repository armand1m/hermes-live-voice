import type { AgentWatchRecord } from "../../domain/external-work/index.js";
import type { ExternalMonitorEvent } from "./external-agent-monitor.js";

/**
 * Progress policy for external work (plan §D): which monitor events deserve
 * speech, and what a quiet-period check-in may honestly say. Templates only —
 * no model call. Every message states evidence; none invents progress or
 * treats observed idleness as completion.
 */

/** Two minutes without a spoken report while tracked work is active. */
export const EXTERNAL_CHECK_IN_MS = 2 * 60_000;
export const MAX_EXTERNAL_ANNOUNCEMENT_CHARS = 500;

export interface ExternalAnnouncement {
  /** Dedupe identity: one speech per key, ever, per watch. */
  key: string;
  watchId: string;
  message: string;
}

/** State changes, monitoring loss/recovery, mismatches, and the launch itself speak. */
export function externalAnnouncementFor(event: ExternalMonitorEvent): ExternalAnnouncement | undefined {
  const watch = event.watch;
  const where = `${watch.host}`;
  const objective = firstSentence(watch.objective);
  switch (event.kind) {
    case "registered":
      return {
        watchId: watch.watchId,
        key: `${watch.watchId}:registered`,
        message: `Now watching the ${watch.harness} agent on ${where}${objective ? ` — ${objective}` : ""}. I'll report changes and won't touch it.`,
      };
    case "state-change": {
      const state = watch.lastObserved?.state;
      const evidence = watch.lastObserved?.excerpt ? ` Last output: ${trimExcerpt(watch.lastObserved.excerpt)}.` : "";
      const message = stateMessage(state, where) + evidence;
      return {
        watchId: watch.watchId,
        key: `${watch.watchId}:state:${state}:${watch.lastObserved?.stateChangeSeq ?? watch.sequence}`,
        message,
      };
    }
    case "offline":
      return {
        watchId: watch.watchId,
        key: `${watch.watchId}:offline:${watch.monitoring.lastErrorAt ?? watch.sequence}`,
        message: `Lost contact with ${where}; the agent's observations are stale. I'll keep retrying.`,
      };
    case "recovered":
      return {
        watchId: watch.watchId,
        key: `${watch.watchId}:recovered:${watch.lastObserved?.stateChangeSeq ?? watch.sequence}`,
        message: `Contact with ${where} is back. The agent is ${watch.lastObserved?.state ?? "observed"}.`,
      };
    case "mismatched":
      return {
        watchId: watch.watchId,
        key: `${watch.watchId}:mismatched:${watch.sequence}`,
        message: `The watched pane on ${where} now runs a different session. The watch needs your attention; I stopped following it.`,
      };
    default:
      // Output evidence alone is not speech-worthy: it lands in the task log
      // and the next state change carries it.
      return undefined;
  }
}

/**
 * Honest check-in (plan §D): a brief spoken report while tracked work stays
 * active and nothing has been announced for two minutes. Says when there is
 * no new evidence; never invents a percentage.
 */
export function externalCheckInMessage(watches: readonly AgentWatchRecord[], quietMs: number): ExternalAnnouncement | undefined {
  const active = watches.filter((watch) => watch.status !== "stopped");
  if (active.length === 0) return undefined;
  const anchor = active[0]!;
  const states = [...new Set(active.map((watch) => watch.lastObserved?.state ?? "not yet observed"))];
  const stale = quietMs >= EXTERNAL_CHECK_IN_MS;
  const message = [
    `Still watching ${active.length === 1 ? "the agent" : `${active.length} agents`}`,
    active.length === 1 ? `on ${anchor.host}` : `across ${[...new Set(active.map((watch) => watch.host))].join(" and ")}`,
    `(currently ${states.join(", ")}).`,
    stale ? "No new verified progress since the last report." : "",
  ].filter(Boolean).join(" ").slice(0, MAX_EXTERNAL_ANNOUNCEMENT_CHARS);
  return {
    watchId: anchor.watchId,
    key: `${anchor.watchId}:checkin:${Math.floor(anchor.updatedAt / 60_000)}`,
    message,
  };
}

function stateMessage(state: string | undefined, where: string): string {
  switch (state) {
    case "working":
      return `The agent on ${where} is working.`;
    case "idle":
      return `The agent on ${where} went idle — the outcome needs inspection, not completion.`;
    case "blocked":
      return `The agent on ${where} is blocked and waiting for input.`;
    case "done":
      return `The agent on ${where} reports done — verify the outcome before treating the work as complete.`;
    case "missing":
      return `The watched agent no longer appears on ${where}.`;
    default:
      return `The agent on ${where} changed state (${state ?? "unknown"}).`;
  }
}

function firstSentence(value: string): string | undefined {
  const match = value.match(/[^.!?]+[.!?]?/u);
  const sentence = match?.[0]?.trim();
  return sentence ? sentence.slice(0, 160) : undefined;
}

function trimExcerpt(value: string): string {
  return value.trim().slice(0, 120);
}
