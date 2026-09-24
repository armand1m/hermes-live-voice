import { describe, expect, it } from "vitest";
import {
  AgentWatchRecordSchema,
  createAgentWatchRecord,
  createWatchId,
  hashWatchOwnerId,
  markWatchMismatched,
  noteWatchAnnounced,
  recordWatchHostFailure,
  recordWatchObservation,
  stopWatch,
} from "../src/domain/external-work/index.js";
import { appendTaskEvent, transitionTask, createTaskRecord, canTransitionTask, isTaskTerminal } from "../src/domain/tasks/index.js";

const WATCH_INPUT = {
  ownerId: hashWatchOwnerId("profile:default:user:voice"),
  host: "exodia" as const,
  harness: "herdr" as const,
  agentSessionValue: "4432988d-611f-437a-8b3a-9937984a86e2",
  paneId: "w4:p1",
  objective: "Fix the diamond indicator and verify on the plot.",
  acceptanceCriteria: ["Plot renders", "Tests pass"],
};

describe("agent watch domain", () => {
  it("creates a durable watch with pattern-validated identity", () => {
    const watch = createAgentWatchRecord({ ...WATCH_INPUT, now: 100, workspaceId: "w4", linkedTaskId: `task_${"a".repeat(32)}` });
    expect(watch.watchId).toMatch(/^watch_[0-9a-f]{32}$/);
    expect(createWatchId()).not.toBe(createWatchId());
    expect(watch).toMatchObject({
      status: "watching",
      host: "exodia",
      harness: "herdr",
      paneId: "w4:p1",
      revision: 1,
      sequence: 1,
    });
    expect(watch.events.at(-1)?.type).toBe("watch.started");
    // Identity fields are tightly patterned: a pane id that could smuggle
    // shell syntax through a remote transport is rejected outright.
    expect(() => createAgentWatchRecord({ ...WATCH_INPUT, paneId: "w4:p1; rm -rf" })).toThrow(/w4:p1/);
    // Newlines in a session identity are sanitized to spaces, not rejected —
    // the value is single-line evidence either way.
    expect(createAgentWatchRecord({ ...WATCH_INPUT, agentSessionValue: "bad\nvalue" }).agentSessionValue)
      .toBe("bad value");
    expect(() => createAgentWatchRecord({ ...WATCH_INPUT, host: "laptop" as never })).toThrow();
  });

  it("records observations: state changes append events, repeats refresh cheaply", () => {
    let watch = createAgentWatchRecord({ ...WATCH_INPUT, now: 100 });
    watch = recordWatchObservation(watch, {
      now: 150,
      observation: { state: "working", agentStatus: "working", agentRevision: 3, stateChangeSeq: 10, at: 150 },
      summary: "Agent working.",
    });
    expect(watch.lastObserved).toMatchObject({ state: "working", agentStatus: "working" });
    expect(watch.events).toHaveLength(2);
    expect(watch.monitoring).toMatchObject({ consecutiveFailures: 0, lastSuccessAt: 150 });

    // Same state again: no new event, but the observation cursor advances.
    watch = recordWatchObservation(watch, {
      now: 160,
      observation: { state: "working", agentStatus: "working", agentRevision: 4, stateChangeSeq: 11, at: 160 },
    });
    expect(watch.events).toHaveLength(2);
    expect(watch.lastObserved?.agentRevision).toBe(4);

    // working → idle is the honest distinction: idle needs inspection.
    watch = recordWatchObservation(watch, {
      now: 200,
      observation: { state: "idle", agentStatus: "idle", agentRevision: 5, stateChangeSeq: 12, excerpt: "❯", at: 200 },
      summary: "Agent idle; outcome needs inspection.",
    });
    expect(watch.events.at(-1)?.type).toBe("observation.changed");
    expect(watch.events.at(-1)?.summary).toContain("idle");
  });

  it("degrades to offline only after three consecutive host failures and records the error", () => {
    let watch = createAgentWatchRecord({ ...WATCH_INPUT, now: 100 });
    watch = recordWatchObservation(watch, {
      now: 110,
      observation: { state: "working", agentStatus: "working", at: 110 },
    });
    watch = recordWatchHostFailure(watch, { error: "ssh: connect timed out", now: 120 });
    watch = recordWatchHostFailure(watch, { error: "ssh: connect timed out", now: 130 });
    expect(watch.lastObserved?.state).toBe("working");
    watch = recordWatchHostFailure(watch, { error: "ssh: connect timed out", now: 140 });
    expect(watch.monitoring.consecutiveFailures).toBe(3);
    expect(watch.lastObserved?.state).toBe("offline");
    expect(watch.events.at(-1)?.type).toBe("monitoring.degraded");
    // A later success recovers both health and state.
    watch = recordWatchObservation(watch, {
      now: 200,
      observation: { state: "working", agentStatus: "working", at: 200 },
      summary: "Host reachable again; agent working.",
    });
    expect(watch.monitoring.consecutiveFailures).toBe(0);
    expect(watch.lastObserved?.state).toBe("working");
  });

  it("marks pane reuse as a mismatch instead of silently following different work", () => {
    let watch = createAgentWatchRecord({ ...WATCH_INPUT, now: 100 });
    watch = markWatchMismatched(watch, { expectedSessionValue: WATCH_INPUT.agentSessionValue, now: 150 });
    expect(watch.status).toBe("mismatched");
    expect(watch.events.at(-1)?.type).toBe("identity.mismatched");
    expect(watch.events.at(-1)?.summary).toContain("different session");
    // Mismatched watches ignore further observations rather than re-attach.
    const unchanged = recordWatchObservation(watch, {
      now: 200,
      observation: { state: "working", at: 200 },
    });
    expect(unchanged.lastObserved?.state).toBeUndefined();
    expect(() => AgentWatchRecordSchema.parse({ ...watch, status: "mismatched", events: watch.events.slice(0, -1) }))
      .toThrow(/mismatch event/);
  });

  it("stops cleanly and tracks announcements idempotently", () => {
    let watch = createAgentWatchRecord({ ...WATCH_INPUT, now: 100 });
    watch = stopWatch(watch, { now: 150, reason: "Owner released the watch." });
    expect(watch.status).toBe("stopped");
    expect(stopWatch(watch, { now: 200 }).revision).toBe(watch.revision);
    const announced = noteWatchAnnounced(watch, "idle:5", 160);
    expect(announced.lastAnnouncedKey).toBe("idle:5");
    expect(announced.updatedAt).toBe(160);
  });
});

describe("delegated task phase", () => {
  const running = () => transitionTask(
    transitionTask(
      createTaskRecord({ ownerIdentity: "owner", input: "Delegate the diamond fix", now: 10 }),
      "dispatching",
      { now: 11 },
    ),
    "running",
    { now: 12, runId: "run_launch" },
  );

  it("enters delegated from running and leaves only by explicit disposition", () => {
    const task = transitionTask(running(), "delegated", { now: 20, summary: "Agent launched on exodia." });
    expect(task.status).toBe("delegated");
    expect(isTaskTerminal(task.status)).toBe(false);
    expect(task.events.at(-1)?.type).toBe("delegated");
    // Upstream run lifecycle can never complete or resume it...
    expect(canTransitionTask("delegated", "completed")).toBe(true); // ...only an explicit disposition can
    expect(canTransitionTask("delegated", "running")).toBe(false);
    expect(canTransitionTask("delegated", "queued")).toBe(false);
    expect(canTransitionTask("running", "delegated")).toBe(true);
    expect(canTransitionTask("queued", "delegated")).toBe(false);
    // Progress events keep flowing from monitor observations.
    expect(appendTaskEvent(task, { now: 30, summary: "External agent on exodia: working" }).events.at(-1)?.type)
      .toBe("progress");
  });
});
