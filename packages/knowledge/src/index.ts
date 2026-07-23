export { checkKnowledgeDrift, parseKnowledgeArtifact } from "./drift.js";
export type { KnowledgeArtifact, KnowledgeDriftReport } from "./drift.js";
export { compareGroundingBaseline, checkGrounding } from "./grounding.js";
export type { GroundingBaselineComparison, GroundingClaim, GroundingReport } from "./grounding.js";
export { buildIndex, buildRepoMap, buildRepoMapFromIndex, renderMap } from "./map.js";
export { buildKnowledgeProsePrompt, compileKnowledgeArtifact, KNOWLEDGE_PROSE_SECTIONS, validateKnowledgeProse } from "./prose.js";
export type { CompiledKnowledgeArtifact } from "./prose.js";
export type {
  ParsedFile,
  ParsedSymbol,
  RankedFile,
  RepoIndex,
  RepoMap,
  SkippedFile,
  SymbolKind,
} from "./types.js";
