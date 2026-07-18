/**
 * The vocabulary the prototype is written in: what a definition is, what the
 * two artifact layers hold, and what the grounding check reports.
 */
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

/** One thing the repo defines, at a place a reader can open. */
export interface Definition {
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
  /** The declaration line, trimmed — enough to use the symbol without opening the file. */
  signature: string;
}

/** What one source file defines and what it names from elsewhere. */
export interface FileSymbols {
  file: string;
  definitions: Definition[];
  /** Identifiers referenced in this file, with duplicates kept (they are the edge weights). */
  references: string[];
}

/** A file that survived ranking, with the lines that made the budget. */
export interface RankedFile {
  file: string;
  score: number;
  definitions: Definition[];
}

/** Layer 1 of the artifact: deterministic, ranked, token-budgeted. */
export interface RepoMap {
  repo: string;
  sha: string;
  generatedAt: string;
  budgetTokens: number;
  usedTokens: number;
  filesIncluded: number;
  filesOmitted: number;
  /** Files a grammar claimed but could not be read or parsed — never silently dropped. */
  filesSkipped: string[];
  files: RankedFile[];
}

/** What the grounding check measures an answer against. */
export interface RepoIndex {
  sha: string;
  files: Set<string>;
  symbols: Set<string>;
}

export type ClaimKind = "file" | "symbol";
export type ClaimVerdict = "verified" | "not-found" | "proposed";

export interface Claim {
  value: string;
  kind: ClaimKind;
  verdict: ClaimVerdict;
}

export interface GroundingReport {
  claims: Claim[];
  verified: number;
  notFound: number;
  proposed: number;
  /** verified / (verified + notFound). Proposed claims are excluded; 1 when nothing was claimed. */
  groundedRatio: number;
}
