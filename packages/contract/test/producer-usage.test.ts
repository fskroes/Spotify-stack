import { describe, expect, it } from "vitest";
import { UsageAttemptSchema, sanitizeCliEnvelopeUsage } from "../src/index.js";

/**
 * The single shared sanitizer for a Claude CLI `--output-format json` final
 * result envelope. It must map only content-free usage facts into the wire
 * shape: the four token counters per actual model, a reported estimate when the
 * envelope carries one, and explicit `unavailable` states otherwise. No prompt,
 * transcript, session id, or other envelope field may cross this boundary.
 */
describe("sanitizeCliEnvelopeUsage", () => {
  const vector = { inputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 2, outputTokens: 4 };

  it("retains a single model's token vector, including an observed zero", () => {
    const usage = sanitizeCliEnvelopeUsage({
      modelUsage: { "claude-opus-4-8": vector },
      total_cost_usd: 0.02,
    });
    expect(usage.modelUsage).toEqual({
      availability: "observed",
      value: [{ model: "claude-opus-4-8", tokens: vector }],
    });
    expect(usage.reportedCost).toEqual({
      availability: "observed",
      value: { kind: "claude-cli-estimate", usd: 0.02 },
    });
    expect(usage.producer).toEqual({ source: "claude-cli-result" });
    expect(usage.billing.source).toBe("unknown");
    expect(usage.providerRetries.availability).toBe("unavailable");
  });

  it("keeps every model when the envelope reports more than one", () => {
    const second = { inputTokens: 1, cacheCreationInputTokens: 1, cacheReadInputTokens: 1, outputTokens: 1 };
    const usage = sanitizeCliEnvelopeUsage({
      modelUsage: { "claude-opus-4-8": vector, "claude-haiku-4-5": second },
    });
    expect(usage.modelUsage).toEqual({
      availability: "observed",
      value: [
        { model: "claude-opus-4-8", tokens: vector },
        { model: "claude-haiku-4-5", tokens: second },
      ],
    });
  });

  it("preserves an all-zero vector as observed, never dropping it as empty", () => {
    const zero = { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 };
    const usage = sanitizeCliEnvelopeUsage({ modelUsage: { "claude-opus-4-8": zero } });
    expect(usage.modelUsage).toEqual({
      availability: "observed",
      value: [{ model: "claude-opus-4-8", tokens: zero }],
    });
  });

  it("discards a malformed vector and reports usage unavailable", () => {
    for (const bad of [
      { inputTokens: 1.5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 }, // non-integer
      { inputTokens: -1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 }, // negative
      { inputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, // missing outputTokens
      { inputTokens: "1", cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 }, // wrong type
    ]) {
      const usage = sanitizeCliEnvelopeUsage({ modelUsage: { m: bad } });
      expect(usage.modelUsage.availability).toBe("unavailable");
    }
  });

  it("drops only the malformed model and keeps a valid sibling", () => {
    const usage = sanitizeCliEnvelopeUsage({
      modelUsage: { good: vector, bad: { inputTokens: -1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 } },
    });
    expect(usage.modelUsage).toEqual({ availability: "observed", value: [{ model: "good", tokens: vector }] });
  });

  it("calls a missing modelUsage map unavailable rather than zero", () => {
    expect(sanitizeCliEnvelopeUsage({}).modelUsage.availability).toBe("unavailable");
  });

  it("reads reported cost independently of missing token usage", () => {
    // Usage and cost are separate observations: a present estimate survives even
    // when the envelope exposed no valid model usage.
    const usage = sanitizeCliEnvelopeUsage({ total_cost_usd: 0.5 });
    expect(usage.modelUsage.availability).toBe("unavailable");
    expect(usage.reportedCost).toEqual({ availability: "observed", value: { kind: "claude-cli-estimate", usd: 0.5 } });
  });

  it("accepts a zero-dollar estimate as observed", () => {
    expect(sanitizeCliEnvelopeUsage({ total_cost_usd: 0 }).reportedCost).toEqual({
      availability: "observed",
      value: { kind: "claude-cli-estimate", usd: 0 },
    });
  });

  it("rejects a non-finite, negative, or non-number cost as unavailable", () => {
    for (const usd of [-0.01, Number.NaN, Number.POSITIVE_INFINITY, "0.02", undefined]) {
      expect(sanitizeCliEnvelopeUsage({ total_cost_usd: usd }).reportedCost.availability).toBe("unavailable");
    }
  });

  it("never emits content-bearing envelope fields — output parses as a UsageAttempt", () => {
    const usage = sanitizeCliEnvelopeUsage({
      modelUsage: { "claude-opus-4-8": vector },
      total_cost_usd: 0.02,
      result: "secret assistant reply text",
      session_id: "abc-123",
    });
    const attempt = UsageAttemptSchema.parse({ rail: "agent", ordinal: 1, role: "initial", ...usage });
    expect(attempt).not.toHaveProperty("result");
    expect(attempt).not.toHaveProperty("session_id");
  });
});
