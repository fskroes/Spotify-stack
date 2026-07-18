import { describe, expect, it } from "vitest";
import { languageFor, extractSymbols } from "../src/parse.js";

describe("languageFor", () => {
  it("maps source extensions to a supported grammar", () => {
    expect(languageFor("App/Views/FeedView.swift")?.id).toBe("swift");
    expect(languageFor("packages/cli/src/index.ts")?.id).toBe("typescript");
    expect(languageFor("app/main.tsx")?.id).toBe("tsx");
  });

  it("returns undefined for files with no grammar", () => {
    expect(languageFor("README.md")).toBeUndefined();
    expect(languageFor("Assets/Contents.json")).toBeUndefined();
  });
});

describe("extractSymbols — swift", () => {
  const source = `import SwiftUI

struct FeedView: View {
    @State private var selection: FeedSelection?

    func refresh() async {
        await FeedService.shared.runCycle()
    }
}

final class FeedService {
    func runCycle() {}
}

enum RefreshOption { case tomorrow }

protocol MailAction { func perform() }

extension FeedView {
    func focus() {}
}
`;

  const symbols = extractSymbols("App/Views/FeedView.swift", source, "swift");

  const kinds = (name: string) =>
    symbols.definitions.filter((d) => d.name === name).map((d) => d.kind);

  it("captures type declarations with their kind", () => {
    expect(kinds("FeedService")).toEqual(["class"]);
    expect(kinds("RefreshOption")).toEqual(["enum"]);
    expect(kinds("MailAction")).toEqual(["protocol"]);
  });

  it("keeps an extension as its own definition without shadowing the type", () => {
    expect(kinds("FeedView")).toEqual(["struct", "extension"]);
  });

  it("captures functions with a one-line signature and a line number", () => {
    const refresh = symbols.definitions.find((d) => d.name === "refresh");

    expect(refresh).toMatchObject({ kind: "function", file: "App/Views/FeedView.swift" });
    expect(refresh!.signature).toContain("func refresh()");
    expect(refresh!.line).toBe(6);
  });

  it("takes the declaration line itself, not a leading attribute", () => {
    const attributed = extractSymbols(
      "S.swift",
      `@MainActor
final class FeedActionService {
    @discardableResult
    func archive(messageId: String) async -> Bool { return true }
}
`,
      "swift",
    );
    const archive = attributed.definitions.find((d) => d.name === "archive");

    expect(archive!.signature).toBe("func archive(messageId: String) async -> Bool");
    expect(archive!.line).toBe(4);
  });

  it("keeps type-level properties and drops locals declared inside a function body", () => {
    const props = extractSymbols(
      "S.swift",
      `final class Store {
    private let logger = Logger()
    func load() {
        var scratch = 0
        let tail = "x"
    }
}
`,
      "swift",
    );
    const names = props.definitions.map((d) => d.name);

    expect(names).toContain("logger");
    expect(names).not.toContain("scratch");
    expect(names).not.toContain("tail");
  });

  it("records references to types used but not defined here", () => {
    expect(symbols.references).toContain("FeedService");
    expect(symbols.references).toContain("FeedSelection");
    expect(symbols.references).toContain("View");
  });
});

describe("extractSymbols — typescript", () => {
  const source = `import { buildMap } from "./map.js";

export interface RunResult { ok: boolean }

export class Runner {
  start(): RunResult { return { ok: buildMap().ok }; }
}

export function dispatch(task: string) { return new Runner().start(); }
`;

  const symbols = extractSymbols("packages/cli/src/run.ts", source, "typescript");

  it("captures classes, interfaces and functions", () => {
    const byName = new Map(symbols.definitions.map((d) => [d.name, d.kind]));

    expect(byName.get("Runner")).toBe("class");
    expect(byName.get("RunResult")).toBe("interface");
    expect(byName.get("dispatch")).toBe("function");
  });

  it("records imported and referenced identifiers", () => {
    expect(symbols.references).toContain("buildMap");
  });
});
