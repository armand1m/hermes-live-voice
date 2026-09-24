// Incremental pieces of a streamed chat-completions answer for the Riva voice
// brain: SSE line decoding, <think> removal across chunk boundaries, sentence
// chunking for early synthesis, and tool-call delta assembly. All pure and
// synchronous so the adapter keeps ownership of I/O, cancellation, and speech.

type JsonObject = Record<string, unknown>;

/** Smallest chunk worth a separate synthesis request (short cues merge forward). */
export const MIN_SPOKEN_CHUNK_CHARS = 20;

const OPEN_THINK = /<(think|thinking|reasoning)>/iu;
const CLOSE_THINK = /<\/(think|thinking|reasoning)>/iu;
/** Longest tag we must hold back while it may still be arriving ("</reasoning>"). */
const MAX_TAG_CHARS = 12;

/** Decodes `data:` payloads from an SSE byte stream, one JSON object per event. */
export class SseJsonDecoder {
  private buffer = "";
  private readonly decoder = new TextDecoder();

  push(bytes: Uint8Array): JsonObject[] {
    this.buffer += this.decoder.decode(bytes, { stream: true });
    const events: JsonObject[] = [];
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const parsed = JSON.parse(payload) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) events.push(parsed as JsonObject);
      } catch {
        // A malformed event is skipped; the final answer is still validated.
      }
    }
    return events;
  }
}

/**
 * Removes reasoning blocks from streamed content even when a tag is split
 * across deltas. Servers with a reasoning parser send reasoning out of band;
 * this covers the ones that inline it.
 */
export class ThinkStripper {
  private pending = "";
  private inside = false;

  push(delta: string): string {
    this.pending += delta;
    let visible = "";
    for (;;) {
      if (this.inside) {
        const close = CLOSE_THINK.exec(this.pending);
        if (!close) {
          // Keep only a possible partial closing tag.
          this.pending = this.pending.slice(-MAX_TAG_CHARS);
          return visible;
        }
        this.pending = this.pending.slice(close.index + close[0].length);
        this.inside = false;
        continue;
      }
      const open = OPEN_THINK.exec(this.pending);
      if (open) {
        visible += this.pending.slice(0, open.index);
        this.pending = this.pending.slice(open.index + open[0].length);
        this.inside = true;
        continue;
      }
      // Hold back a trailing "<…" that could still become an opening tag.
      const lastOpen = this.pending.lastIndexOf("<");
      if (lastOpen >= 0 && this.pending.length - lastOpen < MAX_TAG_CHARS && !this.pending.slice(lastOpen).includes(">")) {
        visible += this.pending.slice(0, lastOpen);
        this.pending = this.pending.slice(lastOpen);
      } else {
        visible += this.pending;
        this.pending = "";
      }
      return visible;
    }
  }

  /** End of stream: an unterminated reasoning block never speaks. */
  flush(): string {
    const rest = this.inside ? "" : this.pending;
    this.pending = "";
    return rest;
  }
}

/**
 * Splits streamed answer text into speakable chunks at sentence ends and line
 * breaks. It never splits inside a code fence, between table rows, or after a
 * numbered-list marker ("1."), so the per-chunk Markdown cleanup sees whole
 * structures. Chunks shorter than MIN_SPOKEN_CHUNK_CHARS merge forward.
 */
export class SentenceChunker {
  private buffer = "";

  push(text: string): string[] {
    this.buffer += text;
    const chunks: string[] = [];
    let searchFrom = 0;
    for (;;) {
      const cut = this.nextBoundary(searchFrom);
      if (cut === undefined) break;
      const chunk = this.buffer.slice(0, cut);
      if (chunk.trim().length < MIN_SPOKEN_CHUNK_CHARS) {
        searchFrom = cut;
        continue;
      }
      chunks.push(chunk.trim());
      this.buffer = this.buffer.slice(cut);
      searchFrom = 0;
    }
    return chunks;
  }

  flush(): string {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest;
  }

  /** Index just past the next safe boundary at or after `from`, if any. */
  private nextBoundary(from: number): number | undefined {
    const text = this.buffer;
    for (let index = Math.max(from, 0); index < text.length; index += 1) {
      const char = text[index]!;
      if (char === "\n") {
        const lineStart = text.lastIndexOf("\n", index - 1) + 1;
        const line = text.slice(lineStart, index).trim();
        const next = text.slice(index + 1);
        // Table rows stay together until the block ends.
        if (line.startsWith("|") && (next === "" || next.trimStart().startsWith("|"))) continue;
        if (next === "" ) return undefined; // the next line may still be a table row
        if (openFence(text.slice(0, index + 1))) continue;
        return index + 1;
      }
      if (char !== "." && char !== "!" && char !== "?" && char !== "…") continue;
      let end = index + 1;
      while (end < text.length && /["')\]]/u.test(text[end]!)) end += 1;
      if (end >= text.length) return undefined; // need the following char
      if (!/\s/u.test(text[end]!)) continue;
      // "1. item" and "3.5" are not sentence ends.
      if (char === "." && /\d/u.test(text[index - 1] ?? "")) continue;
      if (openFence(text.slice(0, end))) continue;
      return end;
    }
    return undefined;
  }
}

function openFence(text: string): boolean {
  return ((text.match(/```|~~~/gu) ?? []).length % 2) === 1;
}

/** Assembles OpenAI-style streamed tool_call deltas (keyed by index). */
export class ToolCallAssembler {
  private readonly calls = new Map<number, { id?: string; name: string; arguments: string }>();

  push(deltas: unknown): void {
    if (!Array.isArray(deltas)) return;
    for (const raw of deltas) {
      if (!raw || typeof raw !== "object") continue;
      const delta = raw as JsonObject;
      const index = typeof delta.index === "number" ? delta.index : this.calls.size;
      const entry = this.calls.get(index) ?? { name: "", arguments: "" };
      if (typeof delta.id === "string" && delta.id) entry.id = delta.id;
      const fn = delta.function as JsonObject | undefined;
      if (typeof fn?.name === "string") entry.name += fn.name;
      if (typeof fn?.arguments === "string") entry.arguments += fn.arguments;
      this.calls.set(index, entry);
    }
  }

  get size(): number {
    return this.calls.size;
  }

  /** Completed calls in the non-streaming `message.tool_calls` shape. */
  result(): JsonObject[] {
    return [...this.calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => ({
      ...(call.id ? { id: call.id } : {}),
      type: "function",
      function: { name: call.name, arguments: call.arguments || "{}" },
    }));
  }
}
