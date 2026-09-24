import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveModelEvent } from "../src/application/live-gateway/ports/realtime-model.port.js";
import type { BrainMessage } from "../src/adapters/outbound/realtime/riva-realtime.adapter.js";
import { boundedHistory, mergeTranscriptParts, RivaRealtimeAdapter, wordBoosting } from "../src/adapters/outbound/realtime/riva-realtime.adapter.js";

const mock = vi.hoisted(() => ({ sockets: [] as Array<{ intent: string; sent: Record<string, unknown>[]; emitEvent: (event: object) => void; close: () => void; pings: { count: number } }> }));

vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeSocket extends EventEmitter {
    static readonly OPEN = 1;
    readonly intent: string;
    readonly sent: Record<string, unknown>[] = [];
    readyState = FakeSocket.OPEN;
    bufferedAmount = 0;

    constructor(url: string) {
      super();
      this.intent = new URL(url).searchParams.get("intent") ?? "";
      mock.sockets.push(this);
      queueMicrotask(() => this.emit("open"));
    }

    readonly pings = { count: 0 };
    ping(): void { this.pings.count += 1; }

    send(value: string): void {
      const event = JSON.parse(value) as Record<string, unknown>;
      this.sent.push(event);
      if (this.intent === "synthesize" && event.type === "input_text.done") {
        queueMicrotask(() => {
          this.emitEvent({ type: "conversation.item.speech.data", audio: Buffer.from([1, 0, 2, 0]).toString("base64") });
          this.emitEvent({ type: "conversation.item.speech.data", audio: Buffer.from([3, 0, 4, 0]).toString("base64") });
          this.emitEvent({ type: "conversation.item.speech.completed", is_last_result: true });
        });
      }
    }

    emitEvent(event: object): void { this.emit("message", Buffer.from(JSON.stringify(event))); }
    close(): void { this.readyState = 3; this.emit("close", 1000, Buffer.alloc(0)); }
    terminate(): void { this.close(); }
  }
  return { default: FakeSocket };
});

afterEach(() => { vi.restoreAllMocks(); mock.sockets.length = 0; });

describe("Riva realtime bridge", () => {
  it("commits 16 kHz ASR, calls the brain, and emits contiguous TTS audio", async () => {
    const brainRequests: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).endsWith("_sessions")) {
        return new Response(JSON.stringify({ client_secret: null }), { status: 200 });
      }
      brainRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ choices: [{ message: { content: "Hello there." } }] }), { status: 200 });
    });
    const events: LiveModelEvent[] = [];
    const session = await new RivaRealtimeAdapter({
      asrUrl: "ws://127.0.0.1:19000/v1/realtime?intent=transcription",
      ttsUrl: "ws://127.0.0.1:19001/v1/realtime?intent=synthesize",
      brainUrl: "http://127.0.0.1:30000/v1/chat/completions",
      brainModel: "qwen3.8-27b",
      voice: "Magpie-Multilingual.EN-US.Jason",
      wsKeepaliveMs: 0, brainMaxTokens: 2048, brainReasoningEffort: "off", echoGuard: false,
    }).connect({ sessionId: "test", systemInstruction: "Help the user.", availableTools: ["start_background_task"], callbacks: { onEvent: (event) => events.push(event) } });
    const asr = mock.sockets[0]!;
    await session.sendRealtimeAudio({ data: Buffer.alloc(960).toString("base64"), mimeType: "audio/pcm;rate=24000" });
    expect(await session.sendAudioStreamEnd()).toBe(true);
    expect(asr.sent.map((event) => event.type)).toContain("input_audio_buffer.commit");
    expect(asr.sent.map((event) => event.type)).toContain("input_audio_buffer.done");
    const audio = asr.sent.find((event) => event.type === "input_audio_buffer.append");
    expect(Buffer.from(String(audio?.audio), "base64")).toHaveLength(640);
    asr.emitEvent({ type: "conversation.item.input_audio_transcription.completed", transcript: "Hi", is_last_result: false });
    asr.emitEvent({ type: "conversation.item.input_audio_transcription.completed", transcript: "Hi", is_last_result: true });
    await vi.waitFor(() => expect(events.some((event) => event.type === "response" && event.status === "completed")).toBe(true));
    expect(mock.sockets.filter((socket) => socket.intent === "transcription")).toHaveLength(2);
    expect(brainRequests).toHaveLength(1);
    expect((brainRequests[0]?.messages as Array<{ role: string; content: string }>).at(-1)).toEqual({ role: "user", content: "Hi" });
    expect((brainRequests[0]?.tools as Array<{ type: string; function: { name: string } }>)[0]).toMatchObject({
      type: "function", function: { name: "start_background_task" },
    });
    expect(events.filter((event) => event.type === "text" && event.speaker === "user")).toHaveLength(1);
    const tts = mock.sockets.find((socket) => socket.intent === "synthesize")!;
    expect(tts.sent.map((event) => event.type)).toEqual([
      "synthesize_session.update", "input_text.append", "input_text.commit", "input_text.done",
    ]);
    const audioEvents = events.filter((event): event is Extract<LiveModelEvent, { type: "audio" }> => event.type === "audio");
    expect(audioEvents).toHaveLength(1);
    expect(audioEvents[0]?.audio.mimeType).toBe("audio/pcm;rate=22050");
    expect(Buffer.from(audioEvents[0]!.audio.data, "base64")).toEqual(Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]));
    await session.close();
  });

  it("prepares spoken content at the TTS boundary: transcript, echo guard, and synthesis see the same plain text", async () => {
    const markdown = "## Status\n\nThe **fix** landed. See [the log](https://example.com/log). ```git\npush origin main\n```";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).endsWith("_sessions")) {
        return new Response(JSON.stringify({ client_secret: null }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: markdown } }] }), { status: 200 });
    });
    const events: LiveModelEvent[] = [];
    const session = await new RivaRealtimeAdapter({
      asrUrl: "ws://127.0.0.1:19000/v1/realtime?intent=transcription",
      ttsUrl: "ws://127.0.0.1:19001/v1/realtime?intent=synthesize",
      brainUrl: "http://127.0.0.1:30000/v1/chat/completions",
      brainModel: "qwen3.8-27b",
      voice: "Magpie-Multilingual.EN-US.Jason",
      wsKeepaliveMs: 0, brainMaxTokens: 2048, brainReasoningEffort: "off", echoGuard: true,
    }).connect({ sessionId: "test", systemInstruction: "Help the user.", availableTools: [], callbacks: { onEvent: (event) => events.push(event) } });
    await session.sendText("status please");
    await vi.waitFor(() => expect(events.some((event) => event.type === "text" && event.speaker === "assistant")).toBe(true));

    const spoken = events.find((event): event is Extract<LiveModelEvent, { type: "text" }> =>
      event.type === "text" && event.speaker === "assistant")!.text;
    expect(spoken).toBe("Status. The fix landed. See the log. The details are available on screen.");
    expect(spoken).not.toContain("**");
    expect(spoken).not.toContain("http");
    expect(spoken).not.toContain("```");
    const tts = mock.sockets.find((socket) => socket.intent === "synthesize")!;
    const appended = tts.sent.find((event) => event.type === "input_text.append");
    // The synthesized text is exactly the prepared spoken transcript.
    expect(appended?.text).toBe(spoken);
    // The echo guard learned the prepared text, not the markdown source.
    const guardDrop = events.some((event) => event.type === "text" && event.speaker === "user");
    expect(guardDrop).toBe(false);
    await session.close();
  });

  it("settles malformed tool calls explicitly so the exchange is never orphaned", async () => {
    const brainRequests: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).endsWith("_sessions")) {
        return new Response(JSON.stringify({ client_secret: null }), { status: 200 });
      }
      brainRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({
        choices: [{ message: { content: null, tool_calls: [
          // One valid call, one call with no function name (malformed).
          { id: "call_ok", function: { name: "start_background_task", arguments: "{}" } },
          { id: "call_broken", function: { arguments: "{}" } },
        ] } }],
      }), { status: 200 });
    });
    const events: LiveModelEvent[] = [];
    const session = await new RivaRealtimeAdapter({
      asrUrl: "ws://127.0.0.1:19000/v1/realtime?intent=transcription",
      ttsUrl: "ws://127.0.0.1:19001/v1/realtime?intent=synthesize",
      brainUrl: "http://127.0.0.1:30000/v1/chat/completions",
      brainModel: "qwen3.8-27b",
      voice: "Magpie-Multilingual.EN-US.Jason",
      wsKeepaliveMs: 0, brainMaxTokens: 2048, brainReasoningEffort: "off", echoGuard: false,
    }).connect({ sessionId: "test", systemInstruction: "Help the user.", availableTools: [], callbacks: { onEvent: (event) => events.push(event) } });

    await session.sendText("delegate something");
    await vi.waitFor(() => expect(events.some((event) => event.type === "tool_call")).toBe(true));
    // Only the well-formed call reaches the gateway.
    expect(events.filter((event) => event.type === "tool_call")).toHaveLength(1);
    await session.sendToolResponse({ id: "call_ok", name: "start_background_task", args: {} }, {
      ok: true,
      spoken_response: "Queued.",
    });

    // The next brain request contains a settled tool result for every emitted
    // call id — including the malformed one — and no orphaned tool message.
    await session.sendText("anything else");
    await vi.waitFor(() => expect(brainRequests.length).toBeGreaterThanOrEqual(2));
    const secondMessages = brainRequests.at(-1)?.messages as Array<{ role: string; tool_call_id?: string }>;
    expect(secondMessages.at(-1)).toEqual({ role: "user", content: "anything else" });
    const settled = secondMessages.filter((message) => message.role === "tool").map((message) => message.tool_call_id);
    expect(settled).toContain("call_ok");
    expect(settled).toContain("call_broken");
    expect(secondMessages[0]?.role).not.toBe("tool");
    await session.close();
  });

  it("never speaks a queued receipt or notification after barge-in", async () => {
    let gateRelease: () => void = () => {};
    const gate = new Promise<void>((resolve) => { gateRelease = resolve; });
    let brainCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).endsWith("_sessions")) {
        return new Response(JSON.stringify({ client_secret: null }), { status: 200 });
      }
      brainCalls += 1;
      if (brainCalls === 1) await gate;
      return new Response(JSON.stringify({ choices: [{ message: { content: "Answer." } }] }), { status: 200 });
    });
    const events: LiveModelEvent[] = [];
    const session = await new RivaRealtimeAdapter({
      asrUrl: "ws://127.0.0.1:19000/v1/realtime?intent=transcription",
      ttsUrl: "ws://127.0.0.1:19001/v1/realtime?intent=synthesize",
      brainUrl: "http://127.0.0.1:30000/v1/chat/completions",
      brainModel: "qwen3.8-27b",
      voice: "Magpie-Multilingual.EN-US.Jason",
      wsKeepaliveMs: 0, brainMaxTokens: 2048, brainReasoningEffort: "off", echoGuard: false,
    }).connect({ sessionId: "test", systemInstruction: "Help the user.", availableTools: [], callbacks: { onEvent: (event) => events.push(event) } });

    // The queue blocks inside the brain turn; the notification speech queues
    // behind it and has not started when the user barges in.
    await session.sendText("hold the turn");
    await vi.waitFor(() => expect(brainCalls).toBe(1));
    await session.sendTaskNotification?.({ context: "[TEST] stale", announcement: "Stale notification speech." });
    expect(await session.cancelResponse?.("user barge-in")).toBe(true);
    gateRelease();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const synthesized = mock.sockets
      .filter((socket) => socket.intent === "synthesize")
      .flatMap((socket) => socket.sent.filter((event) => event.type === "input_text.append"));
    expect(synthesized).toHaveLength(0);
    expect(events.some((event) => event.type === "text" && event.speaker === "assistant")).toBe(false);
    await session.close();
  });

  it("collapses near-duplicate ASR re-emissions into one user turn", async () => {
    const brainRequests: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).endsWith("_sessions")) {
        return new Response(JSON.stringify({ client_secret: null }), { status: 200 });
      }
      brainRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ choices: [{ message: { content: "Sure." } }] }), { status: 200 });
    });
    const events: LiveModelEvent[] = [];
    const session = await new RivaRealtimeAdapter({
      asrUrl: "ws://127.0.0.1:19000/v1/realtime?intent=transcription",
      ttsUrl: "ws://127.0.0.1:19001/v1/realtime?intent=synthesize",
      brainUrl: "http://127.0.0.1:30000/v1/chat/completions",
      brainModel: "qwen3.8-27b",
      voice: "Magpie-Multilingual.EN-US.Jason",
      wsKeepaliveMs: 0, brainMaxTokens: 2048, brainReasoningEffort: "off", echoGuard: false,
    }).connect({ sessionId: "test", systemInstruction: "Help the user.", availableTools: [], callbacks: { onEvent: (event) => events.push(event) } });
    const asr = mock.sockets[0]!;
    await session.sendRealtimeAudio({ data: Buffer.alloc(640).toString("base64"), mimeType: "audio/pcm;rate=16000" });
    await session.sendAudioStreamEnd();
    // Two phrases with punctuation/casing drift re-emitted by the ASR (the
    // exact live failure mode: the same block twice in one committed turn).
    asr.emitEvent({ type: "conversation.item.input_audio_transcription.completed", transcript: "That's quite amazing", is_last_result: false });
    asr.emitEvent({ type: "conversation.item.input_audio_transcription.completed", transcript: "that's quite amazing.", is_last_result: false });
    asr.emitEvent({ type: "conversation.item.input_audio_transcription.completed", transcript: "So what do you know about me?", is_last_result: false });
    asr.emitEvent({ type: "conversation.item.input_audio_transcription.completed", transcript: "Thats quite amazing. So what do you know about me?", is_last_result: true });
    await vi.waitFor(() => expect(events.some((event) => event.type === "response" && event.status === "completed")).toBe(true));
    const userText = events.find((event) => event.type === "text" && event.speaker === "user");
    expect(userText).toMatchObject({
      speaker: "user",
      // The kept raw text is the most complete re-emission (apostrophe drift
      // is preserved as spoken; only the duplication is collapsed).
      text: "Thats quite amazing. So what do you know about me?",
      final: true,
    });
    expect(brainRequests).toHaveLength(1);
    expect((brainRequests[0]?.messages as Array<{ role: string; content: string }>).at(-1))
      .toEqual({ role: "user", content: "Thats quite amazing. So what do you know about me?" });
    await session.close();
  });

  it("drops a user turn that echoes recently spoken assistant text", async () => {
    const brainRequests: Record<string, unknown>[] = [];
    let nextBrain: "tool_call" | "answer" = "tool_call";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).endsWith("_sessions")) {
        return new Response(JSON.stringify({ client_secret: null }), { status: 200 });
      }
      brainRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (nextBrain === "tool_call") {
        nextBrain = "answer";
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: "",
              tool_calls: [{ id: "call_1", function: { name: "continue_hermes_conversation", arguments: "{}" } }],
            },
          }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "Answer." } }] }), { status: 200 });
    });
    const events: LiveModelEvent[] = [];
    const dropped: Array<{ kind: string; text: string }> = [];
    const session = await new RivaRealtimeAdapter({
      asrUrl: "ws://127.0.0.1:19000/v1/realtime?intent=transcription",
      ttsUrl: "ws://127.0.0.1:19001/v1/realtime?intent=synthesize",
      brainUrl: "http://127.0.0.1:30000/v1/chat/completions",
      brainModel: "qwen3.8-27b",
      voice: "Magpie-Multilingual.EN-US.Jason",
      wsKeepaliveMs: 0, brainMaxTokens: 2048, brainReasoningEffort: "off", echoGuard: true,
    }).connect({ sessionId: "test", systemInstruction: "Help the user.", availableTools: ["continue_hermes_conversation"], callbacks: {
      onEvent: (event) => events.push(event),
      onDroppedTurn: (drop) => dropped.push(drop),
    } });

    // A real tool call registers the pending call, then the receipt is spoken.
    await session.sendText("ask hermes about my tasks");
    await vi.waitFor(() => expect(events.some((event) => event.type === "tool_call")).toBe(true));
    await session.sendToolResponse(
      { id: "call_1", name: "continue_hermes_conversation", args: {} },
      { spoken_response: "On it — I'm checking with Hermes now." },
    );
    await vi.waitFor(() => expect(events.some((event) => event.type === "text" && event.speaker === "assistant")).toBe(true));
    const asr = mock.sockets.filter((socket) => socket.intent === "transcription").at(-1)!;
    await session.sendRealtimeAudio({ data: Buffer.alloc(640).toString("base64"), mimeType: "audio/pcm;rate=16000" });
    await session.sendAudioStreamEnd();
    asr.emitEvent({ type: "conversation.item.input_audio_transcription.completed", transcript: "On it", is_last_result: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(dropped).toEqual([{ kind: "echo", text: "On it" }]);
    expect(events.filter((event) => event.type === "text" && event.speaker === "user")).toHaveLength(0);
    // Only the tool-call turn hit the brain; the echo never did.
    expect(brainRequests).toHaveLength(1);

    // A genuinely new utterance on the next turn still reaches the brain.
    const next = mock.sockets.filter((socket) => socket.intent === "transcription").at(-1)!;
    await session.sendRealtimeAudio({ data: Buffer.alloc(640).toString("base64"), mimeType: "audio/pcm;rate=16000" });
    await session.sendAudioStreamEnd();
    next.emitEvent({ type: "conversation.item.input_audio_transcription.completed", transcript: "what is the weather forecast", is_last_result: true });
    await vi.waitFor(() => expect(brainRequests).toHaveLength(2));
    await session.close();
  });
});

describe("boundedHistory", () => {
  it("keeps complete tool-call exchanges and never starts with an orphaned tool result", () => {
    const messages: BrainMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_1" }] },
      { role: "tool", tool_call_id: "call_1", content: "r1" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_2" }] },
      { role: "tool", tool_call_id: "call_2", content: "r2" },
      { role: "user", content: "second" },
      { role: "assistant", content: "done" },
    ];
    // The window cuts between an assistant tool_calls message and its result:
    // the orphaned tool result is dropped instead of leading the history with
    // an unmatched tool message.
    const kept = boundedHistory(messages, 3);
    expect(kept[0]?.role).not.toBe("tool");
    expect(kept.map((message) => message.role)).toEqual(["user", "assistant"]);
    // A window that lands cleanly keeps every exchange intact.
    expect(boundedHistory(messages, 4).map((message) => message.role))
      .toEqual(["assistant", "tool", "user", "assistant"]);
    // A short history passes through untouched.
    expect(boundedHistory(messages.slice(0, 2), 4)).toEqual(messages.slice(0, 2));
  });
});

describe("wordBoosting", () => {
  it("sends the configured phrases as the single entry the Riva NIM applies", () => {
    expect(wordBoosting({ asrWordBoost: ["Hermes", "herdr", "exodia", "Mac mini"], asrWordBoostScore: 30 })).toEqual({
      word_boosting: {
        enable_word_boosting: true,
        word_boosting_list: [{ phrases: ["Hermes", "herdr", "exodia", "Mac mini"], boost: 30 }],
      },
    });
  });

  it("is carried in the ASR transcription_session.update on connect", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ client_secret: null }), { status: 200 }));
    mock.sockets.length = 0;
    const session = await new RivaRealtimeAdapter({
      asrUrl: "ws://127.0.0.1:19000/v1/realtime?intent=transcription",
      ttsUrl: "ws://127.0.0.1:19001/v1/realtime?intent=synthesize",
      brainUrl: "http://127.0.0.1:30000/v1/chat/completions",
      brainModel: "qwen3.8-27b",
      voice: "Magpie-Multilingual.EN-US.Jason",
      wsKeepaliveMs: 0, brainMaxTokens: 2048, brainReasoningEffort: "off", echoGuard: false,
      asrWordBoost: ["herdr", "exodia"], asrWordBoostScore: 40,
    }).connect({ sessionId: "boost", systemInstruction: "Help.", availableTools: [], callbacks: { onEvent: () => {} } });
    const update = mock.sockets[0]!.sent.find((event) => event.type === "transcription_session.update");
    expect((update?.session as Record<string, unknown>).word_boosting).toEqual({
      enable_word_boosting: true, word_boosting_list: [{ phrases: ["herdr", "exodia"], boost: 40 }],
    });
    await session.close();
  });

  it("omits the block when there are no phrases or the boost is zero", () => {
    // The NIM rejects an empty phrase list, so nothing must be sent at all.
    expect(wordBoosting({ asrWordBoost: [], asrWordBoostScore: 30 })).toEqual({});
    expect(wordBoosting({ asrWordBoost: ["Hermes"], asrWordBoostScore: 0 })).toEqual({});
    expect(wordBoosting({})).toEqual({});
  });
});

describe("mergeTranscriptParts", () => {
  it("replaces a part with its longer progressive refinement", () => {
    expect(mergeTranscriptParts(["Turn on the"], "turn on the lights")).toEqual(["turn on the lights"]);
    expect(mergeTranscriptParts(["turn on the lights"], "Turn on the")).toEqual(["turn on the lights"]);
  });

  it("drops exact and near-duplicate re-emissions of earlier parts", () => {
    expect(mergeTranscriptParts(["hello there"], "Hello there!")).toEqual(["Hello there!"]);
    expect(mergeTranscriptParts(["hello there", "what time is it"], "hello there")).toEqual(["hello there", "what time is it"]);
    expect(mergeTranscriptParts(["What do you know about me"], "what do you know about me?")).toHaveLength(1);
  });

  it("keeps genuinely new segments and caps growth", () => {
    expect(mergeTranscriptParts(["one two three"], "four five six")).toEqual(["one two three", "four five six"]);
    const parts: string[] = [];
    for (let index = 0; index < 40; index += 1) parts.push(`segment number ${index} spoken aloud`);
    expect(mergeTranscriptParts(parts, "a brand new final phrase")).toHaveLength(32);
  });

  it("treats a tiny stem contained in a later segment as a progressive partial", () => {
    // "I" is a partial of "Iceland is nice" (its containment in the longer
    // part collapses it); the longer part is never swallowed by a short one.
    expect(mergeTranscriptParts(["I"], "Iceland is nice")).toEqual(["Iceland is nice"]);
    // A single-word incoming never matches against a multi-word part, but the
    // standalone word is still dropped when contained in one (repeat noise).
    expect(mergeTranscriptParts(["what time is it"], "time")).toEqual(["what time is it"]);
  });
});

describe("Riva ASR socket resilience", () => {
  const baseConfig = {
    asrUrl: "ws://127.0.0.1:19000/v1/realtime?intent=transcription",
    ttsUrl: "ws://127.0.0.1:19001/v1/realtime?intent=synthesize",
    brainUrl: "http://127.0.0.1:30000/v1/chat/completions",
    brainModel: "qwen3.8-27b",
    voice: "Magpie-Multilingual.EN-US.Jason",
    wsKeepaliveMs: 0, brainMaxTokens: 2048, brainReasoningEffort: "off" as const, echoGuard: false,
  };

  function mockBrain(content = "Hi.") {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).endsWith("_sessions")) {
        return new Response(JSON.stringify({ client_secret: null }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    });
  }

  it("silently reconnects when the NIM idle-closes the ASR socket between turns", async () => {
    mockBrain();
    const events: LiveModelEvent[] = [];
    const closes: unknown[] = [];
    const session = await new RivaRealtimeAdapter({ ...baseConfig, wsKeepaliveMs: 0 })
      .connect({ sessionId: "t", systemInstruction: "x", availableTools: [], callbacks: {
        onEvent: (event) => events.push(event),
        onClose: (reason) => closes.push(reason),
      } });
    const first = mock.sockets[0]!;
    first.close(); // idle NIM close, no turn in flight
    await vi.waitFor(() => expect(mock.sockets.filter((socket) => socket.intent === "transcription")).toHaveLength(2));
    expect(closes).toHaveLength(0);
    // The next utterance flows over the replacement socket.
    const second = mock.sockets[1]!;
    await session.sendRealtimeAudio({ data: Buffer.alloc(640).toString("base64"), mimeType: "audio/pcm;rate=16000" });
    expect(second.sent.map((event) => event.type)).toContain("input_audio_buffer.append");
    await session.close();
  });

  it("propagates a mid-turn ASR close to the live session", async () => {
    mockBrain();
    const closes: Array<{ code: number; reason: string }> = [];
    const session = await new RivaRealtimeAdapter({ ...baseConfig, wsKeepaliveMs: 0 })
      .connect({ sessionId: "t", systemInstruction: "x", availableTools: [], callbacks: {
        onEvent: () => undefined,
        onClose: (info) => closes.push(info as { code: number; reason: string }),
      } });
    const asr = mock.sockets[0]!;
    await session.sendRealtimeAudio({ data: Buffer.alloc(640).toString("base64"), mimeType: "audio/pcm;rate=16000" });
    await session.sendAudioStreamEnd();
    asr.close(); // died while awaiting the final transcript
    await vi.waitFor(() => expect(closes).toHaveLength(1));
    expect(closes[0]).toMatchObject({ code: 1000 });
    await session.close();
  });

  it("pings the ASR socket on the keepalive interval", async () => {
    mockBrain();
    vi.useFakeTimers();
    try {
      const session = await new RivaRealtimeAdapter({ ...baseConfig, wsKeepaliveMs: 25_000 })
        .connect({ sessionId: "t", systemInstruction: "x", availableTools: [], callbacks: { onEvent: () => undefined } });
      const asr = mock.sockets[0]!;
      expect(asr.pings.count).toBe(0);
      vi.advanceTimersByTime(25_000);
      expect(asr.pings.count).toBe(1);
      vi.advanceTimersByTime(50_000);
      expect(asr.pings.count).toBe(3);
      await session.close();
      vi.advanceTimersByTime(25_000);
      expect(asr.pings.count).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Riva brain budget and reasoning", () => {
  const brainConfig = {
    asrUrl: "ws://127.0.0.1:19000/v1/realtime?intent=transcription",
    ttsUrl: "ws://127.0.0.1:19001/v1/realtime?intent=synthesize",
    brainUrl: "http://127.0.0.1:30000/v1/chat/completions",
    brainModel: "qwen3.8-27b",
    voice: "Magpie-Multilingual.EN-US.Jason",
    wsKeepaliveMs: 0,
    brainMaxTokens: 2_048,
    brainReasoningEffort: "low" as const,
    echoGuard: false,
  };

  it("sends the configured budget and reasoning effort, strips think blocks", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).endsWith("_sessions")) return new Response(JSON.stringify({ client_secret: null }), { status: 200 });
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({
        choices: [{ message: { content: "<think>reasoning…</think>The answer is four." } }],
      }), { status: 200 });
    });
    const events: LiveModelEvent[] = [];
    const session = await new RivaRealtimeAdapter(brainConfig).connect({
      sessionId: "t", systemInstruction: "x", availableTools: [], callbacks: { onEvent: (event) => events.push(event) },
    });
    await session.sendText("what is two plus two");
    await vi.waitFor(() => expect(events.some((event) => event.type === "text" && event.speaker === "assistant")).toBe(true));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ max_tokens: 2_048, reasoning_effort: "low" });
    expect(events.find((event) => event.type === "text" && event.speaker === "assistant"))
      .toMatchObject({ text: "The answer is four.", final: true });
    await session.close();
  });

  it("retries an empty thinking answer without the effort cap, then speaks the recovery line if still empty", async () => {
    const requests: Array<Record<string, unknown>> = [];
    let emptyResponses = 2;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).endsWith("_sessions")) return new Response(JSON.stringify({ client_secret: null }), { status: 200 });
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const content = emptyResponses > 0 ? "" : "Recovered.";
      emptyResponses -= 1;
      return new Response(JSON.stringify({
        choices: [{ message: { content }, finish_reason: emptyResponses >= 0 ? "length" : "stop" }],
      }), { status: 200 });
    });
    const events: LiveModelEvent[] = [];
    const session = await new RivaRealtimeAdapter(brainConfig).connect({
      sessionId: "t", systemInstruction: "x", availableTools: [], callbacks: { onEvent: (event) => events.push(event) },
    });
    await session.sendText("tell me something long");
    await vi.waitFor(() => expect(events.filter((event) => event.type === "text" && event.speaker === "assistant")).toHaveLength(1));
    // First attempt empty (with effort), retry still empty (no effort, doubled
    // budget) → the single spoken text is the recovery line.
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ reasoning_effort: "low" });
    expect(requests[1]).toMatchObject({ max_tokens: 4_096 });
    expect("reasoning_effort" in requests[1]!).toBe(false);
    const assistant = events.filter((event) => event.type === "text" && event.speaker === "assistant");
    expect(assistant.at(-1)).toMatchObject({ text: "I lost my thread — say that again?" });
    await session.close();
  });

  it("speaks the recovered answer when the retry succeeds", async () => {    const requests: Array<Record<string, unknown>> = [];
    let emptied = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).endsWith("_sessions")) return new Response(JSON.stringify({ client_secret: null }), { status: 200 });
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (!emptied) { emptied = true; return new Response(JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "length" }] }), { status: 200 }); }
      return new Response(JSON.stringify({ choices: [{ message: { content: "Second try works." } }] }), { status: 200 });
    });
    const events: LiveModelEvent[] = [];
    const session = await new RivaRealtimeAdapter(brainConfig).connect({
      sessionId: "t", systemInstruction: "x", availableTools: [], callbacks: { onEvent: (event) => events.push(event) },
    });
    await session.sendText("try again");
    await vi.waitFor(() => expect(events.some((event) => event.type === "text" && event.speaker === "assistant")).toBe(true));
    expect(requests).toHaveLength(2);
    expect(events.find((event) => event.type === "text" && event.speaker === "assistant"))
      .toMatchObject({ text: "Second try works." });
    await session.close();
  });
});
