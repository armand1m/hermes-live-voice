// Speech shaping for deferred Hermes answers: the async tool path returns an
// instant spoken receipt and delivers the real answer later through the
// provider's exact-speech channel, which is bounded to short speakable text.

const MAX_SPEECH_CHARS = 500;
const MAX_SENTENCES = 3;

/**
 * Reduce a Hermes answer to at most three sentences and 500 chars of
 * speakable text: control characters collapse, fenced code blocks and inline
 * code markers drop out, and bare URLs are skipped (painful to hear aloud).
 */
export function deferredAnswerSpeech(answer: string): string {
  const flat = answer
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/`([^`]*)`/gu, "$1")
    .replace(/https?:\/\/\S+/gu, " ")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
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
