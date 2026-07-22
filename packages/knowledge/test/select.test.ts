import { describe, expect, it } from "vitest";
import { selectDefinitions } from "../src/select.js";
import type { ParsedSymbol, SymbolKind } from "../src/types.js";

const symbol = (name: string, kind: SymbolKind, line: number, file = "source.ts"): ParsedSymbol => ({
  name,
  kind,
  line,
  file,
  signature: `${kind} ${name}`,
});

describe("selectDefinitions", () => {
  it("keeps shapes before extensions, functions, and properties then restores source order", () => {
    const result = selectDefinitions(
      [
        symbol("field", "property", 1),
        symbol("run", "function", 2),
        symbol("Helpers", "extension", 3),
        symbol("Model", "interface", 4),
      ],
      3,
    );

    expect(result.kept.map((definition) => definition.name)).toEqual(["run", "Helpers", "Model"]);
    expect(result.dropped).toBe(1);
  });

  it("uses path and symbol names as a stable tie-breaker before restoring display order", () => {
    const result = selectDefinitions(
      [
        symbol("Zulu", "function", 20, "b.ts"),
        symbol("Alpha", "function", 10, "a.ts"),
        symbol("Bravo", "function", 5, "a.ts"),
      ],
      2,
    );

    expect(result.kept.map((definition) => definition.name)).toEqual(["Bravo", "Alpha"]);
  });
});
