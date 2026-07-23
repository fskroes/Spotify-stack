import { checkGrounding, compareGroundingBaseline, type GroundingReport } from "./grounding.js";
import type { RepoIndex } from "./types.js";

export interface KnowledgeArtifact {
  sha: string;
  groundingRatio: number;
  prose: string;
}

export interface KnowledgeDriftReport {
  artifactSha: string;
  currentSha: string;
  dirty: boolean;
  baseline: number;
  current: number;
  delta: number;
  drifted: boolean;
  recompileRequired: boolean;
  grounding: GroundingReport;
}

function frontmatterFields(frontmatter: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of frontmatter.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*?)\s*$/);
    if (!match) continue;
    fields.set(match[1], match[2]);
  }
  return fields;
}

/** Parse the narrow frontmatter contract that grounding needs from stored prose. */
export function parseKnowledgeArtifact(markdown: string): KnowledgeArtifact {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new Error("knowledge artifact must begin with YAML frontmatter");

  const fields = frontmatterFields(match[1]);
  const sha = fields.get("sha");
  if (!sha) throw new Error("knowledge artifact frontmatter requires sha");

  const rawRatio = fields.get("grounding_ratio");
  if (rawRatio === undefined) throw new Error("knowledge artifact frontmatter requires grounding_ratio");
  const groundingRatio = Number(rawRatio);
  if (!Number.isFinite(groundingRatio) || groundingRatio < 0 || groundingRatio > 1) {
    throw new Error("knowledge artifact frontmatter grounding_ratio must be between 0 and 1");
  }

  return { sha, groundingRatio, prose: match[2].replace(/^\r?\n/, "") };
}

/** Ground stored prose against a fresh target index and apply the relative drift policy. */
export function checkKnowledgeDrift(artifact: KnowledgeArtifact, index: RepoIndex): KnowledgeDriftReport {
  const grounding = checkGrounding(artifact.prose, index);
  const comparison = compareGroundingBaseline(grounding.groundedRatio, artifact.groundingRatio);

  return {
    artifactSha: artifact.sha,
    currentSha: index.sha,
    dirty: index.dirty,
    baseline: comparison.baseline,
    current: comparison.current,
    delta: comparison.delta,
    drifted: comparison.drifted,
    recompileRequired: comparison.drifted,
    grounding,
  };
}
