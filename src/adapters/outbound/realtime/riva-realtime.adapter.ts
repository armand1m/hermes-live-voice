import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { AppConfig } from "../../../config.js";
import { selectCompactOpenAIHermesLiveTools } from "../../../application/live-gateway/tool-definitions.js";
import type {
  LiveModelAdapter, LiveModelConnectParams, LiveModelSession,
  LiveTaskNotification, LiveToolCall,
} from "../../../application/live-gateway/ports/realtime-model.port.js";
import { RivaEchoGuard } from "./riva-echo-guard.js";
import { normalizePcm16Audio } from "../../../domain/audio/pcm.js";
import type { RealtimeResponseTruncation } from "../../../domain/protocol/client-protocol.js";

const ASR_RATE = 16_000;
const TTS_RATE = 22_050;
const MAX_EVENT_BYTES = 16 * 1024 * 1024;
const MAX_TTS_BYTES = 16 * 1024 * 1024;
/** Thinking models may emit <think> blocks; only the answer is spoken. */
const THINK_BLOCK = /<think>[\s\S]*?<\/think>/g;
/** Cap for the doubled-budget empty-answer retry (matches the config ceiling). */
const BRAIN_RETRY_TOKEN_CEILING = 8_192;
const BRAIN_TIMEOUT_MS = 90_000;
const TTS_TIMEOUT_MS = 90_000;
const ASR_FINAL_TIMEOUT_MS = 15_000;
const MAX_HISTORY = 12;

type JsonObject = Record<string, unknown>;
type BrainMessage = { role: "system" | "user" | "assistant" | "tool"; content: string; tool_call_id?: string; tool_calls?: unknown[] };

/** Bridges NVIDIA Speech NIM's separate ASR/TTS sockets to Hermes' live session. */
export class RivaRealtimeAdapter implements LiveModelAdapter {
  constructor(
    private readonly config: AppConfig["riva"],
    private readonly connectTimeoutMs = 30_000,
  ) {}

  async connect(params: LiveModelConnectParams): Promise<LiveModelSession> {
    const asr = await connectRivaSocket(this.config.asrUrl, "transcription_sessions", this.config.mintApiKey, this.connectTimeoutMs);
    const session = new RivaRealtimeSession(this.config, params, asr.ws, this.connectTimeoutMs);
    session.configureAsr(asr.ws, asr.session);
    params.callbacks.onOpen?.();
    return session;
  }
}

class RivaRealtimeSession implements LiveModelSession {
  private readonly history: BrainMessage[] = [];
  private readonly pendingCalls = new Map<string, LiveToolCall>();
  private queue: Promise<void> = Promise.resolve();
  private activeAbort?: AbortController;
  private tts?: WebSocket;
  private activeResponseId?: string;
  private audioBuffered = false;
  private awaitingTranscript = false;
  private transcriptParts: string[] = [];
  private transcriptTimer?: ReturnType<typeof setTimeout>;
  private transcriptDone?: Promise<void>;
  private resolveTranscript?: () => void;
  private asrReconnect?: Promise<void>;
  private asrKeepalive?: ReturnType<typeof setInterval>;
  private asr?: WebSocket;
  private readonly echoGuard: RivaEchoGuard | undefined;
  private closed = false;
  private generation = 0;

  constructor(
    private readonly config: AppConfig["riva"],
    private readonly params: LiveModelConnectParams,
    asr: WebSocket,
    private readonly connectTimeoutMs: number,
  ) {
    this.asr = asr;
    this.attachAsr(asr);
    this.echoGuard = config.echoGuard ? new RivaEchoGuard() : undefined;
  }

  configureAsr(ws: WebSocket, mint: JsonObject): void {
    const transcription = mint.input_audio_transcription as JsonObject | undefined;
    const model = typeof transcription?.model === "string"
      ? transcription.model : "parakeet-1.1b-en-US-asr-streaming";
    sendJson(ws, {
      type: "transcription_session.update",
      session: {
        modalities: ["text"], input_audio_format: "pcm16",
        input_audio_transcription: { language: "en-US", model },
        input_audio_params: { sample_rate_hz: ASR_RATE, num_channels: 1 },
        recognition_config: { enable_automatic_punctuation: true },
      },
    });
  }

  async sendRealtimeAudio(audio: { data: string; mimeType: string }): Promise<void> {
    if (this.closed) throw new Error("Riva session is closed.");
    if (this.transcriptDone) await this.transcriptDone;
    await this.ensureAsr();
    const normalized = normalizePcm16Audio(audio, ASR_RATE);
    sendJson(this.asr!, { type: "input_audio_buffer.append", audio: normalized.data });
    this.audioBuffered = true;
  }

  async sendAudioStreamEnd(): Promise<boolean> {
    if (!this.audioBuffered || this.closed || !this.asr) return false;
    this.audioBuffered = false;
    this.awaitingTranscript = true;
    this.transcriptParts = [];
    this.transcriptDone = new Promise<void>((resolve) => { this.resolveTranscript = resolve; });
    sendJson(this.asr, { type: "input_audio_buffer.commit" });
    sendJson(this.asr, { type: "input_audio_buffer.done" });
    this.clearTranscriptTimer();
    this.transcriptTimer = setTimeout(() => {
      if (!this.awaitingTranscript || this.closed) return;
      this.awaitingTranscript = false;
      this.params.callbacks.onError?.(new Error("Riva ASR did not return a final transcript."));
      const responseId = randomUUID();
      this.params.callbacks.onEvent({ type: "response", status: "started", responseId });
      this.params.callbacks.onEvent({ type: "response", status: "failed", responseId });
      this.releaseTranscript();
      this.rotateAsr();
    }, ASR_FINAL_TIMEOUT_MS);
    this.transcriptTimer.unref?.();
    return true;
  }

  async sendText(text: string): Promise<void> {
    const input = text.trim();
    if (!input || this.closed) return;
    this.enqueue(() => this.respond(input));
  }

  async cancelResponse(_reason?: string, _truncate?: RealtimeResponseTruncation): Promise<boolean> {
    if (!this.activeResponseId) return false;
    this.generation += 1;
    this.activeAbort?.abort();
    this.tts?.close();
    this.params.callbacks.onEvent({ type: "response", status: "cancelled", responseId: this.activeResponseId });
    this.activeResponseId = undefined;
    return true;
  }

  async sendToolResponse(call: LiveToolCall, response: JsonObject, options?: { suppressSpeech?: boolean }): Promise<void> {
    if (!call.id || !this.pendingCalls.delete(call.id) || this.closed) return;
    const spoken = typeof response.spoken_response === "string" ? response.spoken_response.trim() : "";
    this.history.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(response) });
    if (spoken) {
      if (!options?.suppressSpeech) this.enqueue(() => this.speakResponse(spoken));
      return;
    }
    if (this.pendingCalls.size === 0) this.enqueue(() => this.completeToolResponse());
  }

  async sendTaskNotification(notification: LiveTaskNotification): Promise<void> {
    if (this.closed) return;
    this.enqueue(() => this.speakResponse(notification.speech ?? notification.announcement, "task_notification"));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.generation += 1;
    this.clearTranscriptTimer();
    this.clearAsrKeepalive();
    this.releaseTranscript();
    this.activeAbort?.abort();
    this.tts?.close();
    this.asr?.close();
  }

  private onAsrMessage(raw: WebSocket.RawData): void {
    const event = parseEvent(raw);
    if (!event) return;
    if (event.type === "error" || event.type === "conversation.item.input_audio_transcription.failed") {
      this.awaitingTranscript = false;
      this.clearTranscriptTimer();
      this.params.callbacks.onError?.(new Error(providerError(event)));
      const responseId = randomUUID();
      this.params.callbacks.onEvent({ type: "response", status: "started", responseId });
      this.params.callbacks.onEvent({ type: "response", status: "failed", responseId });
      this.releaseTranscript();
      this.rotateAsr();
      return;
    }
    if (event.type !== "conversation.item.input_audio_transcription.completed" || !this.awaitingTranscript) return;
    const transcript = typeof event.transcript === "string" ? event.transcript.trim() : "";
    if (transcript) this.transcriptParts = mergeTranscriptParts(this.transcriptParts, transcript);
    if (event.is_last_result !== true) return;
    this.awaitingTranscript = false;
    this.clearTranscriptTimer();
    const input = this.transcriptParts.join(" ").trim();
    this.transcriptParts = [];
    this.releaseTranscript();
    this.rotateAsr();
    if (!input || this.closed) {
      if (!this.closed) {
        const responseId = randomUUID();
        this.params.callbacks.onEvent({ type: "response", status: "started", responseId });
        this.params.callbacks.onEvent({ type: "response", status: "completed", responseId });
      }
      return;
    }
    if (this.echoGuard?.isEcho(input)) {
      // Speaker-to-mic feedback: the transcript is the agent's own recent
      // speech, never a user turn. Drop it before it reaches the brain.
      this.params.callbacks.onDroppedTurn?.({ kind: "echo", text: input });
      return;
    }
    this.params.callbacks.onEvent({ type: "text", speaker: "user", text: input, final: true });
    this.enqueue(() => this.respond(input));
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((error: unknown) => {
      if (!this.closed) this.params.callbacks.onError?.(error);
    });
  }

  private clearTranscriptTimer(): void {
    if (this.transcriptTimer) clearTimeout(this.transcriptTimer);
    this.transcriptTimer = undefined;
  }

  private releaseTranscript(): void {
    this.resolveTranscript?.();
    this.resolveTranscript = undefined;
    this.transcriptDone = undefined;
  }

  private attachAsr(ws: WebSocket): void {
    ws.on("message", (raw) => {
      if (this.asr === ws) this.onAsrMessage(raw);
    });
    ws.on("error", (error) => {
      if (this.asr === ws && !this.closed) this.params.callbacks.onError?.(error);
    });
    ws.on("close", (code, reason) => {
      if (this.asr !== ws || this.closed) return;
      this.clearAsrKeepalive();
      this.asr = undefined;
      if (!this.awaitingTranscript) {
        // NIMs idle-close quiet transcription sockets (~90 s observed). Between
        // turns that is fully recoverable: reconnect silently instead of
        // tearing down the live client session.
        void this.ensureAsr().catch((error: unknown) => {
          if (!this.closed) this.params.callbacks.onError?.(error);
        });
        return;
      }
      this.clearTranscriptTimer();
      this.params.callbacks.onClose?.({ code, reason: reason.toString("utf8") });
    });
    this.armAsrKeepalive(ws);
  }

  private armAsrKeepalive(ws: WebSocket): void {
    this.clearAsrKeepalive();
    if (!this.config.wsKeepaliveMs) return;
    this.asrKeepalive = setInterval(() => {
      if (this.asr === ws && ws.readyState === WebSocket.OPEN) ws.ping();
    }, this.config.wsKeepaliveMs);
    this.asrKeepalive.unref?.();
  }

  private clearAsrKeepalive(): void {
    if (this.asrKeepalive) clearInterval(this.asrKeepalive);
    this.asrKeepalive = undefined;
  }

  private rotateAsr(): void {
    const old = this.asr;
    this.asr = undefined;
    this.clearAsrKeepalive();
    old?.close();
    void this.ensureAsr().catch((error: unknown) => {
      if (!this.closed) this.params.callbacks.onError?.(error);
    });
  }

  private async ensureAsr(): Promise<void> {
    if (this.closed) throw new Error("Riva session is closed.");
    if (this.asr?.readyState === WebSocket.OPEN) return;
    if (!this.asrReconnect) {
      this.asrReconnect = (async () => {
        const opened = await connectRivaSocket(this.config.asrUrl, "transcription_sessions", this.config.mintApiKey, this.connectTimeoutMs);
        if (this.closed) { opened.ws.close(); return; }
        this.asr = opened.ws;
        this.attachAsr(opened.ws);
        this.configureAsr(opened.ws, opened.session);
      })().finally(() => { this.asrReconnect = undefined; });
    }
    await this.asrReconnect;
  }

  private async respond(input: string): Promise<void> {
    this.history.push({ role: "user", content: input });
    await this.askBrain();
  }

  private async completeToolResponse(): Promise<void> {
    await this.askBrain();
  }

  private async askBrain(): Promise<void> {
    if (this.closed) return;
    const responseId = randomUUID();
    const generation = this.generation;
    const abort = new AbortController();
    this.activeAbort = abort;
    this.activeResponseId = responseId;
    this.params.callbacks.onEvent({ type: "response", status: "started", responseId });
    try {
      const messages: BrainMessage[] = [
        { role: "system", content: this.params.systemInstruction },
        ...this.history.slice(-MAX_HISTORY),
      ];
      const tools = selectCompactOpenAIHermesLiveTools(this.params.availableTools).map((tool) => ({
        type: "function" as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
      const request: JsonObject = {
        model: this.config.brainModel, messages,
        max_tokens: this.config.brainMaxTokens, stream: false,
      };
      if (this.config.brainReasoningEffort !== "off") request.reasoning_effort = this.config.brainReasoningEffort;
      if (tools.length) request.tools = tools;
      let outcome = await this.fetchBrain(request, abort.signal);
      // A thinking brain can spend its whole budget reasoning and return empty
      // content (finish_reason "length"): retry once with the effort cap off
      // and a doubled budget before falling back to a spoken recovery line.
      if (!outcome.content && outcome.toolCalls.length === 0) {
        const retry: JsonObject = { ...request, max_tokens: Math.min(this.config.brainMaxTokens * 2, BRAIN_RETRY_TOKEN_CEILING) };
        delete retry.reasoning_effort;
        outcome = await this.fetchBrain(retry, abort.signal);
      }
      if (!outcome.content && outcome.toolCalls.length === 0) {
        outcome = { content: "I lost my thread — say that again?", toolCalls: [] };
      }
      if (this.closed || this.generation !== generation) return;
      const { content, toolCalls } = outcome;
      this.history.push({ role: "assistant", content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      if (toolCalls.length) {
        for (const tool of toolCalls) {
          const fn = tool.function as JsonObject | undefined;
          if (typeof tool.id !== "string" || typeof fn?.name !== "string") continue;
          let args: JsonObject;
          try { args = JSON.parse(String(fn.arguments ?? "{}")) as JsonObject; } catch { args = {}; }
          const call: LiveToolCall = { id: tool.id, name: fn.name, args };
          this.pendingCalls.set(call.id!, call);
          this.params.callbacks.onEvent({ type: "tool_call", call });
        }
      } else if (content) {
        this.echoGuard?.note(content);
        this.params.callbacks.onEvent({ type: "text", speaker: "assistant", text: content, final: true });
        await this.synthesize(content, generation);
      }
      if (this.generation === generation) this.finish(responseId, "completed");
    } catch (error) {
      if (this.generation === generation && !this.closed) {
        this.params.callbacks.onError?.(error);
        this.finish(responseId, "failed");
      }
    } finally {
      if (this.activeAbort === abort) this.activeAbort = undefined;
    }
  }

  private async fetchBrain(request: JsonObject, signal: AbortSignal): Promise<{ content: string; toolCalls: JsonObject[] }> {
    const result = await fetch(this.config.brainUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.config.brainApiKey ? { Authorization: `Bearer ${this.config.brainApiKey}` } : {}),
      },
      body: JSON.stringify(request),
      signal: AbortSignal.any([signal, AbortSignal.timeout(BRAIN_TIMEOUT_MS)]),
    });
    if (!result.ok) throw new Error(`Riva brain returned HTTP ${result.status}.`);
    const payload = await result.json() as JsonObject;
    const choice = (payload.choices as JsonObject[] | undefined)?.[0];
    const message = choice?.message as JsonObject | undefined;
    if (!message) return { content: "", toolCalls: [] };
    const content = stripThinkingBlocks(typeof message.content === "string" ? message.content : "").trim();
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls as JsonObject[] : [];
    return { content, toolCalls };
  }

  private async speakResponse(text: string, scope: "conversation" | "task_notification" = "conversation"): Promise<void> {
    if (this.closed) return;
    const responseId = randomUUID();
    const generation = this.generation;
    this.activeResponseId = responseId;
    this.echoGuard?.note(text);
    this.params.callbacks.onEvent({ type: "response", status: "started", responseId, scope });
    try {
      this.params.callbacks.onEvent({ type: "text", speaker: "assistant", text, final: true });
      await this.synthesize(text, generation);
      if (this.generation === generation) this.finish(responseId, "completed", scope);
    } catch (error) {
      if (this.generation === generation && !this.closed) {
        this.params.callbacks.onError?.(error);
        this.finish(responseId, "failed", scope);
      }
    }
  }

  private async synthesize(text: string, generation: number): Promise<void> {
    const { ws } = await connectRivaSocket(this.config.ttsUrl, "synthesis_sessions", this.config.mintApiKey, this.connectTimeoutMs);
    this.tts = ws;
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      sendJson(ws, {
        type: "synthesize_session.update",
        session: {
          input_text_synthesis: { language_code: "en-US", voice_name: this.config.voice },
          output_audio_params: { sample_rate_hz: TTS_RATE, num_channels: 1, audio_format: "LINEAR_PCM" },
        },
      });
      sendJson(ws, { type: "input_text.append", text });
      sendJson(ws, { type: "input_text.commit" });
      sendJson(ws, { type: "input_text.done" });
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Riva TTS timed out.")), TTS_TIMEOUT_MS);
        const cleanup = () => { clearTimeout(timeout); ws.off("message", onMessage); ws.off("error", onError); ws.off("close", onClose); };
        const done = (error?: Error) => { cleanup(); if (error) reject(error); else resolve(); };
        const onError = (error: Error) => done(error);
        const onClose = () => done(new Error("Riva TTS closed before synthesis completed."));
        const onMessage = (raw: WebSocket.RawData) => {
          const event = parseEvent(raw);
          if (!event) return;
          if (event.type === "error" || event.type === "conversation.item.speech.failed") { done(new Error(providerError(event))); return; }
          if (event.type === "conversation.item.speech.data" && typeof event.audio === "string") {
            const chunk = Buffer.from(event.audio, "base64");
            bytes += chunk.length;
            if (bytes > MAX_TTS_BYTES) { done(new Error("Riva TTS response exceeded audio limit.")); return; }
            chunks.push(chunk);
          }
          if (event.type === "conversation.item.speech.completed" && event.is_last_result === true) done();
        };
        ws.on("message", onMessage); ws.once("error", onError); ws.once("close", onClose);
      });
      if (this.closed || this.generation !== generation || bytes === 0) return;
      const pcm = Buffer.concat(chunks);
      if (pcm.length % 2) throw new Error("Riva TTS returned odd-length PCM16 audio.");
      // Emit only after complete synthesis, so CPU/GPU inference pauses cannot
      // drain the browser playback queue in the middle of a spoken word.
      for (let offset = 0; offset < pcm.length; offset += TTS_RATE * 2 / 5) {
        if (this.closed || this.generation !== generation) return;
        const part = pcm.subarray(offset, Math.min(pcm.length, offset + TTS_RATE * 2 / 5));
        this.params.callbacks.onEvent({ type: "audio", audio: { data: part.toString("base64"), mimeType: `audio/pcm;rate=${TTS_RATE}` } });
      }
    } finally {
      if (this.tts === ws) this.tts = undefined;
      ws.close();
    }
  }

  private finish(responseId: string, status: "completed" | "failed", scope: "conversation" | "task_notification" = "conversation"): void {
    if (this.activeResponseId !== responseId) return;
    this.activeResponseId = undefined;
    this.params.callbacks.onEvent({ type: "response", status, responseId, scope });
  }
}

async function connectRivaSocket(url: string, sessionEndpoint: string, mintApiKey: string | undefined, timeoutMs: number): Promise<{ ws: WebSocket; session: JsonObject }> {
  const endpoint = new URL(url);
  const sessionUrl = new URL(`/v1/realtime/${sessionEndpoint}`, endpoint);
  sessionUrl.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
  const minted = await fetch(sessionUrl, {
    method: "POST", headers: mintApiKey ? { Authorization: `Bearer ${mintApiKey}` } : {},
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!minted.ok) throw new Error(`Riva session mint returned HTTP ${minted.status}.`);
  const session = await minted.json() as JsonObject;
  const token = (session.client_secret as JsonObject | undefined)?.value;
  const protocols = typeof token === "string" ? ["realtime", `realtime-token.${token}`] : undefined;
  const ws = new WebSocket(url, protocols, { handshakeTimeout: timeoutMs, maxPayload: MAX_EVENT_BYTES, perMessageDeflate: false, followRedirects: false });
  return await new Promise<{ ws: WebSocket; session: JsonObject }>((resolve, reject) => {
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("Riva WebSocket timed out.")); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); ws.off("open", onOpen); ws.off("error", onError); ws.off("close", onClose); };
    const onOpen = () => { cleanup(); resolve({ ws, session }); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onClose = (code: number) => { cleanup(); reject(new Error(`Riva WebSocket closed during connect (${code}).`)); };
    ws.once("open", onOpen); ws.once("error", onError); ws.once("close", onClose);
  });
}

function sendJson(ws: WebSocket, event: JsonObject): void {
  if (ws.readyState !== WebSocket.OPEN) throw new Error("Riva WebSocket is not open.");
  if (ws.bufferedAmount > MAX_EVENT_BYTES) throw new Error("Riva WebSocket output is backpressured.");
  ws.send(JSON.stringify(event));
}

function parseEvent(raw: WebSocket.RawData): JsonObject | undefined {
  try {
    const value: unknown = JSON.parse(raw.toString());
    return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
  } catch { return undefined; }
}

function providerError(event: JsonObject): string {
  const error = event.error as JsonObject | undefined;
  return typeof error?.message === "string" ? error.message : "Riva speech service reported an error.";
}

function stripThinkingBlocks(content: string): string {
  return content.replace(THINK_BLOCK, "");
}

const TRANSCRIPT_MAX_PARTS = 32;
const TRANSCRIPT_JACCARD_THRESHOLD = 0.75;

function normalizeTranscriptText(text: string): string {
  // Punctuation is removed without a space so apostrophe drift matches
  // ("that's" ≡ "thats"); ASR output spaces its punctuation, so words that
  // sit directly against punctuation are rare.
  return text.toLowerCase().replace(/\p{P}+/gu, "").replace(/\s+/g, " ").trim();
}

function transcriptTokens(normalized: string): Set<string> {
  return new Set(normalized.split(" ").filter(Boolean));
}

function transcriptJaccard(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

/** Drop parts fully contained in a longer captured part (cross-part dedup). */
function collapseTranscriptParts(parts: string[]): string[] {
  const normalized = parts.map(normalizeTranscriptText);
  return parts.filter((_, index) => {
    const own = normalized[index]!;
    return Boolean(own) && !normalized.some((other, otherIndex) =>
      otherIndex !== index && other.length > own.length && other.includes(own));
  });
}

/**
 * Parakeet re-emits near-identical segment transcripts (punctuation/casing
 * drift) that prefix-merging against only the last part cannot collapse — the
 * same phrase then reaches the brain twice inside one committed turn. Collapse
 * re-emissions against every captured part; keep genuinely new segments.
 */
export function mergeTranscriptParts(parts: string[], incoming: string): string[] {
  const incomingNormalized = normalizeTranscriptText(incoming);
  if (!incomingNormalized) return collapseTranscriptParts(parts);
  const incomingTokens = transcriptTokens(incomingNormalized);
  const multiWord = incomingTokens.size >= 2;
  const joinedNormalized = normalizeTranscriptText(parts.join(" "));
  const joinedContainsIncoming = multiWord && joinedNormalized.includes(incomingNormalized);
  let matched = false;
  for (let index = 0; index < parts.length; index += 1) {
    const raw = parts[index]!;
    const partNormalized = normalizeTranscriptText(raw);
    if (!partNormalized) continue;
    // Prefix refinement needs a meaningful stem: a 1-2 character part ("I",
    // "a") would otherwise swallow any phrase that happens to start with it.
    const prefixRelated = Math.min(partNormalized.length, incomingNormalized.length) >= 4
      && (incomingNormalized.startsWith(partNormalized) || partNormalized.startsWith(incomingNormalized));
    const nearDuplicate = multiWord
      && transcriptJaccard(incomingTokens, transcriptTokens(partNormalized)) >= TRANSCRIPT_JACCARD_THRESHOLD;
    if (incomingNormalized === partNormalized || prefixRelated || joinedContainsIncoming || nearDuplicate) {
      if (incoming.length > raw.length) parts[index] = incoming;
      matched = true;
      break;
    }
  }
  if (!matched) parts.push(incoming);
  return collapseTranscriptParts(parts).slice(-TRANSCRIPT_MAX_PARTS);
}
