import { describe, expect, it } from "vitest";
import { rankFiles } from "../src/rank.js";
import type { FileSymbols } from "../src/types.js";

const def = (file: string, name: string) => ({
  name,
  kind: "type" as const,
  file,
  line: 1,
  signature: `struct ${name}`,
});

describe("rankFiles", () => {
  it("ranks a file referenced by many others above one referenced by none", () => {
    const files: FileSymbols[] = [
      { file: "Core.swift", definitions: [def("Core.swift", "Store")], references: [] },
      { file: "A.swift", definitions: [def("A.swift", "AView")], references: ["Store"] },
      { file: "B.swift", definitions: [def("B.swift", "BView")], references: ["Store"] },
      { file: "Lonely.swift", definitions: [def("Lonely.swift", "Unused")], references: [] },
    ];

    const scores = rankFiles(files);

    expect(scores.get("Core.swift")!).toBeGreaterThan(scores.get("Lonely.swift")!);
    expect(scores.get("Core.swift")!).toBeGreaterThan(scores.get("A.swift")!);
  });

  it("passes rank through a chain — a file the hubs depend on outranks the hubs", () => {
    const files: FileSymbols[] = [
      { file: "Base.swift", definitions: [def("Base.swift", "HTTPClient")], references: [] },
      { file: "Mid.swift", definitions: [def("Mid.swift", "SyncService")], references: ["HTTPClient"] },
      { file: "Leaf1.swift", definitions: [def("Leaf1.swift", "L1")], references: ["SyncService"] },
      { file: "Leaf2.swift", definitions: [def("Leaf2.swift", "L2")], references: ["SyncService"] },
    ];

    const scores = rankFiles(files);

    expect(scores.get("Mid.swift")!).toBeGreaterThan(scores.get("Leaf1.swift")!);
    expect(scores.get("Base.swift")!).toBeGreaterThan(scores.get("Leaf1.swift")!);
  });

  it("ignores self-references so a file cannot inflate its own rank", () => {
    const files: FileSymbols[] = [
      {
        file: "Solo.swift",
        definitions: [def("Solo.swift", "Solo")],
        references: ["Solo", "Solo", "Solo", "Solo"],
      },
      { file: "Other.swift", definitions: [def("Other.swift", "Other")], references: [] },
    ];

    const scores = rankFiles(files);

    expect(scores.get("Solo.swift")!).toBeCloseTo(scores.get("Other.swift")!, 6);
  });

  it("scores every file and normalises the distribution to sum to 1", () => {
    const files: FileSymbols[] = [
      { file: "A.swift", definitions: [def("A.swift", "A")], references: ["B"] },
      { file: "B.swift", definitions: [def("B.swift", "B")], references: ["A"] },
    ];

    const scores = rankFiles(files);

    expect([...scores.keys()].sort()).toEqual(["A.swift", "B.swift"]);
    const total = [...scores.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it("returns an empty ranking for an empty repo", () => {
    expect(rankFiles([]).size).toBe(0);
  });
});
