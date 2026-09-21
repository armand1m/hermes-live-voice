import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidecarTtsClient, SIDECAR_FRAME_BYTES } from "../src/adapters/outbound/tts/local-tts.client.js";
import type { SpeechSinkFrame } from "../src/application/live-gateway/ports/speech-sink.port.js";
import { SpeechMux, type SpeechMuxEmit } from "../src/application/live-gateway/speech-mux.js";

const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  vi.restoreAllMocks();
});

/** Stub sidecar: streams what the handler decides for POST /v1/tts. */
function stubSidecar(handler: (text: string, res: import("node:http").ServerResponse) => void): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "POST" && req.url === "/v1/tts") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const text = JSON.parse(Buffer.concat(chunks).toString("utf8")).text ?? "";
        handler(text, res);
        return;
      }
      res.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
    openServers.push(server);
  });
}

function pcm(bytes: number): Buffer {
  const buffer = Buffer.alloc(bytes);
  for (let index = 0; index < bytes; index += 1) buffer[index] = index % 199;
  return buffer;
}

function client(baseUrl: string) {
  return new SidecarTtsClient({ baseUrl, requestTimeoutMs: 2_000, maxChars: 500 });
}

const noAbort = () => new AbortController().signal;

describe("SidecarTtsClient", () => {
  it("streams PCM chunks as aligned audio frames", async () => {
    const payload = pcm(SIDECAR_FRAME_BYTES * 2 + 100);
    const baseUrl = await stubSidecar((_text, res) => {
      res.writeHead(200, { "content-type": "audio/pcm" });
      for (let offset = 0; offset < payload.length; offset += 700) {
        res.write(payload.subarray(offset, offset + 700));
      }
      res.end();
    });
    const frames: SpeechSinkFrame[] = [];
    const outcome = await client(baseUrl).speak("Hello there.", {
      signal: noAbort(),
      onFrame: (frame) => frames.push(frame),
    });
    expect(outcome).toBe("spoken");
    expect(frames).toHaveLength(3);
    expect(frames[0]!.data).toBe(payload.subarray(0, SIDECAR_FRAME_BYTES).toString("base64"));
    expect(frames[1]!.final).toBe(false);
    expect(frames[2]!.final).toBe(true);
    expect(Buffer.from(frames[2]!.data, "base64").length).toBe(100);
  });

  it("marks the sidecar unhealthy after a failed request", async () => {
    const baseUrl = await stubSidecar((_text, res) => {
      res.writeHead(503).end("overloaded");
    });
    const sidecar = client(baseUrl);
    expect(sidecar.healthy).toBe(true);
    const outcome = await sidecar.speak("Hi.", { signal: noAbort(), onFrame: () => {} });
    expect(outcome).toBe("failed");
    expect(sidecar.healthy).toBe(false);
  });

  it("reports aborted when the caller cancels mid-stream", async () => {
    const baseUrl = await stubSidecar((_text, res) => {
      res.writeHead(200, { "content-type": "audio/pcm" });
      res.write(pcm(SIDECAR_FRAME_BYTES));
      // Stream deliberately never ends: the caller aborts.
    });
    const controller = new AbortController();
    const sidecar = client(baseUrl);
    await expect(sidecar.speak("Long text.", {
      signal: controller.signal,
      onFrame: () => controller.abort(),
    })).resolves.toBe("aborted");
    expect(sidecar.healthy).toBe(true);
  });

  it("fails a stalled stream through the watchdog without blaming the caller", async () => {
    const baseUrl = await stubSidecar((_text, res) => {
      res.writeHead(200, { "content-type": "audio/pcm" });
      res.write(pcm(10));
      // Silence forever: the stall watchdog must abort as a failure.
    });
    const sidecar = client(baseUrl);
    await expect(sidecar.speak("Stalled.", {
      signal: noAbort(),
      onFrame: () => {},
    })).resolves.toBe("failed");
    expect(sidecar.healthy).toBe(false);
  }, 10_000);
});

describe("SpeechMux", () => {
  function harness(overrides: Partial<ConstructorParameters<typeof SpeechMux>[0]> = {}) {
    const emitted: SpeechMuxEmit[] = [];
    const mux = new SpeechMux({
      client: client("http://127.0.0.1:1"),
      emit: (message) => emitted.push(message),
      gate: () => true,
      ...overrides,
    });
    return { mux, emitted };
  }

  it("speaks utterances in order with a transcript line first", async () => {
    const payloads = new Map<string, Buffer>([
      ["First.", pcm(SIDECAR_FRAME_BYTES)],
      ["Second.", pcm(SIDECAR_FRAME_BYTES)],
    ]);
    const baseUrl = await stubSidecar((text, res) => {
      res.writeHead(200, { "content-type": "audio/pcm" });
      res.end(payloads.get(text.trim()));
    });
    const { mux, emitted } = harness({ client: client(baseUrl) });
    await expect(mux.speak("First.")).resolves.toBe("spoken");
    await expect(mux.speak("Second.")).resolves.toBe("spoken");
    expect(emitted.map((message) => message.kind)).toEqual(["transcript", "audio", "transcript", "audio"]);
    expect(emitted[0]).toEqual({ kind: "transcript", text: "First." });
  });

  it("aborts the queue: in-flight stops, queued resolve aborted", async () => {
    let releaseStream: (() => void) | undefined;
    const baseUrl = await stubSidecar((_text, res) => {
      res.writeHead(200, { "content-type": "audio/pcm" });
      releaseStream = () => res.end(pcm(SIDECAR_FRAME_BYTES));
    });
    const { mux } = harness({ client: client(baseUrl) });
    const first = mux.speak("Holding.");
    const second = mux.speak("Queued.");
    await new Promise((resolve) => setImmediate(resolve));
    mux.abort();
    await expect(second).resolves.toBe("aborted");
    releaseStream?.();
    await expect(first).resolves.toBe("aborted");
  });

  it("skips gated utterances after the retry budget", async () => {
    vi.useFakeTimers();
    try {
      const { mux } = harness({ gate: () => false });
      const outcome = mux.speak("Never.");
      void vi.advanceTimersByTimeAsync(60_000);
      await expect(outcome).resolves.toBe("skipped");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves unavailable when the sidecar is in cooldown", async () => {
    const baseUrl = await stubSidecar((_text, res) => {
      res.writeHead(500).end();
    });
    const sidecar = client(baseUrl);
    await sidecar.speak("prime", { signal: noAbort(), onFrame: () => {} });
    const { mux } = harness({ client: sidecar });
    await expect(mux.speak("Hi.")).resolves.toBe("unavailable");
  });
});
