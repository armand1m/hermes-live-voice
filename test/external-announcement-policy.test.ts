import { describe, expect, it } from "vitest";
import {
  EXTERNAL_CHECK_IN_MS,
  externalAnnouncementFor,
  externalCheckInMessage,
} from "../src/application/external-work/external-announcement-policy.js";
import {
  createAgentWatchRecord,
  hashWatchOwnerId,
  recordWatchObservation,
  type AgentWatchRecord,
} from "../src/domain/external-work/index.js";
import type { ExternalMonitorEvent } from "../src/application/external-work/external-agent-monitor.js";

const OWNER = hashWatchOwnerId("alice");

function watch(overrides: Partial<AgentWatchRecord> = {}): AgentWatchRecord {
  return {
    ...createAgentWatchRecord({
      ownerId: OWNER,
      host: "exodia",
      harness: "herdr",
      agentSessionValue: "4432988d-611f-437a-8b3a-9937984a86e2",
      paneId: "w4:p1",
      objective: "Fix the diamond indicator. Verify on the plot.",
      acceptanceCriteria: ["Plot renders"],
      now: 100,
    }),
    ...overrides,
  } as AgentWatchRecord;
}

function event(kind: ExternalMonitorEvent["kind"], target: AgentWatchRecord): ExternalMonitorEvent {
  return { kind, watch: target, previousState: target.lastObserved?.state };
}

describe("external announcement policy", () => {
  it("announces the launch with the objective's first sentence", () => {
    const announcement = externalAnnouncementFor(event("registered", watch()));
    expect(announcement).toMatchObject({ watchId: expect.stringMatching(/^watch_/) });
    expect(announcement!.key).toContain(":registered");
    expect(announcement!.message).toContain("Now watching the herdr agent on exodia");
    expect(announcement!.message).toContain("Fix the diamond indicator.");
  });

  it("speaks state changes honestly: idle needs inspection, done needs verification, evidence rides along", () => {
    const working = recordWatchObservation(watch(), {
      now: 150,
      observation: { state: "working", agentStatus: "working", excerpt: "running plot suite", at: 150 },
      summary: "Agent working.",
    });
    expect(externalAnnouncementFor(event("state-change", working))!.message)
      .toContain("working. Last output: running plot suite");

    const idle = recordWatchObservation(working, {
      now: 200,
      observation: { state: "idle", agentStatus: "idle", excerpt: "❯", at: 200 },
      summary: "Agent idle.",
    });
    const idleAnnouncement = externalAnnouncementFor(event("state-change", idle))!;
    expect(idleAnnouncement.message).toContain("went idle");
    expect(idleAnnouncement.message).toContain("needs inspection, not completion");
    // State-change keys differ per state, so each change can speak once.
    expect(idleAnnouncement.key).not.toBe(externalAnnouncementFor(event("state-change", working))!.key);

    const done = recordWatchObservation(idle, {
      now: 300,
      observation: { state: "done", agentStatus: "done", at: 300 },
      summary: "Agent done.",
    });
    expect(externalAnnouncementFor(event("state-change", done))!.message)
      .toContain("reports done — verify the outcome");
  });

  it("speaks monitoring loss and recovery but never raw output evidence", () => {
    const target = watch();
    expect(externalAnnouncementFor(event("offline", target))!.message).toContain("Lost contact with exodia");
    expect(externalAnnouncementFor(event("recovered", target))!.message).toContain("Contact with exodia is back");
    expect(externalAnnouncementFor(event("mismatched", target))!.message).toContain("different session");
    expect(externalAnnouncementFor(event("output-evidence", target))).toBeUndefined();
  });

  it("check-ins state current activity and say when there is no new evidence", () => {
    const active = recordWatchObservation(watch(), {
      now: 150,
      observation: { state: "working", agentStatus: "working", at: 150 },
      summary: "working",
    });
    const checkIn = externalCheckInMessage([active], EXTERNAL_CHECK_IN_MS)!;
    expect(checkIn.message).toContain("Still watching the agent on exodia");
    expect(checkIn.message).toContain("currently working");
    expect(checkIn.message).toContain("No new verified progress since the last report.");
    // Fresh speech suppresses the no-evidence line but not the check-in.
    expect(externalCheckInMessage([active], 1_000)!.message).not.toContain("No new verified progress");
    // Nothing to watch: no check-in at all.
    expect(externalCheckInMessage([watch({ status: "stopped" })], EXTERNAL_CHECK_IN_MS)).toBeUndefined();
    expect(externalCheckInMessage([], EXTERNAL_CHECK_IN_MS)).toBeUndefined();
  });
});
