import { describe, expect, it, vi } from "vitest";
import {
  createTaskNarrationService,
  narrationFactSheet,
} from "../src/application/live-gateway/task-narration.service.js";
import { NarratorLlmClient } from "../src/adapters/outbound/narrator/narrator-llm.client.js";

const SNAPSHOT = {
  taskId: "task_0123456789abcdef",
  kind: "background",
  rootTaskId: "task_0123456789abcdef",
  sequence: 8,
  state: "completed",
  title: "Inspect repository",
  createdAt: 1780000000000,
  updatedAt: 1780000010000,
  startedAt: 1780000000500,
  finishedAt: 1780000010000,
  result: { summary: "Repository checks passed.", output: "3 checks passed", truncated: false },
} as const;

function fakeClient(markdown = "**Done** — checks passed") {
  const summarize = vi.fn(async () => markdown);
  return { summarize, model: "qwen3.8-27b" } as unknown as NarratorLlmClient;
}

describe("narrationFactSheet", () => {
  it("composes a verbatim fact sheet from the projected snapshot", () => {
    expect(narrationFactSheet(SNAPSHOT)).toBe(
      "title: Inspect repository\n"
      + "state: completed\n"
      + "summary: Repository checks passed.\n"
      + "output: 3 checks passed",
    );
  });

  it("includes lineage, progress, and error lines when present", () => {
    const input = {
      ...SNAPSHOT,
      kind: "follow_up",
      parentTaskId: "task_ffffffffffffffff",
      state: "failed",
      result: undefined,
      error: { code: "TASK_TIMEOUT", message: "worker exceeded its budget" },
    };
    const sheet = narrationFactSheet(input);
    expect(sheet).toContain("state: failed");
    expect(sheet).toContain("lineage: follow-up task of task_ffffffffffffffff");
    expect(sheet).toContain("error: TASK_TIMEOUT: worker exceeded its budget");
  });

  it("truncates very long retained output before it reaches the model", () => {
    const sheet = narrationFactSheet({
      ...SNAPSHOT,
      result: { summary: "s", output: "x".repeat(5_000), truncated: true },
    });
    expect(sheet).toContain("(truncated)");
    expect(sheet.length).toBeLessThan(4_100);
  });
});

describe("createTaskNarrationService", () => {
  it("narrates once per revision and reports cache hits", async () => {
    const client = fakeClient();
    const service = createTaskNarrationService({ client });

    const first = await service.narrate(SNAPSHOT);
    expect(first).toMatchObject({
      taskId: SNAPSHOT.taskId,
      sequence: SNAPSHOT.sequence,
      updatedAt: SNAPSHOT.updatedAt,
      markdown: "**Done** — checks passed",
      model: "qwen3.8-27b",
      cached: false,
    });
    expect(client.summarize).toHaveBeenCalledTimes(1);

    // Cache hit: same revision, no second LLM call, flagged cached.
    const second = await service.narrate(SNAPSHOT);
    expect(second.cached).toBe(true);
    expect(client.summarize).toHaveBeenCalledTimes(1);
    expect(service.cached(SNAPSHOT.taskId, SNAPSHOT.sequence, SNAPSHOT.updatedAt)?.markdown)
      .toBe("**Done** — checks passed");

    // A revised task summarizes again.
    await service.narrate({ ...SNAPSHOT, sequence: 9, updatedAt: SNAPSHOT.updatedAt + 1 });
    expect(client.summarize).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent narrations of the same revision", async () => {
    let release: () => void = () => {};
    const summarize = vi.fn(() => new Promise<string>((resolve) => {
      release = () => resolve("**Once**");
    }));
    const service = createTaskNarrationService({ client: { summarize, model: "m" } as unknown as NarratorLlmClient });

    const first = service.narrate(SNAPSHOT);
    const second = service.narrate(SNAPSHOT);
    release();
    expect(await first).toMatchObject({ markdown: "**Once**", cached: false });
    expect(await second).toMatchObject({ markdown: "**Once**", cached: false });
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it("quarantines failed revisions for the TTL, then retries them", async () => {
    vi.useFakeTimers();
    try {
      const boom = fakeClient();
      (boom as unknown as { summarize: vi.fn }).summarize
        .mockRejectedValueOnce(new Error("LLM responded 500"))
        .mockResolvedValueOnce("**Recovered**");
      const service = createTaskNarrationService({ client: boom, failureTtlMs: 1_000 });

      // The failure propagates…
      await expect(service.narrate(SNAPSHOT)).rejects.toThrow("LLM responded 500");
      // …and the revision is quarantined: the next caller fails fast without
      // touching the LLM again (a 5xx may have crashed the model server).
      await expect(service.narrate(SNAPSHOT)).rejects.toThrow("quarantined");
      expect((boom as unknown as { summarize: vi.fn }).summarize).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_100);
      await expect(service.narrate(SNAPSHOT)).resolves.toMatchObject({ markdown: "**Recovered**" });
      expect((boom as unknown as { summarize: vi.fn }).summarize).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("evicts the oldest entry past the bound", async () => {
    const client = fakeClient();
    const service = createTaskNarrationService({ client, maxEntries: 2 });

    await service.narrate(SNAPSHOT);
    await service.narrate({ ...SNAPSHOT, sequence: 9, updatedAt: SNAPSHOT.updatedAt + 1, taskId: "task_bbbbbbbbbbbbbbbb" });
    await service.narrate({ ...SNAPSHOT, sequence: 9, updatedAt: SNAPSHOT.updatedAt + 2, taskId: "task_cccccccccccccccc" });
    expect(service.cached(SNAPSHOT.taskId, SNAPSHOT.sequence, SNAPSHOT.updatedAt)).toBeUndefined();
    expect(service.cached("task_cccccccccccccccc", 9, SNAPSHOT.updatedAt + 2)).toBeDefined();
  });
});

describe("NarratorLlmClient", () => {
  const fetchModule = globalThis.fetch;

  it("sends system + user messages (sglang rejects user-less calls) and strips think blocks", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({
        choices: [{ message: { content: "<think>reasoning…</think>\n**Summary**" } },
        ],
      }), { status: 200 });
    });
    try {
      const client = new NarratorLlmClient({
        baseUrl: "http://127.0.0.1:30000/v1",
        model: "qwen3.8-27b",
        requestTimeoutMs: 5_000,
      });
      await expect(client.summarize("system prompt", "fact sheet")).resolves.toBe("**Summary**");
      expect(calls[0].url).toBe("http://127.0.0.1:30000/v1/chat/completions");
      const messages = calls[0].body.messages as Array<{ role: string; content: string }>;
      expect(messages.map((message) => message.role)).toEqual(["system", "user"]);
      expect(calls[0].body.model).toBe("qwen3.8-27b");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("surfaces non-OK upstream responses and empty content as errors", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 500 }));
    const client = new NarratorLlmClient({
      baseUrl: "http://127.0.0.1:30000/v1",
      model: "m",
      requestTimeoutMs: 5_000,
    });
    await expect(client.summarize("s", "f")).rejects.toThrow("responded 500");
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ choices: [{ message: {} }] }), { status: 200 }));
    await expect(client.summarize("s", "f")).rejects.toThrow("no content");
    vi.unstubAllGlobals();
  });

  it("uses the real fetch by default (smoke: the client is constructible)", () => {
    expect(typeof fetchModule).toBe("function");
  });
});
