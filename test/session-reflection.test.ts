import { describe, expect, it } from "vitest";
import {
  ReflectionTranscript,
  buildReflectionInput,
  reflectionSessionId,
} from "../src/application/knowledge/session-reflection.js";

describe("session reflection", () => {
  it("needs at least four user turns", () => {
    const transcript = new ReflectionTranscript();
    for (let turn = 0; turn < 3; turn += 1) transcript.add("user", `question ${turn}`);
    expect(buildReflectionInput(transcript.snapshot(), 0)).toBeUndefined();
    transcript.add("user", "question 3");
    expect(buildReflectionInput(transcript.snapshot(), 0)).toContain("User: question 3");
  });

  it("keeps the most recent turns within the transcript budget", () => {
    const transcript = new ReflectionTranscript();
    for (let turn = 0; turn < 80; turn += 1) transcript.add(turn % 2 ? "assistant" : "user", `${turn} ${"x".repeat(390)}`);
    const input = buildReflectionInput(transcript.snapshot(), Date.UTC(2026, 8, 24))!;
    expect(input.length).toBeLessThan(12_500);
    expect(input).toContain("Assistant: 79 ");
    expect(input).not.toContain("User: 0 ");
    expect(input.startsWith("Voice conversation that ended at 2026-09-24")).toBe(true);
  });

  it("groups reflections per day in their own Hermes session", () => {
    expect(reflectionSessionId(Date.UTC(2026, 8, 24, 23, 59))).toBe("hermes-live:reflection:2026-09-24");
  });
});
