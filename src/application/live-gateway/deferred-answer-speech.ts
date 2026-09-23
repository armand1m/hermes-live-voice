// Speech shaping for deferred Hermes answers: the async tool path returns an
// instant spoken receipt and delivers the real answer later through the
// provider's exact-speech channel, which is bounded to short speakable text.

import { prepareSpokenContent } from "../../domain/speech/spoken-content.js";

const MAX_SPEECH_CHARS = 500;
const MAX_SENTENCES = 3;

/**
 * Reduce a Hermes answer to at most three sentences and 500 chars of
 * speakable text. Structure removal is the shared spoken-content cleanup
 * (plan §E) — this shaper only bounds length and adds the truncation cue.
 */
export function deferredAnswerSpeech(answer: string): string {
  const flat = prepareSpokenContent(answer, { maxChars: 4 * MAX_SPEECH_CHARS });
  if (!flat) return "I have the result, but it is not easy to say out loud.";
  const sentences = flat.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/gu) ?? [flat];
  let speech = "";
  for (const sentence of sentences.slice(0, MAX_SENTENCES)) {
    if ((speech + sentence).trim().length > MAX_SPEECH_CHARS) break;
    speech += sentence;
  }
  const sentenceSpeech = speech.trim();
  if (sentenceSpeech) return sentenceSpeech;
  return `${flat.slice(0, MAX_SPEECH_CHARS - 1).trimEnd()}…`;
}
