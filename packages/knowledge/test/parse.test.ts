import { describe, expect, it } from "vitest";
import { extractSymbols, languageForPath } from "../src/parse.js";

describe("extractSymbols", () => {
  it("extracts declaration signatures and excludes declaration names from references", async () => {
    const source = `export interface Result { ok: boolean }
export function run(input: Result): Result { return input; }
`;
    const language = languageForPath("src/result.ts");

    const parsed = await extractSymbols("src/result.ts", source, language!);

    expect(parsed.symbols.find((symbol) => symbol.name === "Result")).toMatchObject({
      kind: "interface",
      line: 1,
      signature: "export interface Result",
    });
    expect(parsed.symbols.find((symbol) => symbol.name === "run")).toMatchObject({
      kind: "function",
      line: 2,
      signature: "export function run(input: Result): Result",
    });
    expect(parsed.references).toContain("Result");
    expect(parsed.references).not.toContain("run");
  });

  it("keeps type-level properties but excludes local variable declarations", async () => {
    const source = `export class Store {
  value = 1;
  run() { const scratch = this.value; return scratch; }
}
`;
    const parsed = await extractSymbols("src/store.ts", source, languageForPath("src/store.ts")!);

    expect(parsed.symbols.map((symbol) => symbol.name)).toContain("value");
    expect(parsed.symbols.map((symbol) => symbol.name)).not.toContain("scratch");
  });

  it("captures arrow and function-expression exports as module functions", async () => {
    const source = `export const handler = (value) => value;
export const transform = function (value) { return value; };
`;
    const parsed = await extractSymbols("src/handlers.js", source, languageForPath("src/handlers.js")!);

    expect(parsed.symbols).toMatchObject([
      { name: "handler", kind: "function", line: 1 },
      { name: "transform", kind: "function", line: 2 },
    ]);
  });

  it("extracts Swift type shapes, extensions, properties, and functions", async () => {
    const source = `struct Formatter {
  var prefix: String
  func render(_ value: String) -> String { return prefix + value }
}

extension Formatter {
  func normalized() -> String { return render("x") }
}
`;
    const parsed = await extractSymbols("Sources/Formatter.swift", source, languageForPath("Sources/Formatter.swift")!);

    expect(parsed.symbols.filter((symbol) => symbol.name === "Formatter").map((symbol) => symbol.kind)).toEqual([
      "struct",
      "extension",
    ]);
    expect(parsed.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "prefix", kind: "property" }),
        expect.objectContaining({ name: "render", kind: "function" }),
        expect.objectContaining({ name: "normalized", kind: "function" }),
      ]),
    );
  });
});
