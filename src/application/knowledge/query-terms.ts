// Turning a spoken question into search terms, shared by the index adapter
// (FTS5 MATCH) and the relevance gate in recall.ts.

const MAX_QUERY_TERMS = 12;
/** Words that carry no retrieval signal in spoken questions. */
const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "your", "with", "that", "this", "was", "were", "have", "has",
  "had", "what", "when", "where", "which", "who", "why", "how", "can", "could", "would", "should", "about", "did",
  "does", "from", "into", "they", "them", "their", "there", "then", "than", "just", "like", "please", "tell", "me",
  "my", "our", "any", "some", "all", "out", "get", "got", "let", "its", "it's", "also", "again", "yes", "okay",
  // Spoken contractions carry no content either.
  "what's", "that's", "there's", "where's", "who's", "how's", "i'm", "i've", "i'd", "i'll", "you're", "we're",
  "we've", "don't", "doesn't", "didn't", "can't", "won't", "isn't", "aren't", "wasn't", "let's",
]);

/** Spoken question → distinct content terms safe to quote in an FTS5 query. */
export function queryTerms(query: string): string[] {
  const words = query.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? [];
  const terms: string[] = [];
  for (const word of words) {
    const term = word.replace(/['-]+$/u, "").replaceAll('"', "");
    if (term.length < 3 || STOPWORDS.has(term) || terms.includes(term)) continue;
    terms.push(term);
    if (terms.length >= MAX_QUERY_TERMS) break;
  }
  return terms;
}
