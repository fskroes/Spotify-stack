/**
 * Tree-sitter extraction, one grammar per language. Produces what a file
 * defines and what it names from elsewhere — the substrate both the ranking
 * graph and the grounding index are built from.
 */
import Parser from "tree-sitter";
import Swift from "tree-sitter-swift";
import TypeScriptGrammars from "tree-sitter-typescript";
import type { Definition, FileSymbols, SymbolKind } from "./types.js";

type Node = Parser.SyntaxNode;

interface Declared {
  name: string;
  kind: SymbolKind;
  /** The node carrying the name — the anchor for the line number and signature. */
  nameNode: Node;
}

export interface LanguageSpec {
  id: string;
  grammar: unknown;
  extensions: string[];
  /** A definition, if this node declares one. */
  classify(node: Node): Declared | undefined;
  /** Node types whose text counts as naming something defined elsewhere. */
  referenceTypes: Set<string>;
}

/** Bodies where a `let`/`var` is API rather than a local scratch variable. */
const TYPE_BODIES = new Set(["class_body", "enum_class_body", "protocol_body", "source_file"]);

/** Swift folds struct/class/enum/actor/extension into one node type; the keyword tells them apart. */
function swiftKind(node: Node): SymbolKind {
  const head = node.text.slice(0, 200);
  if (/\bextension\b/.test(head.split("{")[0])) return "extension";
  if (/\bstruct\b/.test(head.split("{")[0])) return "struct";
  if (/\benum\b/.test(head.split("{")[0])) return "enum";
  return "class";
}

const swift: LanguageSpec = {
  id: "swift",
  grammar: Swift,
  extensions: [".swift"],
  classify(node) {
    switch (node.type) {
      case "class_declaration": {
        // `extension Foo` names its subject with a user_type, not a bare type_identifier.
        const nameNode = node.childForFieldName("name") ?? node.descendantsOfType("type_identifier")[0];
        return nameNode ? { name: nameNode.text, kind: swiftKind(node), nameNode } : undefined;
      }
      case "protocol_declaration": {
        const nameNode = node.childForFieldName("name");
        return nameNode ? { name: nameNode.text, kind: "protocol", nameNode } : undefined;
      }
      case "function_declaration":
      case "protocol_function_declaration": {
        const nameNode = node.childForFieldName("name");
        return nameNode ? { name: nameNode.text, kind: "function", nameNode } : undefined;
      }
      case "property_declaration": {
        if (!TYPE_BODIES.has(node.parent?.type ?? "")) return undefined;
        const nameNode = node.descendantsOfType("simple_identifier")[0];
        return nameNode ? { name: nameNode.text, kind: "property", nameNode } : undefined;
      }
      default:
        return undefined;
    }
  },
  referenceTypes: new Set(["type_identifier", "simple_identifier"]),
};

function typescriptSpec(id: string, grammar: unknown, extensions: string[]): LanguageSpec {
  return {
    id,
    grammar,
    extensions,
    classify(node) {
      const named = (kind: SymbolKind): Declared | undefined => {
        const nameNode = node.childForFieldName("name");
        return nameNode ? { name: nameNode.text, kind, nameNode } : undefined;
      };
      switch (node.type) {
        case "class_declaration":
          return named("class");
        case "interface_declaration":
          return named("interface");
        case "type_alias_declaration":
          return named("type");
        case "enum_declaration":
          return named("enum");
        case "function_declaration":
        case "method_definition":
          return named("function");
        default:
          return undefined;
      }
    },
    referenceTypes: new Set(["identifier", "type_identifier", "property_identifier"]),
  };
}

const grammars = TypeScriptGrammars as { typescript: unknown; tsx: unknown };

const LANGUAGES: LanguageSpec[] = [
  swift,
  typescriptSpec("typescript", grammars.typescript, [".ts", ".mts", ".cts"]),
  typescriptSpec("tsx", grammars.tsx, [".tsx", ".js", ".jsx", ".mjs", ".cjs"]),
];

export function languageFor(file: string): LanguageSpec | undefined {
  const dot = file.lastIndexOf(".");
  if (dot < 0) return undefined;
  const ext = file.slice(dot).toLowerCase();
  return LANGUAGES.find((l) => l.extensions.includes(ext));
}

export const supportedExtensions = LANGUAGES.flatMap((l) => l.extensions);

const parser = new Parser();

/**
 * Definitions plus references for one file. Definition *names* are not counted
 * as references, so a file cannot vote for itself in the ranking graph.
 */
export function extractSymbols(file: string, source: string, language: LanguageSpec | string): FileSymbols {
  const spec = typeof language === "string" ? LANGUAGES.find((l) => l.id === language) : language;
  if (!spec) throw new Error(`no grammar for language "${language as string}"`);

  parser.setLanguage(spec.grammar as never);
  const tree = parser.parse(source);

  const lines = source.split("\n");
  const definitions: Definition[] = [];
  const references: string[] = [];
  const nameNodes = new Set<number>();

  const visit = (node: Node) => {
    const def = spec.classify(node);
    if (def) {
      // Anchor on the name, not the node: a declaration node starts at its
      // attributes (`@MainActor`, `@discardableResult`), which are not the
      // line a reader wants to open.
      const row = def.nameNode.startPosition.row;
      definitions.push({
        name: def.name,
        kind: def.kind,
        file,
        line: row + 1,
        // Everything up to the body: the declaration, never the implementation.
        signature: (lines[row] ?? "").split("{")[0].trim().slice(0, 160),
      });
      nameNodes.add(def.nameNode.startIndex);
    }
    if (spec.referenceTypes.has(node.type) && !nameNodes.has(node.startIndex)) {
      references.push(node.text);
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(tree.rootNode);

  // References keep duplicates and keep names this file also defines — the
  // ranking graph drops self-edges itself, and a same-name definition
  // elsewhere is a real edge.
  return { file, definitions, references };
}
