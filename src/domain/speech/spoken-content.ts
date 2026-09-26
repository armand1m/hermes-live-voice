/**
 * Spoken-content preparation (plan §E): one deterministic cleanup applied at
 * every text-to-speech boundary — direct replies, tool receipts, deferred
 * answers, notifications, and the sidecar speech path.
 *
 * Display keeps Markdown, technical detail, and full results. Spoken text
 * must be natural sentences that preserve factual qualifications: negation,
 * quantities, units, and technical values pass through untouched — cleanup
 * removes structure, never meaning. Malformed and incomplete markup degrades
 * to the same plain text rather than leaking markers into speech.
 */

/** Default ceiling for a single spoken utterance after cleanup. */
export const DEFAULT_SPOKEN_MAX_CHARS = 6_000;
export const DEFAULT_SPOKEN_DETAIL_CUE = "The details are available on screen.";

/** Reasoning blocks some models emit around the actual answer. */
const THINK_BLOCK = /<(?:think|thinking|reasoning)>[\s\S]*?<\/(?:think|thinking|reasoning)>/giu;
const UNTERMINATED_THINK = /<(?:think|thinking|reasoning)>[\s\S]*$/iu;
/** Fenced code blocks (``` or ~~~), including their info strings. LLM fences
 * often trail a sentence rather than opening a line, so no line-start anchor. */
const FENCED_CODE = /[ \t]*(?:```|~~~)[^\n]*\n[\s\S]*?(?:[ \t]*(?:```|~~~)|$)/gu;
const STRAY_FENCE = /^[ \t]*(?:```|~~~)/mu;
/** A table row: a line with two or more pipe separators. */
const TABLE_ROW = /^[ \t]*\|?[ \t]*[^|\n]+[ \t]*\|[ \t]*[^|\n]+.*\|/u;
/** Markdown links: the label speaks, the target never does. */
const IMAGE_LINK = /!\[([^\]\n]*)\]\([^)\n]*\)/gu;
const MARKDOWN_LINK = /\[([^\]\n]*)\]\([^)\n]*\)/gu;
const REFERENCE_LINK = /\[([^\]\n]*)\]\[[^\]\n]*\]/gu;
const AUTOLINK = /<https?:\/\/[^>\n]+>/giu;
const BARE_URL = /\bhttps?:\/\/\S+/giu;
/** Block-level HTML tags (open or close) become spacing; tag text never speaks. */
const HTML_TAG = /<\/?[a-z][^>\n]*>/giu;
/** Setext heading underlines and horizontal rules. */
const SETEXT_OR_RULE = /\n[ \t]*(?:={3,}|-{3,}|\*{3,}|_{3,})[ \t]*(?=\n)/gu;
/** Emphasis pairs. Intraword markers stay: a_b_c and 2*3 keep their characters. */
const BOLD_ITALIC = /(?<![\w\\])(\*{1,3}|_{1,3})(?=\S)([\s\S]*?\S)\1(?![\w])/gu;
const STRIKETHROUGH = /~~(?=\S)([\s\S]*?\S)~~/gu;
/** List markers: hyphens, bullets, or ordered labels starting a line. */
const LIST_ITEM = /^[ \t]*(?:[-*+•]|\d{1,3}[.)])[ \t]+([^\n]*)$/gmu;
/** Sentence-final punctuation: nothing more needs adding after these. */
const TERMINAL_PUNCTUATION = /[.!?…]["')\]]?$/u;
/** Clause-final punctuation: a following break needs only spacing, not a period. */
const CLAUSE_PUNCTUATION = /[,;:.!?…]["')\]]?$/u;
/** Control, format, and bidi characters never reach synthesis. */
const UNSAFE_SPOKEN_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/gu;
/** Entities worth decoding; anything rarer is dropped with its markup. */
const HTML_ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": "\"",
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

export interface PrepareSpokenContentOptions {
  /** Hard ceiling after cleanup; the tail is cut at a sentence boundary when possible. */
  maxChars?: number;
  /** Cue replacing fenced code blocks and dense tables. */
  detailCue?: string;
}

export function prepareSpokenContent(
  text: string,
  options: PrepareSpokenContentOptions = {},
): string {
  const maxChars = options.maxChars ?? DEFAULT_SPOKEN_MAX_CHARS;
  const detailCue = options.detailCue ?? DEFAULT_SPOKEN_DETAIL_CUE;
  if (typeof text !== "string" || text.trim() === "") return "";

  let spoken = text
    // Reasoning never speaks, even as an unbalanced opening block.
    .replace(THINK_BLOCK, " ")
    .replace(UNTERMINATED_THINK, " ")
    // Code blocks carry unspeakable structure.
    .replace(FENCED_CODE, ` ${detailCue} `)
    // Block structure before inline forms.
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gmu, " ")
    .replace(/^[ \t]{0,3}>[ \t]?/gmu, " ")
    .replace(SETEXT_OR_RULE, " ")
    .replace(HTML_TAG, " ")
    // Links: keep the label, never the target.
    .replace(IMAGE_LINK, " ")
    .replace(MARKDOWN_LINK, "$1")
    .replace(REFERENCE_LINK, "$1")
    .replace(AUTOLINK, " ")
    .replace(BARE_URL, " ")
    // Emphasis markers drop; their text stays.
    .replace(STRIKETHROUGH, "$1")
    .replace(BOLD_ITALIC, "$2")
    // Inline code: the code speaks (a command or path is worth hearing);
    // its markers never do. Stray single markers drop too.
    .replace(/`+([^`\n]+)`+/gu, "$1")
    .replace(/`/gu, "")
    // Safe entity decoding only after tag stripping.
    .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/gu, (entity) => HTML_ENTITIES[entity] ?? " ");

  // Tables: collapse each consecutive row block into the cue.
  spoken = collapseTableBlocks(spoken, detailCue);
  // Lists become sentences: markers drop, unterminated items gain a period so
  // adjacent items cannot merge into a run-on.
  spoken = spoken.replace(LIST_ITEM, (_match, item: string) =>
    TERMINAL_PUNCTUATION.test(item.trim()) ? item : `${item}.`);

  // A fence that survived the balanced pass is unterminated: everything after
  // the stray marker is code, not speech.
  const strayFence = spoken.search(STRAY_FENCE);
  if (strayFence >= 0) {
    spoken = `${spoken.slice(0, strayFence)} ${detailCue}`;
  }

  spoken = spoken
    .replace(/\r\n?/gu, "\n")
    // Control, format, and bidi characters never reach synthesis. Newlines
    // and tabs stay: the sentence rules below still need the line structure.
    .replace(UNSAFE_SPOKEN_CHARS, " ")
    // Paragraph breaks separate sentences; a line already ending in clause
    // punctuation must not gain a second full stop.
    .replace(/([^\n])[ \t]*\n{2,}[ \t]*/gu, (_match, previous: string) =>
      CLAUSE_PUNCTUATION.test(previous) ? `${previous} ` : `${previous}. `)
    .replace(/([^\n])\n(?!\n)/gu, "$1 ")
    .replace(/[ \t]{2,}/gu, " ")
    // Punctuation spacing for speech: gaps before punctuation close up, and
    // run-together commas/colons gain a pause — unless digits sit astride the
    // mark (thousands separators, ratios, and versions stay verbatim).
    // …but a period that starts a word (".ts", ".env") is not punctuation.
    .replace(/ +([,;:!?]|\.(?![\p{L}\p{N}]))/gu, "$1")
    .replace(/([,;:])(?=[A-Za-z])/gu, "$1 ")
    .replace(/ {2,}/gu, " ")
    .trim();

  if (spoken === "") return "";
  if (spoken.length <= maxChars) return spoken;
  const bounded = spoken.slice(0, maxChars);
  const lastSentenceEnd = Math.max(bounded.lastIndexOf(". "), bounded.lastIndexOf("! "), bounded.lastIndexOf("? "));
  const cut = lastSentenceEnd > maxChars * 0.5 ? lastSentenceEnd + 1 : bounded.length;
  return `${spoken.slice(0, cut).trimEnd()} The rest is on screen.`;
}

function collapseTableBlocks(text: string, detailCue: string): string {
  const lines = text.split("\n");
  const rebuilt: string[] = [];
  let inTable = false;
  for (const line of lines) {
    if (TABLE_ROW.test(line)) {
      if (!inTable) {
        rebuilt.push(` ${detailCue} `);
        inTable = true;
      }
      continue;
    }
    inTable = false;
    rebuilt.push(line);
  }
  return rebuilt.join("\n");
}
