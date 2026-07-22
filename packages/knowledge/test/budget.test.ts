import { describe, expect, it } from "vitest";
import { estimateTokens, fitToBudget } from "../src/budget.js";

describe("fitToBudget", () => {
  it("rounds token estimates up and never exceeds the strict budget", () => {
    expect(estimateTokens("abcde")).toBe(2);
    expect(fitToBudget([{ file: "a.ts", score: 1, text: "abcde" }], 1).kept).toEqual([]);
  });

  it("orders by score then path and keeps scanning after an oversized block", () => {
    const result = fitToBudget(
      [
        { file: "z.ts", score: 1, text: "x".repeat(40) },
        { file: "b.ts", score: 0.5, text: "x".repeat(4) },
        { file: "a.ts", score: 0.5, text: "x".repeat(4) },
      ],
      2,
    );

    expect(result.kept.map((entry) => entry.file)).toEqual(["a.ts", "b.ts"]);
    expect(result.omitted).toBe(1);
    expect(result.usedTokens).toBe(2);
  });
});
