import { checkGrounding, type GroundingReport } from "./grounding.js";
import { renderMap } from "./map.js";
import type { RepoIndex, RepoMap } from "./types.js";

export const KNOWLEDGE_PROSE_SECTIONS = [
  "Product",
  "Architecture",
  "Key seams",
  "Principal data flows",
  "Conventions",
  "Feature landing zones",
  "Verify gate",
  "Unknowns",
] as const;

export interface CompiledKnowledgeArtifact {
  markdown: string;
  grounding: GroundingReport;
}

/** Build the fixed, model-facing contract around the deterministic structural map. */
export function buildKnowledgeProsePrompt(map: RepoMap): string {
  return [
    "Write a grounded knowledge artifact for this repository.",
    "Return Markdown only: no YAML frontmatter, preamble, or code fence.",
    "Use these exact level-two headings, in this order:",
    ...KNOWLEDGE_PROSE_SECTIONS.map((section) => `## ${section}`),
    "Make factual claims only when supported by the supplied structural map. Do not invent files, symbols, dependencies, or behavior.",
    "You may inspect the current target repository only when the supplied map is insufficient. Do not write files, use the network, or rely on session or fleet memory.",
    "Put every uncertainty and unavailable inference under ## Unknowns.",
    "",
    "## Structural map",
    "",
    renderMap(map).trimEnd(),
    "",
  ].join("\n");
}

/** Validate and normalize the Markdown contract before it becomes a stored artifact. */
export function validateKnowledgeProse(prose: string): string {
  const normalized = prose.replace(/\r\n/g, "\n").trim();
  const headings = [...normalized.matchAll(/^##\s+(.+?)\s*$/gm)].map((match) => match[1]);
  const expected = [...KNOWLEDGE_PROSE_SECTIONS];
  if (headings.length !== expected.length || headings.some((heading, index) => heading !== expected[index])) {
    throw new Error(`knowledge prose must contain these headings in order: ${expected.map((section) => `## ${section}`).join(", ")}`);
  }
  return `${normalized}\n`;
}

/** Stamp validated prose with its exact structural snapshot and computed grounding baseline. */
export function compileKnowledgeArtifact(prose: string, index: RepoIndex): CompiledKnowledgeArtifact {
  const validated = validateKnowledgeProse(prose);
  const grounding = checkGrounding(validated, index);
  return {
    grounding,
    markdown: `---\nsha: ${index.sha}\ngrounding_ratio: ${grounding.groundedRatio}\n---\n\n${validated}`,
  };
}
