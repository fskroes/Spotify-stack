import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Language, Node, Parser, type Tree } from "web-tree-sitter";

export type ParserLanguage = "typescript" | "tsx" | "swift";

/** Parser-independent syntax view used only by knowledge extraction. */
export interface SyntaxNode {
  type: string;
  text: string;
  startIndex: number;
  startLine: number;
  parentType?: string;
  namedChildren: SyntaxNode[];
  childForFieldName(name: string): SyntaxNode | undefined;
  descendantsOfType(types: string | string[]): SyntaxNode[];
}

/** Isolates the runtime so the package API never exposes tree-sitter objects. */
export interface ParserBackend {
  withTree<T>(language: ParserLanguage, source: string, visit: (root: SyntaxNode) => T): Promise<T>;
}

const require = createRequire(import.meta.url);
const coreWasm = require.resolve("web-tree-sitter/web-tree-sitter.wasm");
const grammarPath = (name: string) => fileURLToPath(new URL(`../grammars/${name}`, import.meta.url));

const languagePaths: Record<ParserLanguage, string> = {
  typescript: grammarPath("tree-sitter-typescript.wasm"),
  tsx: grammarPath("tree-sitter-tsx.wasm"),
  swift: grammarPath("tree-sitter-swift.wasm"),
};

let runtime: Promise<void> | undefined;
const languages = new Map<ParserLanguage, Promise<Language>>();

function initialize(): Promise<void> {
  runtime ??= Parser.init({ locateFile: () => coreWasm });
  return runtime;
}

function loadLanguage(language: ParserLanguage): Promise<Language> {
  let loaded = languages.get(language);
  if (!loaded) {
    loaded = initialize().then(() => Language.load(languagePaths[language]));
    languages.set(language, loaded);
  }
  return loaded;
}

class WasmSyntaxNode implements SyntaxNode {
  constructor(private readonly node: Node) {}

  get type(): string {
    return this.node.type;
  }

  get text(): string {
    return this.node.text;
  }

  get startIndex(): number {
    return this.node.startIndex;
  }

  get startLine(): number {
    return this.node.startPosition.row + 1;
  }

  get parentType(): string | undefined {
    return this.node.parent?.type;
  }

  get namedChildren(): SyntaxNode[] {
    return this.node.namedChildren.map((child) => new WasmSyntaxNode(child));
  }

  childForFieldName(name: string): SyntaxNode | undefined {
    const child = this.node.childForFieldName(name);
    return child ? new WasmSyntaxNode(child) : undefined;
  }

  descendantsOfType(types: string | string[]): SyntaxNode[] {
    return this.node.descendantsOfType(types).map((node) => new WasmSyntaxNode(node));
  }
}

/** WASM parser runtime with immutable per-process runtime/language caches. */
export class WasmParserBackend implements ParserBackend {
  async withTree<T>(language: ParserLanguage, source: string, visit: (root: SyntaxNode) => T): Promise<T> {
    const parserLanguage = await loadLanguage(language);
    const parser = new Parser();
    let tree: Tree | null = null;
    try {
      parser.setLanguage(parserLanguage);
      tree = parser.parse(source);
      if (!tree) throw new Error("tree-sitter did not produce a syntax tree");
      return visit(new WasmSyntaxNode(tree.rootNode));
    } finally {
      tree?.delete();
      parser.delete();
    }
  }
}
