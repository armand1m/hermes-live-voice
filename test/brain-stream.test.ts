import { describe, expect, it } from "vitest";
import {
  SentenceChunker,
  SseJsonDecoder,
  ThinkStripper,
  ToolCallAssembler,
} from "../src/adapters/outbound/realtime/brain-stream.js";

const encode = (text: string) => new TextEncoder().encode(text);

describe("SseJsonDecoder", () => {
  it("decodes data events split across byte chunks and skips DONE and noise", () => {
    const decoder = new SseJsonDecoder();
    expect(decoder.push(encode('data: {"a":1}\n\ndata: {"b"'))).toEqual([{ a: 1 }]);
    expect(decoder.push(encode(':2}\n\n: keepalive\ndata: [DONE]\n\n'))).toEqual([{ b: 2 }]);
  });
});

describe("ThinkStripper", () => {
  it("removes reasoning blocks whose tags are split across deltas", () => {
    const stripper = new ThinkStripper();
    const out = ["Hi <th", "ink>plan the ans", "wer</thi", "nk>there."].map((delta) => stripper.push(delta)).join("")
      + stripper.flush();
    expect(out).toBe("Hi there.");
  });

  it("never speaks an unterminated reasoning block", () => {
    const stripper = new ThinkStripper();
    expect(stripper.push("Okay. <think>still thinking")).toBe("Okay. ");
    expect(stripper.flush()).toBe("");
  });

  it("passes ordinary angle brackets through once they cannot be a tag", () => {
    const stripper = new ThinkStripper();
    expect(stripper.push("a <b> c") + stripper.flush()).toBe("a <b> c");
  });
});

describe("SentenceChunker", () => {
  it("emits sentences as soon as the following whitespace arrives", () => {
    const chunker = new SentenceChunker();
    expect(chunker.push("The build finished without errors.")).toEqual([]);
    expect(chunker.push(" All 1,078 tests pass")).toEqual(["The build finished without errors."]);
    expect(chunker.flush()).toBe("All 1,078 tests pass");
  });

  it("merges chunks shorter than the minimum into the next sentence", () => {
    const chunker = new SentenceChunker();
    expect(chunker.push("Hello! Good to see you again today. ")).toEqual(["Hello! Good to see you again today."]);
  });

  it("does not split numbered list markers, decimals, code fences, or tables", () => {
    const chunker = new SentenceChunker();
    const chunks = chunker.push([
      "Here are the steps you asked for:\n",
      "1. Run the migration script first.\n",
      "Version 3.5 is required for this. ",
      "```\nnpm run build. npm test\n```\n",
      "| a | b |\n| 1 | 2 |\n",
      "That covers everything for now.\n",
    ].join(""));
    expect(chunks).toContain("1. Run the migration script first.");
    expect(chunks).toContain("Version 3.5 is required for this.");
    expect(chunks.some((chunk) => chunk.startsWith("```") && chunk.endsWith("```"))).toBe(true);
    // Table rows stay in one chunk (this short block merges forward).
    expect(chunks.some((chunk) => chunk.includes("| a | b |\n| 1 | 2 |"))).toBe(true);
    expect(chunks.at(-1)).toContain("That covers everything for now.");
  });
});

describe("ToolCallAssembler", () => {
  it("joins name and argument fragments by index", () => {
    const assembler = new ToolCallAssembler();
    assembler.push([{ index: 0, id: "call_1", function: { name: "list_background", arguments: "" } }]);
    assembler.push([{ index: 0, function: { name: "_tasks", arguments: '{"summary_' } }]);
    assembler.push([{ index: 0, function: { arguments: 'only":true}' } }]);
    expect(assembler.result()).toEqual([{
      id: "call_1",
      type: "function",
      function: { name: "list_background_tasks", arguments: '{"summary_only":true}' },
    }]);
  });
});
