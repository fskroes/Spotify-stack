import { describe, expect, it } from "vitest";
import { rankFiles } from "../src/rank.js";
import type { ParsedFile } from "../src/types.js";

const parsed = (file: string, names: string[], references: string[] = []): ParsedFile => ({
  file,
  symbols: names.map((name) => ({ name, kind: "type", file, line: 1, signature: `type ${name}` })),
  references,
});

describe("rankFiles", () => {
  it("flows rank toward depended-on files, ignores self edges, and normalizes scores", () => {
    const scores = rankFiles([
      parsed("core.ts", ["Store"], ["Store", "Store"]),
      parsed("view-a.ts", ["ViewA"], ["Store"]),
      parsed("view-b.ts", ["ViewB"], ["Store"]),
      parsed("isolated.ts", ["Unused"]),
    ]);

    expect(scores.get("core.ts")!).toBeGreaterThan(scores.get("view-a.ts")!);
    expect(scores.get("core.ts")!).toBeGreaterThan(scores.get("isolated.ts")!);
    expect([...scores.values()].reduce((sum, score) => sum + score, 0)).toBeCloseTo(1, 12);
  });

  it("splits an ambiguous reference's weight between its definition files", () => {
    const scores = rankFiles([
      parsed("left.ts", ["Shared"]),
      parsed("right.ts", ["Shared"]),
      parsed("consumer.ts", ["Consumer"], ["Shared"]),
    ]);

    expect(scores.get("left.ts")).toBeCloseTo(scores.get("right.ts")!, 12);
  });
});
