/**
 * Summarizes one task fact sheet into markdown through a configured
 * OpenAI-compatible LLM. Implemented by the outbound narrator client
 * (src/adapters/outbound/narrator); the application layer depends only on
 * this shape.
 */
export interface TaskNarratorPort {
  /** Model identifier reported back to clients alongside the markdown. */
  readonly model: string;
  summarize(systemPrompt: string, factSheet: string): Promise<string>;
}
