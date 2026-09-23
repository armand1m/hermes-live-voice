/**
 * Text-level echo guard for speaker-to-mic feedback: without browser AEC the
 * microphone hears the agent's own speech, and the ASR happily transcribes it
 * back as a user turn. Every text the provider speaks is remembered in a short
 * ring; a finalized user transcript that matches recent assistant speech is
 * dropped before it ever reaches the brain.
 */
export interface EchoGuardEntry {
  text: string;
  spokenAt: number;
}

const RING_LIMIT = 8;
const RING_TTL_MS = 5 * 60_000;
/** Containment only counts for user text long enough to be a real echo. */
const MIN_CONTAINMENT_CHARS = 8;
const JACCARD_THRESHOLD = 0.8;

function normalizeForEcho(text: string): string {
  return text.toLowerCase().replace(/\p{P}+/gu, "").replace(/\s+/g, " ").trim();
}

function tokenSet(normalized: string): Set<string> {
  return new Set(normalized.split(" ").filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

export class RivaEchoGuard {
  private entries: EchoGuardEntry[] = [];

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Records assistant text that is about to be spoken. */
  note(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.entries.push({ text: trimmed, spokenAt: this.now() });
    this.evict();
  }

  /** True when a finalized user transcript matches recent assistant speech. */
  isEcho(userText: string): boolean {
    const input = normalizeForEcho(userText);
    const inputTokens = tokenSet(input);
    if (inputTokens.size < 2) return false;
    for (const entry of this.evict()) {
      const spoken = normalizeForEcho(entry.text);
      const spokenTokens = tokenSet(spoken);
      if (spokenTokens.size === 0) continue;
      // Exact repeats ("On it" heard back verbatim) drop at any length.
      if (spoken === input) return true;
      // The mic catching the START of a spoken line is the classic partial
      // echo (the user's VAD opens during the first words) — drop any
      // multi-word prefix match regardless of length.
      if (spoken.startsWith(input)) return true;
      if (input.length >= MIN_CONTAINMENT_CHARS && spokenTokens.size >= 2
        && (spoken.includes(input) || input.includes(spoken))) return true;
      if (Math.min(inputTokens.size, spokenTokens.size) >= 3
        && jaccard(inputTokens, spokenTokens) >= JACCARD_THRESHOLD) return true;
    }
    return false;
  }

  private evict(): EchoGuardEntry[] {
    const cutoff = this.now() - RING_TTL_MS;
    this.entries = this.entries.filter((entry) => entry.spokenAt >= cutoff).slice(-RING_LIMIT);
    return this.entries;
  }
}
