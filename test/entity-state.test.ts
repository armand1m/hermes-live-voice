import { describe, expect, it } from "vitest";
// Browser-only module intentionally ships as plain ESM JavaScript.
// @ts-expect-error No declaration file is emitted for browser assets.
import { AgentStateController, EXPRESSIONS, Spring, TextVisemeScheduler } from "../clients/browser/entity-state.js";

const frame = { speakingNow: false, micActive: true };

function advance(controller: any, seconds = 1, dt = 1 / 60): void {
  for (let elapsed = 0; elapsed < seconds; elapsed += dt) controller.update(dt, frame);
}

describe("AgentStateController", () => {
  it("keeps amplitude visual-only and lets VAD exclusively own listening state", () => {
    const controller = new AgentStateController();
    controller.connectionState("ready");

    controller.userLevel(1);
    controller.update(1 / 60, frame);
    expect(controller.micLevel).toBeGreaterThan(0.9);
    expect(controller.listeningActive).toBe(false);
    expect(controller.canvasState).toBe("idle");

    controller.userSpeechStarted();
    expect(controller.listeningActive).toBe(true);
    controller.userSpeechEnded();
    expect(controller.listeningActive).toBe(false);
  });

  it("releases tool activity and exposes background task waiting mode", () => {
    const controller = new AgentStateController();
    controller.connectionState("ready");
    controller.toolStarted();
    advance(controller, 0.5);
    expect(controller.springs.toolActivity.value).toBeGreaterThan(0.3);
    expect(controller.mode).toBe("tool");

    controller.toolEnded(true);
    advance(controller, 1);
    expect(controller.springs.toolActivity.target).toBe(0);
    expect(controller.springs.toolActivity.value).toBeLessThan(0.3);

    controller.taskWaitingChanged(true);
    controller.update(1 / 60, frame);
    expect(controller.mode).toBe("waiting");
    expect(controller.canvasState).toBe("waiting");

    controller.toolStarted();
    controller.taskWaitingChanged(false);
    expect(controller.springs.toolActivity.target).toBe(0);
  });

  it("supports signed gaze and expression tilt spring targets", () => {
    const signed = new Spring(0, { min: -1, max: 1 });
    signed.set(-0.7);
    advanceSpring(signed);
    expect(signed.value).toBeLessThan(-0.5);

    const controller = new AgentStateController();
    controller.connectionState("ready");
    controller.responseStarted();
    advance(controller, 0.8);
    expect(controller.expressionSprings.tiltZ.target).toBe(EXPRESSIONS.processing.tiltZ);
    expect(controller.expression.tiltZ).toBeLessThan(0);
  });

  it("removes gaze drift under reduced motion while preserving state intent", () => {
    const controller = new AgentStateController({ reducedMotion: true });
    controller.connectionState("ready");
    advance(controller, 1);
    expect(controller.springs.gazeX.target).toBe(0);
    expect(controller.springs.gazeY.target).toBe(0);

    controller.responseStarted();
    advance(controller, 0.5);
    expect(controller.springs.gazeX.target).toBe(0);
    expect(controller.springs.gazeY.target).toBe(0.18);
  });

  it("lets an error temporarily override an active expression pulse", () => {
    const controller = new AgentStateController();
    controller.connectionState("ready");
    controller.pulseExpression("amused", 4);
    advance(controller, 0.25);
    expect(controller.expression.smile).toBeGreaterThan(EXPRESSIONS.error.smile);

    controller.error();
    advance(controller, 0.35);
    expect(controller.expressionBase).toBe(EXPRESSIONS.error);
    expect(controller.expressionSprings.smile.target).toBe(EXPRESSIONS.error.smile);
    expect(controller.expressionSprings.concern.target).toBe(EXPRESSIONS.error.concern);
  });
});

function advanceSpring(spring: any, seconds = 1, dt = 1 / 60): void {
  for (let elapsed = 0; elapsed < seconds; elapsed += dt) spring.step(dt);
}

describe("TextVisemeScheduler", () => {
  const tick = (scheduler: any, seconds: number, activity = 0.6, dt = 1 / 60) => {
    for (let elapsed = 0; elapsed < seconds; elapsed += dt) scheduler.update(dt, activity);
  };

  it("articulates fed text as alternating visemes instead of generic flapping", () => {
    const scheduler = new TextVisemeScheduler();
    scheduler.feed("mama");
    // Bilabial closures queue as `closed`, the vowel between them as `open`.
    const names = scheduler.queue.map((unit: any[]) => unit[0]);
    expect(names).toContain("closed");
    expect(names).toContain("open");
    const closedIndex = names.indexOf("closed");
    const openIndex = names.indexOf("open");
    expect(Math.abs(closedIndex - openIndex)).toBe(1);
  });

  it("maps rounded and spread vowels to distinct shapes", () => {
    const round = new TextVisemeScheduler();
    round.feed("moor");
    expect(round.queue.some((unit: any[]) => unit[0] === "round")).toBe(true);

    const spread = new TextVisemeScheduler();
    spread.feed("fees");
    expect(spread.queue.some((unit: any[]) => unit[0] === "wide")).toBe(true);
    expect(spread.queue.some((unit: any[]) => unit[0] === "teeth")).toBe(true);
  });

  it("gates mouth amplitude on live audio and closes when speech stops", () => {
    const scheduler = new TextVisemeScheduler();
    scheduler.feed("hello");
    tick(scheduler, 0.3, 0.5);
    expect(scheduler.weights.open + scheduler.weights.round + scheduler.weights.wide).toBeGreaterThan(0.05);

    // Silent audio for long enough abandons the remaining queue and closes.
    tick(scheduler, 0.8, 0.0);
    expect(scheduler.queue.length).toBe(0);
    expect(scheduler.active).toBe(0);
    tick(scheduler, 0.5, 0.0);
    expect(scheduler.weights.closed).toBeGreaterThan(0.9);
  });

  it("collapses an overlong backlog instead of falling behind the reveal", () => {
    const scheduler = new TextVisemeScheduler();
    for (let i = 0; i < 20; i++) scheduler.feed("announcement ");
    expect(scheduler.queued).toBeLessThan(1.6);
    // Long vowels survive compression; total hold stays bounded.
    expect(scheduler.queue.length).toBeGreaterThan(4);
  });

  it("resets cleanly between utterances", () => {
    const scheduler = new TextVisemeScheduler();
    scheduler.feed("interrupted");
    tick(scheduler, 0.1, 0.5);
    scheduler.reset();
    expect(scheduler.queue.length).toBe(0);
    expect(scheduler.active).toBe(0);
    scheduler.feed("fresh");
    tick(scheduler, 0.2, 0.5);
    expect(scheduler.active).toBeGreaterThan(0.5);
  });
});

describe("background work feedback", () => {
  it("keeps workIntensity sustained while tasks run and clears it when they end", async () => {
    const controller = new AgentStateController({ reducedMotion: true });
    controller.connectionState("ready");
    controller.microphoneState("active");
    controller.userSpeechStarted();
    controller.userSpeechEnded();

    controller.toolStarted();
    controller.taskWaitingChanged(true);
    // Long after the momentary tool spike decays, sustained work remains.
    for (let i = 0; i < 420; i += 1) controller.update(1 / 60, { speakingNow: false, micActive: true });
    const visual = controller.readout();
    expect(visual.workIntensity).toBeGreaterThan(0.8);
    expect(visual.toolActivity).toBeLessThan(0.3);
    // Work is an overlay, not a mode swap: whichever idle mode applies, the
    // sustained work signal stays high for the whole run.
    expect(['listening', 'waiting']).toContain(visual.mode);

    controller.taskWaitingChanged(false);
    for (let i = 0; i < 240; i += 1) controller.update(1 / 60, { speakingNow: false, micActive: true });
    expect(controller.readout().workIntensity).toBeLessThan(0.1);
  });
});
