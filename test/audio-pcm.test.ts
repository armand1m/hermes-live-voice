import { describe, expect, it } from "vitest";
import {
  MAX_RESAMPLED_PCM16_BYTES,
  decodePcm16Base64,
  normalizePcm16Audio,
  parsePcmSampleRate,
  pcmMimeType,
  requirePcmSampleRate,
  resamplePcm16Base64,
  resamplePcm16Samples,
  validatePcmSampleRate,
} from "../src/domain/audio/pcm.js";

describe("PCM audio helpers", () => {
  it("parses PCM sample rates", () => {
    expect(parsePcmSampleRate("audio/pcm;rate=24000")).toBe(24000);
    expect(parsePcmSampleRate("audio/wav;rate=24000")).toBeUndefined();
  });

  it.each([0, 24_000.5, 7_999, 192_001])("rejects invalid PCM sample rate %s", (sampleRate) => {
    expect(parsePcmSampleRate(`audio/pcm;rate=${sampleRate}`)).toBeUndefined();
    expect(() => validatePcmSampleRate(sampleRate)).toThrow(/integer between 8000 and 192000/);
  });

  it("requires explicit valid source rate metadata", () => {
    expect(parsePcmSampleRate("audio/pcm")).toBeUndefined();
    expect(() => requirePcmSampleRate("audio/pcm")).toThrow(/must include exactly one integer rate/);
    expect(() => requirePcmSampleRate("audio/pcm;rate=not-a-number")).toThrow(/must include exactly one integer rate/);
    expect(() => requirePcmSampleRate("audio/pcm;rate=24000;rate=16000")).toThrow(
      /must include exactly one integer rate/,
    );
  });

  it("builds PCM mime types", () => {
    expect(pcmMimeType(16000)).toBe("audio/pcm;rate=16000");
    expect(() => pcmMimeType(16_000.5)).toThrow(/integer between 8000 and 192000/);
  });

  it("keeps audio unchanged when rate already matches", () => {
    const data = Buffer.from([0, 0, 1, 0]).toString("base64");
    expect(normalizePcm16Audio({ data, mimeType: "audio/pcm;rate=24000" }, 24000)).toEqual({
      data,
      mimeType: "audio/pcm;rate=24000",
    });
  });

  it("does not infer missing or malformed source rates during normalization", () => {
    const data = Buffer.from([0, 0]).toString("base64");

    expect(() => normalizePcm16Audio({ data, mimeType: "audio/pcm" }, 24_000)).toThrow(/must include exactly one/);
    expect(() => normalizePcm16Audio({ data, mimeType: "audio/pcm;rate=0" }, 24_000)).toThrow(
      /must include exactly one/,
    );
  });

  it("validates normalization target rates", () => {
    const data = Buffer.from([0, 0]).toString("base64");

    expect(() => normalizePcm16Audio({ data, mimeType: "audio/pcm;rate=24000" }, 0)).toThrow(
      /Target PCM sample rate must be an integer/,
    );
  });

  it("resamples PCM16 base64", () => {
    const input = Buffer.alloc(4);
    input.writeInt16LE(-1000, 0);
    input.writeInt16LE(1000, 2);

    const output = Buffer.from(resamplePcm16Base64(input.toString("base64"), 8_000, 16_000), "base64");

    expect(output.length).toBe(8);
  });

  it("validates direct resampling rates", () => {
    const input = Buffer.from([0, 0]).toString("base64");

    expect(() => resamplePcm16Base64(input, 0, 24_000)).toThrow(/Source PCM sample rate must be an integer/);
    expect(() => resamplePcm16Base64(input, 24_000, 192_000.5)).toThrow(/Target PCM sample rate must be an integer/);
  });

  it("caps resampled output allocation before amplification", () => {
    const maximumInputBytes = Math.floor(MAX_RESAMPLED_PCM16_BYTES / (192_000 / 8_000));
    const oversizedInputBytes = maximumInputBytes + (maximumInputBytes % 2 === 0 ? 2 : 1);
    const input = Buffer.alloc(oversizedInputBytes).toString("base64");

    expect(() => resamplePcm16Base64(input, 8_000, 192_000)).toThrow(/allocation limit/);
  });

  it("rejects odd PCM byte counts", () => {
    expect(() => resamplePcm16Base64(Buffer.from([1]).toString("base64"), 16000, 24000)).toThrow(/even number/);
  });

  it("decodes base64 PCM16 into little-endian samples", () => {
    const buffer = Buffer.alloc(4);
    buffer.writeInt16LE(-1000, 0);
    buffer.writeInt16LE(32_767, 2);
    expect(Array.from(decodePcm16Base64(buffer.toString("base64")))).toEqual([-1000, 32_767]);
    expect(() => decodePcm16Base64(Buffer.from([1]).toString("base64"))).toThrow(/even number/);
  });

  it("resamples PCM16 samples to normalized floats", () => {
    const samples = Int16Array.from([0, 16_384, -16_384, 16_384]);

    const identity = resamplePcm16Samples(samples, 24_000, 24_000);
    expect(identity).toHaveLength(4);
    expect(identity[1]).toBeCloseTo(0.5, 5);
    expect(identity[2]).toBeCloseTo(-0.5, 5);

    // Upsampling doubles the length with linear interpolation between samples.
    const up = resamplePcm16Samples(samples, 8_000, 16_000);
    expect(up).toHaveLength(8);
    expect(up[1]).toBeCloseTo(0.25, 5);
    expect(up[2]).toBeCloseTo(0.5, 5);

    // Downsampling 24k -> 16k turns 3 samples into 2.
    const down = resamplePcm16Samples(Int16Array.from([16_384, 16_384, 16_384]), 24_000, 16_000);
    expect(down).toHaveLength(2);
    expect(down[0]).toBeCloseTo(0.5, 5);

    expect(resamplePcm16Samples(new Int16Array(0), 24_000, 16_000)).toHaveLength(0);
    expect(() => resamplePcm16Samples(samples, 0, 16_000)).toThrow(/Source PCM sample rate/);
    expect(() => resamplePcm16Samples(samples, 24_000, 192_000.5)).toThrow(/Target PCM sample rate/);
  });
});
