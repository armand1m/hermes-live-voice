import { afterEach, describe, expect, it, vi } from "vitest";
// Browser-only module intentionally ships as plain ESM JavaScript.
// @ts-expect-error No declaration file is emitted for browser assets.
import { createTaskNarrator } from "../clients/browser/task-narrator.js";

const TASK = {
  taskId: "task_0123456789abcdef",
  sequence: 8,
  state: "completed",
  title: "Inspect repository",
  kind: "background",
  createdAt: 1780000000000,
  updatedAt: 1780000010000,
  result: { summary: "Repository checks passed.", output: "3 checks passed", truncated: false },
} as const;

const ENDPOINT = "/voice/v1/task-narration";

function jsonResponse(body: unknown, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

describe("createTaskNarrator", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts the task id with auth and caches the returned markdown per revision", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(ENDPOINT);
      expect(init.method).toBe("POST");
      expect(init.headers).toEqual({
        "content-type": "application/json",
        authorization: "Bearer t0k3n",
      });
      expect(JSON.parse(String(init.body))).toEqual({ taskId: TASK.taskId });
      return jsonResponse({ markdown: "**Done** — checks passed", model: "qwen3.8-27b", cached: false });
    });
    const narrator = createTaskNarrator({ endpoint: ENDPOINT, getToken: () => "t0k3n", fetchImpl });

    expect(narrator.cached(TASK)).toBeUndefined();
    await expect(narrator.narrate(TASK)).resolves.toEqual({
      markdown: "**Done** — checks passed",
      model: "qwen3.8-27b",
    });
    expect(narrator.cached(TASK)).toEqual({ markdown: "**Done** — checks passed", model: "qwen3.8-27b" });

    // Cached now: no second request.
    await narrator.narrate(TASK);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // A new revision (sequence/updatedAt moved) narrates again.
    await narrator.narrate({ ...TASK, sequence: 9, updatedAt: TASK.updatedAt + 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("short-circuits to disabled after one 503 and never fetches again", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ status: "narration_disabled" }, 503));
    const narrator = createTaskNarrator({ endpoint: ENDPOINT, fetchImpl });

    expect(await narrator.narrate(TASK)).toBeNull();
    expect(narrator.disabled).toBe(true);
    expect(await narrator.narrate({ ...TASK, taskId: "task_ffffffffffffffff" })).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("negative-caches failures briefly instead of hammering the endpoint", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async () => jsonResponse({ error: "boom" }, 502));
      const narrator = createTaskNarrator({ endpoint: ENDPOINT, fetchImpl, negativeTtlMs: 1_000 });

      expect(await narrator.narrate(TASK)).toBeNull();
      expect(narrator.cached(TASK)).toBeNull();
      await narrator.narrate(TASK);
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_100);
      await narrator.narrate(TASK);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back when the fetch wedges past the raced deadline", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        // Ignores the abort signal entirely; only the deadline ends the wait.
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("late abort")));
        }),
    );
    const narrator = createTaskNarrator({ endpoint: ENDPOINT, fetchImpl, timeoutMs: 10 });

    expect(await narrator.narrate(TASK)).toBeNull();
    expect(narrator.cached(TASK)).toBeNull();
  });

  it("rejects payloads without markdown", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ taskId: TASK.taskId }));
    const narrator = createTaskNarrator({ endpoint: ENDPOINT, fetchImpl });
    expect(await narrator.narrate(TASK)).toBeNull();
  });
});
