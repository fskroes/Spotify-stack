import { describe, expect, it } from "vitest";
import { extractResultEnvelope, sumStreamTokens, totalTokens } from "../src/claude.js";

const envelope = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "result",
    result: "the answer",
    usage: { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 5 },
    total_cost_usd: 0.01,
    num_turns: 3,
    duration_ms: 900,
    ...extra,
  });

describe("extractResultEnvelope", () => {
  it("reads a clean single-object stream", () => {
    const result = extractResultEnvelope(envelope());

    expect(result.result).toBe("the answer");
    expect(result.usage.input_tokens).toBe(12);
  });

  it("survives a hook line printed ahead of the JSON", () => {
    const contaminated = `SessionStart hook: ready\n${envelope()}`;

    expect(extractResultEnvelope(contaminated).result).toBe("the answer");
  });

  it("takes the last result envelope in a stream-json transcript", () => {
    const stream = [
      JSON.stringify({ type: "assistant", message: "thinking" }),
      envelope({ result: "final" }),
    ].join("\n");

    expect(extractResultEnvelope(stream).result).toBe("final");
  });

  it("fails loudly, showing the output, when no envelope is present", () => {
    expect(() => extractResultEnvelope("command not found")).toThrow(/command not found/);
  });

  it("defaults missing usage counters to zero rather than throwing", () => {
    const noUsage = JSON.stringify({ type: "result", result: "x" });

    expect(extractResultEnvelope(noUsage).usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });
});

describe("sumStreamTokens", () => {
  it("adds up every assistant iteration, not just the last one", () => {
    const turn = (input: number, output: number, cacheRead: number) =>
      JSON.stringify({
        type: "assistant",
        message: { usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead } },
      });

    const stream = [turn(10, 5, 100), turn(2, 7, 400), envelope()].join("\n");

    expect(sumStreamTokens(stream)).toBe(10 + 5 + 100 + 2 + 7 + 400);
  });

  it("ignores non-assistant events and unparsable preamble", () => {
    const stream = [
      "hook noise",
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 3, output_tokens: 4 } } }),
    ].join("\n");

    expect(sumStreamTokens(stream)).toBe(7);
  });

  it("returns zero when the stream carries no usage at all", () => {
    expect(sumStreamTokens(envelope())).toBe(0);
  });
});

describe("totalTokens", () => {
  it("sums every counter that was billed as context or output", () => {
    expect(
      totalTokens({
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 40,
      }),
    ).toBe(100);
  });
});
