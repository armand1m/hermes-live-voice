// Task-log narration through the gateway: the browser asks
// POST /v1/task-narration for a markdown summary of one task, and the
// gateway summarizes the record it owns through its configured
// OpenAI-compatible LLM (the local sglang server in this deployment) with a
// server-side cache keyed by task id + revision. This module keeps a
// client-side cache for snappy re-renders, dedupes concurrent requests per
// revision, races a deadline so a hung request can never leave an entry on
// "restructuring…" forever, and short-circuits to disabled when the gateway
// answers 503 (narration not configured). Failures negative-cache briefly so
// a struggling LLM is retried, not hammered. The endpoint and fetch impl are
// injectable so tests drive fakes.

// The gateway enforces its own LLM timeout (default 30s); this deadline only
// guards against a wedged fetch, so it sits slightly above it.
const DEFAULT_TIMEOUT_MS = 35_000;
// A failed narration is remembered for this long before it is retried.
const DEFAULT_NEGATIVE_TTL_MS = 60_000;

/**
 * @param {object} options
 * @param {string} options.endpoint Mount-path-aware POST URL (voice.js builds it).
 * @param {() => string | undefined} [options.getToken] Bearer token for the request.
 * @param {typeof fetch} [options.fetchImpl] Defaults to the global fetch.
 * @param {number} [options.timeoutMs] Raced deadline per narration.
 * @param {number} [options.negativeTtlMs] How long failures stay cached.
 */
export function createTaskNarrator(options = {}) {
  const endpoint = options.endpoint;
  const getToken = options.getToken ?? (() => undefined);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const negativeTtlMs = options.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
  const cache = new Map();
  const inflight = new Map();
  let disabled = typeof fetchImpl !== "function";

  // Cache key covers the revision channels the protocol exposes: a task the
  // gateway did not revise narrates exactly once per page lifetime.
  const keyOf = (task) => `${task.taskId}:${task.sequence}:${task.updatedAt}`;

  /** Synchronous cache read: {markdown, model}, null (recent failure), or undefined. */
  function cached(task) {
    const entry = cache.get(keyOf(task));
    if (entry === undefined) return undefined;
    if (entry.markdown === null && Date.now() - entry.at > negativeTtlMs) {
      cache.delete(keyOf(task));
      return undefined;
    }
    return entry.markdown === null ? null : { markdown: entry.markdown, model: entry.model };
  }

  /** Generate (or join) the narration for this task revision. Resolves null on any failure. */
  async function narrate(task) {
    const hit = cached(task);
    if (hit !== undefined) return hit;
    if (disabled) return null;
    const key = keyOf(task);
    const pending = inflight.get(key);
    if (pending) return pending;

    const run = (async () => {
      let timer;
      try {
        const controller = new AbortController();
        const deadline = new Promise((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve(null);
          }, timeoutMs);
        });
        const headers = { "content-type": "application/json" };
        const token = getToken();
        if (token) headers.authorization = `Bearer ${token}`;
        const work = fetchImpl(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({ taskId: task.taskId }),
          cache: "no-store",
          signal: controller.signal,
        }).then(async (response) => {
          if (response.status === 503) {
            disabled = true;
            return null;
          }
          if (!response.ok) throw new Error(`narration endpoint responded ${response.status}`);
          const payload = await response.json();
          if (typeof payload?.markdown !== "string" || !payload.markdown.trim()) {
            throw new Error("narration payload has no markdown");
          }
          return { markdown: payload.markdown.trim(), model: payload.model || "gateway" };
        });
        // A late settle/reject after the deadline won the race must not
        // surface as an unhandled rejection.
        work.catch(() => {});
        const result = await Promise.race([work, deadline]);
        if (result === null) throw new Error(disabled ? "narration is disabled" : `timed out after ${timeoutMs}ms`);
        cache.set(key, { ...result, at: Date.now() });
        return result;
      } catch (error) {
        console.warn("[task-narrator] narration failed for", task.taskId, "—", error?.message ?? error);
        cache.set(key, { markdown: null, at: Date.now() });
        return null;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        inflight.delete(key);
      }
    })();
    inflight.set(key, run);
    return run;
  }

  return { cached, narrate, get disabled() { return disabled; } };
}
