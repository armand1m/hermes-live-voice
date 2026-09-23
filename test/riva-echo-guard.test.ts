import { describe, expect, it } from "vitest";
import { RivaEchoGuard } from "../src/adapters/outbound/realtime/riva-echo-guard.js";

describe("RivaEchoGuard", () => {
  it("drops verbatim repeats of recently spoken text at any length", () => {
    const guard = new RivaEchoGuard();
    guard.note("On it — I'm checking with Hermes now.");
    expect(guard.isEcho("On it")).toBe(true);
    expect(guard.isEcho("on it!")).toBe(true);
    expect(guard.isEcho("On it — I'm checking with Hermes now. Keep talking; I'll share the answer the moment I have it."))
      .toBe(true);
  });

  it("drops partial echoes by containment and near-identical transcriptions by token overlap", () => {
    const guard = new RivaEchoGuard();
    guard.note("Let me look through our past chats — give me a moment.");
    // Containment: the mic caught only part of the receipt.
    expect(guard.isEcho("give me a moment")).toBe(true);
    // ASR drift on the same sentence still matches on token overlap.
    expect(guard.isEcho("let me look through our past chats give me a moment")).toBe(true);
  });

  it("keeps genuinely new user turns", () => {
    const guard = new RivaEchoGuard();
    guard.note("Your background task is finished. The result is ready in the task inbox.");
    expect(guard.isEcho("what did the task say exactly")).toBe(false);
    expect(guard.isEcho("hello there")).toBe(false);
    // Single-token turns are never dropped by the guard.
    expect(guard.isEcho("finished")).toBe(false);
  });

  it("forgets entries after the ring TTL and caps the ring", () => {
    let now = 1_000_000;
    const guard = new RivaEchoGuard(() => now);
    guard.note("first spoken line");
    now += 6 * 60_000;
    guard.note("second spoken line");
    expect(guard.isEcho("first spoken line")).toBe(false);
    expect(guard.isEcho("second spoken line")).toBe(true);
    for (let index = 0; index < 20; index += 1) guard.note(`overflow line number ${index}`);
    expect(guard.isEcho("second spoken line")).toBe(false);
  });
});
