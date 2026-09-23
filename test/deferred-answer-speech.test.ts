import { describe, expect, it } from "vitest";
import { deferredAnswerSpeech } from "../src/application/live-gateway/deferred-answer-speech.js";

describe("deferredAnswerSpeech", () => {
  it("keeps short answers verbatim", () => {
    expect(deferredAnswerSpeech("The release audit passed. All checks are green.")).toBe(
      "The release audit passed. All checks are green.",
    );
  });

  it("caps at three sentences", () => {
    const answer = "One. Two. Three. Four. Five.";
    expect(deferredAnswerSpeech(answer)).toBe("One. Two. Three.");
  });

  it("caps at 500 characters on a sentence-boundary-safe prefix", () => {
    const long = `${"Word ".repeat(200)}.`;
    const speech = deferredAnswerSpeech(long);
    expect(speech.length).toBeLessThanOrEqual(500);
    expect(speech.endsWith("…")).toBe(true);
  });

  it("replaces code fences with the on-screen cue and strips inline code markers and URLs", () => {
    const answer = "I fixed it. ```python\nprint('hi')\n``` Run `npm test` now. See https://example.com/docs for more.";
    expect(deferredAnswerSpeech(answer)).toBe(
      "I fixed it. The details are available on screen. Run npm test now.",
    );
  });

  it("collapses control characters and whitespace", () => {
    expect(deferredAnswerSpeech("Line one.\n\n\tLine two.   ")).toBe("Line one. Line two.");
  });

  it("says where code-only results live instead of a vague placeholder", () => {
    expect(deferredAnswerSpeech("```js\nonly code\n```")).toBe(
      "The details are available on screen.",
    );
  });

  it("falls back to a spoken placeholder when nothing speakable remains", () => {
    expect(deferredAnswerSpeech("https://example.com/only-a-link")).toBe(
      "I have the result, but it is not easy to say out loud.",
    );
  });
});
