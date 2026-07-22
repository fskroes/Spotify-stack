export type SymbolKind =
  | "struct"
  | "class"
  | "enum"
  | "protocol"
  | "interface"
  | "type"
  | "function"
  | "property"
  | "extension";

/** A named declaration, anchored at the line a reader can open. */
export interface ParsedSymbol {
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
  signature: string;
}

/** Structural facts extracted from one tracked source file. */
export interface ParsedFile {
  file: string;
  symbols: ParsedSymbol[];
  /** Repeated references are retained because they weight dependency edges. */
  references: string[];
}

/** A supported tracked source file that could not contribute structural facts. */
export interface SkippedFile {
  file: string;
  reason: "unreadable" | "parse-failed";
}

/** Unbudgeted, current-working-tree structural index. */
export interface RepoIndex {
  repo: string;
  sha: string;
  /** True when the tracked source used for this index differs from HEAD. */
  dirty: boolean;
  files: string[];
  parsedFiles: ParsedFile[];
  symbols: ParsedSymbol[];
  filesSkipped: SkippedFile[];
}

/** A parsed file ranked by the code that depends on it. */
export interface RankedFile {
  file: string;
  score: number;
  symbols: ParsedSymbol[];
}

/** Deterministic, budgeted map output. */
export interface RepoMap {
  repo: string;
  sha: string;
  /** True when the tracked source used for this map differs from HEAD. */
  dirty: boolean;
  budgetTokens: number;
  usedTokens: number;
  filesIncluded: number;
  filesOmitted: number;
  filesSkipped: SkippedFile[];
  files: RankedFile[];
}
