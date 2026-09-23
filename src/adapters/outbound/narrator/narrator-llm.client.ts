import type { AppConfig } from "../../../config.js";
import { errorToMessage } from "../../../domain/error-message.js";

// HTTP client for the task-log narrator: any OpenAI-compatible
// /chat/completions endpoint (the deployment uses the local sglang server
// already serving the voice stack's LLM, e.g. qwen3.8-27b on 127.0.0.1).
// Narration is a plain short completion — no streaming, no tools — bounded
// in tokens and wall time so a wedged model cannot hang the HTTP route.

/** Thinking models may emit <think> blocks; narration shows only the answer. */
const THINK_BLOCK = /<think>[\s\S]*?<\/think>/g;
/**
 * Narrations are short by construction (the prompt caps them at 150 words),
 * but the completion budget must also absorb reasoning tokens: a thinking
 * model that spends the whole budget reasoning returns empty content with
 * finish_reason "length".
 */
const MAX_COMPLETION_TOKENS = 2_048;
/** Summarizing a record needs no deep reasoning; low effort answers directly. */
const REASONING_EFFORT = "low";
/** The answer is a bounded markdown summary; anything larger is a wedged or hostile body. */
const MAX_RESPONSE_BODY_BYTES = 1_048_576;

export interface NarratorLlmClientOptions {
  baseUrl: string;
  model: string;
  requestTimeoutMs: number;
}

export class NarratorLlmClient {
  private readonly options: NarratorLlmClientOptions;

  constructor(options: NarratorLlmClientOptions) {
    this.options = options;
  }

  get model(): string {
    return this.options.model;
  }

  /**
   * Summarize one task fact sheet into markdown. The user-role message is
   * mandatory: the sglang chat endpoint rejects requests without one. The
   * wall-time budget covers headers *and* body decoding: the abort signal
   * stays armed until the payload is fully read, so a wedged model cannot
   * hang the route on a slow-dripping body after fast headers.
   */
  async summarize(systemPrompt: string, factSheet: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.requestTimeoutMs);
    timer.unref?.();
    try {
      const response = await fetch(`${this.options.baseUrl}/chat/completions`, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          model: this.options.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: factSheet },
          ],
          temperature: 0.2,
          max_tokens: MAX_COMPLETION_TOKENS,
          reasoning_effort: REASONING_EFFORT,
          stream: false,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`task narrator LLM responded ${response.status}`);
      }
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BODY_BYTES) {
        throw new Error("task narrator LLM response body exceeded the safe size limit.");
      }
      let body: string;
      try {
        body = await response.text();
      } catch (error) {
        throw new Error(
          isAbortError(error)
            ? "task narrator LLM body read timed out"
            : `task narrator LLM body read failed: ${errorToMessage(error)}`,
        );
      }
      if (body.length > MAX_RESPONSE_BODY_BYTES) {
        throw new Error("task narrator LLM response body exceeded the safe size limit.");
      }
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch (error) {
        throw new Error(`task narrator LLM returned invalid JSON: ${errorToMessage(error)}`);
      }
      const content = extractContent(payload);
      const markdown = content.replace(THINK_BLOCK, "").trim();
      if (!markdown) {
        const finish = extractFinishReason(payload);
        throw new Error(`task narrator LLM returned no content (finish_reason: ${finish ?? "unknown"})`);
      }
      return markdown;
    } catch (error) {
      if (isAbortError(error)) throw new Error("task narrator LLM request timed out");
      throw error instanceof Error ? error : new Error(`task narrator LLM request failed: ${errorToMessage(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function extractContent(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const message = (choices[0] as { message?: { content?: unknown } }).message;
  const content = message?.content;
  return typeof content === "string" ? content : "";
}

function extractFinishReason(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const finish = (choices[0] as { finish_reason?: unknown }).finish_reason;
  return typeof finish === "string" ? finish : undefined;
}

export function narratorClientFromConfig(config: AppConfig): NarratorLlmClient | undefined {
  if (!config.narrator.baseUrl) return undefined;
  return new NarratorLlmClient({
    baseUrl: config.narrator.baseUrl,
    model: config.narrator.model,
    requestTimeoutMs: config.narrator.requestTimeoutMs,
  });
}
