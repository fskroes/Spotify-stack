import { describe, expect, it } from "vitest";
import { selectDefinitions } from "../src/select.js";
import type { Definition, SymbolKind } from "../src/types.js";

const def = (name: string, kind: SymbolKind, line: number): Definition => ({
  name,
  kind,
  file: "S.swift",
  line,
  signature: `${kind} ${name}`,
});

describe("selectDefinitions", () => {
  it("keeps everything when the file is under the cap", () => {
    const defs = [def("A", "struct", 1), def("run", "function", 2)];

    expect(selectDefinitions(defs, 10).kept).toEqual(defs);
  });

  it("drops properties before functions and functions before types", () => {
    const defs = [
      def("p1", "property", 1),
      def("f1", "function", 2),
      def("T", "struct", 3),
      def("p2", "property", 4),
    ];

    const { kept } = selectDefinitions(defs, 2);

    expect(kept.map((d) => d.name)).toEqual(["f1", "T"]);
  });

  it("reports how many declarations it dropped", () => {
    const defs = [def("p1", "property", 1), def("p2", "property", 2), def("T", "struct", 3)];

    expect(selectDefinitions(defs, 1).dropped).toBe(2);
  });

  it("returns survivors in source order so the file still reads top to bottom", () => {
    const defs = [def("T", "struct", 30), def("f", "function", 10)];

    expect(selectDefinitions(defs, 2).kept.map((d) => d.line)).toEqual([10, 30]);
  });
});
