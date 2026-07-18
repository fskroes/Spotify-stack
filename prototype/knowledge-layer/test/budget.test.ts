import { describe, expect, it } from "vitest";
import { estimateTokens, fitToBudget } from "../src/budget.js";

describe("estimateTokens", () => {
  it("approximates four characters per token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("fitToBudget", () => {
  const entry = (key: string, score: number, chars: number) => ({
    key,
    score,
    text: "x".repeat(chars),
  });

  it("keeps the highest-scoring entries and reports the rest as omitted", () => {
    const result = fitToBudget(
      [entry("low", 0.1, 40), entry("high", 0.9, 40), entry("mid", 0.5, 40)],
      20, // 20 tokens = 80 chars = room for exactly two entries
    );

    expect(result.kept.map((k) => k.key)).toEqual(["high", "mid"]);
    expect(result.omitted).toBe(1);
  });

  it("never exceeds the budget", () => {
    const result = fitToBudget([entry("a", 1, 400), entry("b", 0.5, 400)], 50);

    expect(estimateTokens(result.kept.map((k) => k.text).join(""))).toBeLessThanOrEqual(50);
  });

  it("keeps scanning smaller entries after skipping one that does not fit", () => {
    const result = fitToBudget([entry("big", 0.9, 400), entry("small", 0.4, 40)], 20);

    expect(result.kept.map((k) => k.key)).toEqual(["small"]);
    expect(result.omitted).toBe(1);
  });

  it("reports the tokens actually used", () => {
    const result = fitToBudget([entry("a", 1, 40)], 100);

    expect(result.usedTokens).toBe(10);
  });

  it("omits everything when the budget is zero", () => {
    const result = fitToBudget([entry("a", 1, 40)], 0);

    expect(result.kept).toEqual([]);
    expect(result.omitted).toBe(1);
    expect(result.usedTokens).toBe(0);
  });
});
