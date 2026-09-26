import { describe, expect, it } from "vitest";
import { moodHint, parseLayaMood } from "../src/application/live-gateway/laya-mood.js";
// Browser-only module intentionally ships as plain ESM JavaScript.
// @ts-expect-error No declaration file is emitted for browser assets.
import { formatUserMood } from "../clients/browser/diagnostics.js";

const answers = (score: number, choice: string) => ({
  small_talk: { type: "noul", noul: 0.12 },
  frustration: { type: "score", score },
  mood: { type: "choice", choice, confidence: 0.41 },
});

describe("parseLayaMood", () => {
  it("reads the frustration level, its label, and the mood word", () => {
    expect(parseLayaMood(answers(2.24, "frustrated"), 1_000)).toEqual({
      frustration: 2.24, frustrationLabel: "clearly annoyed", mood: "frustrated", moodConfidence: 0.41, smallTalk: 0.12, at: 1_000,
    });
  });

  it("rejects incomplete or unknown answers", () => {
    expect(parseLayaMood({ frustration: { score: 1 } }, 0)).toBeUndefined();
    expect(parseLayaMood(answers(1, "ecstatic"), 0)).toBeUndefined();
  });
});

describe("moodHint", () => {
  const at = 10_000;
  it("tells the brain about recent frustration, stress, or confusion only", () => {
    expect(moodHint(parseLayaMood(answers(2.1, "curious"), at), at + 1_000)).toContain("sounded frustrated (2.1 of 3)");
    expect(moodHint(parseLayaMood(answers(0.4, "stressed"), at), at + 1_000)).toContain("stressed");
    expect(moodHint(parseLayaMood(answers(0.3, "confused"), at), at + 1_000)).toContain("confused");
    expect(moodHint(parseLayaMood(answers(0.2, "happy"), at), at + 1_000)).toBeUndefined();
    expect(moodHint(parseLayaMood(answers(0.2, "calm"), at), at + 1_000)).toBeUndefined();
  });

  it("forgets moods older than three minutes", () => {
    expect(moodHint(parseLayaMood(answers(2.8, "frustrated"), at), at + 3 * 60_000 + 1)).toBeUndefined();
  });
});

describe("formatUserMood (diagnostics overlay)", () => {
  it("shows mood, frustration, and age; marks stale readings", () => {
    expect(formatUserMood({ mood: "frustrated", frustration: 2.1, ageMs: 12_000 })).toBe("frustrated · 2.1/3 · 12s");
    expect(formatUserMood({ mood: "calm", frustration: 0.25, ageMs: 5 * 60_000 })).toBe("(calm · 0.3/3 · 5m)");
    expect(formatUserMood(null)).toBe("—");
  });
});
