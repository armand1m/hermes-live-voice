// The user's emotional state as LAYA reads it from the last utterance: a
// frustration level on a 0-3 scale plus one mood word. Surfaced in the
// diagnostics overlay and, optionally, as a short hint to the voice brain.
// Offline re-test (2026-09-26, 13 hand-labeled turns): the frustration score
// separated frustrated from positive turns perfectly; the mood word is a
// weaker, secondary signal (it often reads frustration as "curious").

export const FRUSTRATION_LEVELS = ["calm and neutral", "mildly impatient", "clearly annoyed", "very frustrated or upset"] as const;
export const MOOD_WORDS = {
  calm: "relaxed or neutral",
  happy: "pleased, impressed, or excited",
  curious: "interested, asking questions",
  frustrated: "annoyed, impatient, or let down",
  stressed: "worried, rushed, or overwhelmed",
  confused: "unsure or puzzled",
} as const;
export type MoodWord = keyof typeof MOOD_WORDS;

/** A mood older than this no longer describes the user. */
export const MOOD_FRESH_MS = 3 * 60_000;
/** Frustration score (0-3, expected level) at which the brain is told. */
export const FRUSTRATION_HINT_THRESHOLD = 1.5;

export interface LayaMood {
  /** Expected frustration level, 0 (calm) to 3 (very frustrated). */
  frustration: number;
  frustrationLabel: string;
  mood: MoodWord;
  moodConfidence: number;
  /** Probability the utterance was only small talk. */
  smallTalk: number;
  at: number;
}

/** Parse the mood answers of one sidecar reply; undefined when incomplete. */
export function parseLayaMood(answers: Record<string, unknown>, at: number): LayaMood | undefined {
  const frustration = answers.frustration as { score?: unknown } | undefined;
  const mood = answers.mood as { choice?: unknown; confidence?: unknown } | undefined;
  const smallTalk = answers.small_talk as { noul?: unknown } | undefined;
  const score = typeof frustration?.score === "number" ? frustration.score : undefined;
  const word = typeof mood?.choice === "string" && mood.choice in MOOD_WORDS ? mood.choice as MoodWord : undefined;
  if (score === undefined || word === undefined) return undefined;
  const clamped = Math.max(0, Math.min(3, score));
  return {
    frustration: Math.round(clamped * 100) / 100,
    frustrationLabel: FRUSTRATION_LEVELS[Math.round(clamped)]!,
    mood: word,
    moodConfidence: typeof mood?.confidence === "number" ? mood.confidence : 0,
    smallTalk: typeof smallTalk?.noul === "number" ? smallTalk.noul : 0,
    at,
  };
}

/**
 * A one-line steering hint for the brain's next turn, or undefined when the
 * mood is stale or unremarkable. It describes the previous message (LAYA
 * answers after the brain has already started on the current one), framed as
 * reference data rather than instructions about the task.
 */
export function moodHint(mood: LayaMood | undefined, now: number): string | undefined {
  if (!mood || now - mood.at > MOOD_FRESH_MS) return undefined;
  let guidance: string | undefined;
  if (mood.frustration >= FRUSTRATION_HINT_THRESHOLD || mood.mood === "frustrated") {
    guidance = `sounded frustrated (${mood.frustration.toFixed(1)} of 3). Acknowledge it in a few words, then be brief and concrete; do not over-apologize.`;
  } else if (mood.mood === "stressed") {
    guidance = "sounded stressed or rushed. Keep the answer short and lead with what matters most.";
  } else if (mood.mood === "confused") {
    guidance = "sounded confused. Answer plainly and check that the point landed.";
  }
  if (!guidance) return undefined;
  return `[HERMES_LIVE_USER_STATE_V1] The user's previous message ${guidance} [/HERMES_LIVE_USER_STATE_V1]`;
}
