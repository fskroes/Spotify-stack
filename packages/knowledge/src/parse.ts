import { WasmParserBackend, type ParserBackend, type ParserLanguage, type SyntaxNode } from "./parser-backend.js";
import type { ParsedFile, ParsedSymbol, SymbolKind } from "./types.js";

interface LanguageSpec {
  language: ParserLanguage;
  extensions: string[];
  referenceTypes: Set<string>;
  classify(node: SyntaxNode): Declared | undefined;
}

interface Declared {
  name: string;
  kind: SymbolKind;
  nameNode: SyntaxNode;
}

const typeBodies = new Set(["class_body", "enum_class_body", "protocol_body", "source_file"]);

function firstDescendant(node: SyntaxNode, type: string): SyntaxNode | undefined {
  return node.descendantsOfType(type)[0];
}

function swiftKind(node: SyntaxNode): SymbolKind {
  const declaration = node.text.split("{")[0] ?? "";
  if (/\bextension\b/.test(declaration)) return "extension";
  if (/\bstruct\b/.test(declaration)) return "struct";
  if (/\benum\b/.test(declaration)) return "enum";
  return "class";
}

const swift: LanguageSpec = {
  language: "swift",
  extensions: [".swift"],
  referenceTypes: new Set(["type_identifier", "simple_identifier"]),
  classify(node) {
    switch (node.type) {
      case "class_declaration": {
        const nameNode = node.childForFieldName("name") ?? firstDescendant(node, "type_identifier");
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
        if (!typeBodies.has(node.parentType ?? "")) return undefined;
        const nameNode = firstDescendant(node, "simple_identifier");
        return nameNode ? { name: nameNode.text, kind: "property", nameNode } : undefined;
      }
      default:
        return undefined;
    }
  },
};

function javascriptSpec(language: ParserLanguage, extensions: string[]): LanguageSpec {
  const named = (node: SyntaxNode, kind: SymbolKind): Declared | undefined => {
    const nameNode = node.childForFieldName("name");
    return nameNode ? { name: nameNode.text, kind, nameNode } : undefined;
  };

  return {
    language,
    extensions,
    referenceTypes: new Set(["identifier", "type_identifier", "property_identifier"]),
    classify(node) {
      switch (node.type) {
        case "class_declaration":
          return named(node, "class");
        case "interface_declaration":
          return named(node, "interface");
        case "type_alias_declaration":
          return named(node, "type");
        case "enum_declaration":
          return named(node, "enum");
        case "function_declaration":
        case "method_definition":
        case "method_signature":
          return named(node, "function");
        case "variable_declarator": {
          const value = node.childForFieldName("value");
          return value && (value.type === "arrow_function" || value.type === "function_expression")
            ? named(node, "function")
            : undefined;
        }
        case "public_field_definition":
        case "property_signature":
          return named(node, "property");
        default:
          return undefined;
      }
    },
  };
}

const languages: LanguageSpec[] = [
  swift,
  javascriptSpec("typescript", [".ts", ".mts", ".cts"]),
  javascriptSpec("tsx", [".tsx", ".js", ".jsx", ".mjs", ".cjs"]),
];

export const supportedExtensions = languages.flatMap((language) => language.extensions);

export function languageForPath(file: string): LanguageSpec | undefined {
  const extension = file.slice(file.lastIndexOf(".")).toLowerCase();
  return languages.find((language) => language.extensions.includes(extension));
}

function signatureAt(source: string, line: number): string {
  return (source.split("\n")[line - 1] ?? "").split("{")[0].trim().slice(0, 160);
}

/** Parse declarations and weighted identifier references from one supported source file. */
export async function extractSymbols(
  file: string,
  source: string,
  language: LanguageSpec,
  backend: ParserBackend = new WasmParserBackend(),
): Promise<ParsedFile> {
  return backend.withTree(language.language, source, (root) => {
    const symbols: ParsedSymbol[] = [];
    const references: string[] = [];
    const declarationNames = new Set<number>();

    const visit = (node: SyntaxNode): void => {
      const declaration = language.classify(node);
      if (declaration) {
        declarationNames.add(declaration.nameNode.startIndex);
        symbols.push({
          name: declaration.name,
          kind: declaration.kind,
          file,
          line: declaration.nameNode.startLine,
          signature: signatureAt(source, declaration.nameNode.startLine),
        });
      }
      if (language.referenceTypes.has(node.type) && !declarationNames.has(node.startIndex)) {
        references.push(node.text);
      }
      for (const child of node.namedChildren) visit(child);
    };

    visit(root);
    return { file, symbols, references };
  });
}
