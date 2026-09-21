import { describe, expect, it } from "vitest";
import { SpeechTimingTracker } from "../src/application/live-gateway/speech-timing.js";

describe("SpeechTimingTracker", () => {
  it("measures tool call to first provider speech and clears the pending mark", () => {
    const tracker = new SpeechTimingTracker();
    tracker.noteToolCallStarted(1_000);
    // A second concurrent call keeps the earliest wait as the reference.
    tracker.noteToolCallStarted(1_200);
    tracker.noteResponseStarted(undefined, 3_500);
    const metrics = tracker.metrics();
    expect(metrics.toolSpeechP50Ms).toBe(2_500);
    expect(metrics.toolSpeechP95Ms).toBe(2_500);

    // Without a pending tool call, response starts are not sampled.
    tracker.noteResponseStarted(undefined, 4_000);
    expect(tracker.metrics().toolSpeechP50Ms).toBe(2_500);
  });

  it("ignores task-notification speech as a tool answer", () => {
    const tracker = new SpeechTimingTracker();
    tracker.noteToolCallStarted(1_000);
    tracker.noteResponseStarted("task_notification", 9_000);
    expect(tracker.metrics().toolSpeechP50Ms).toBeNull();
    // The pending mark survives for the real conversational response.
    tracker.noteResponseStarted(undefined, 10_000);
    expect(tracker.metrics().toolSpeechP50Ms).toBe(9_000);
  });

  it("measures announcement delivery lag once per task", () => {
    const tracker = new SpeechTimingTracker();
    tracker.noteAnnouncementPending("task_a", 1_000);
    // Re-notifying the same task (retry path) keeps the first sighting.
    tracker.noteAnnouncementPending("task_a", 5_000);
    tracker.noteAnnouncementDelivered("task_a", 61_000);
    expect(tracker.metrics().announcementDelayP50Ms).toBe(60_000);

    // Delivery without a sighting is ignored; forgotten announcements never
    // sample.
    tracker.noteAnnouncementDelivered("task_b", 70_000);
    tracker.noteAnnouncementPending("task_c", 80_000);
    tracker.forgetAnnouncement("task_c");
    tracker.noteAnnouncementDelivered("task_c", 90_000);
    expect(tracker.metrics().announcementDelayP50Ms).toBe(60_000);
  });

  it("counts filler injections", () => {
    const tracker = new SpeechTimingTracker();
    expect(tracker.metrics().fillerInjections).toBe(0);
    tracker.noteFillerInjection();
    tracker.noteFillerInjection();
    expect(tracker.metrics().fillerInjections).toBe(2);
  });

  it("bounds the pending-announcement ledger", () => {
    const tracker = new SpeechTimingTracker();
    for (let index = 0; index < 80; index += 1) {
      tracker.noteAnnouncementPending(`task_${index}`, index);
    }
    // The oldest sightings were evicted; delivering them is a no-op, not a
    // multi-minute latency sample.
    tracker.noteAnnouncementDelivered("task_0", 1_000_000);
    expect(tracker.metrics().announcementDelayP50Ms).toBeNull();
    tracker.noteAnnouncementDelivered("task_79", 158);
    expect(tracker.metrics().announcementDelayP50Ms).toBe(79);
  });
});
