import { checkGrounding, GROUNDING_BASIS, type GroundingReport } from "./grounding.js";
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

/**
 * Phrases that mark a trailing paragraph as a model sign-off rather than artifact
 * content: an offer to keep working, a self-reference to the artifact, or first-
 * person meta-commentary the third-person contract never produces. Used only to
 * peel a block off the tail — leading preamble is dropped by slicing to ## Product,
 * so these never gate real prose there. Deliberately conservative: only phrasings
 * a grounded section would not contain, so a genuine final paragraph survives even
 * when it happens to mention a "deliverable" or the "knowledge artifact" itself.
 */
const DELIVERY_WRAPPER_PATTERNS = [
  /\bhere (?:is|'s|are) the\b/i,
  /\bnothing to (?:implement|change|do)\b/i,
  /\blet me know\b/i,
  /\bthe artifact (?:above|below)\b/i,
  /\b(?:enough|full) grounding\b/i,
  /\bI (?:have|output|will|can|am|did|'ve|'ll)\b/i,
];

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
    "Output the document itself only. Do not write any sentence before ## Product or after the final section — no 'here is the artifact', no note about the response format, and no offer to make further changes.",
    "Make factual claims only when supported by the supplied structural map. Do not invent files, symbols, dependencies, or behavior.",
    "Characterize behavior only from evidence you have actually inspected — a method body, a test, or authoritative documentation. Do not assert behavior from a name or signature alone: when you have not read the implementation, hedge the claim in place or record it as unverified under ## Unknowns.",
    "When selected documentation and current source materially disagree, state the conflict explicitly. Prefer current source for runtime behavior and name the stale document for a maintainer to reconcile; never silently blend the two.",
    "You may inspect the current target repository only when the supplied map is insufficient. Do not write files, use the network, or rely on session or fleet memory.",
    "Under ## Unknowns, record only product or engineering decisions a reader should verify. Omit generator and map mechanics such as declaration-truncation counts or omitted-file counts unless a specific claim's reliability depends on them.",
    "",
    "## Structural map",
    "",
    renderMap(map).trimEnd(),
    "",
  ].join("\n");
}

function isDeliveryWrapper(block: string): boolean {
  const trimmed = block.trim();
  if (!trimmed || trimmed.startsWith("#")) return false;
  // List items and table rows are artifact content, never a trailing sign-off.
  if (/^(?:[-*+]|\d+[.)]|\|)/.test(trimmed)) return false;
  return DELIVERY_WRAPPER_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * Reduce raw model output to the strict artifact envelope: the ordered sections
 * and nothing else. Drops any preamble before ## Product and any trailing
 * delivery-wrapper paragraph a section would otherwise absorb. The interior —
 * intentional spacing and code fences — is left byte-for-byte intact: preamble
 * is removed by slicing, and sign-offs are peeled off the end one block at a
 * time, so nothing rewrites the middle of the document.
 */
export function stripDeliveryWrapper(prose: string): string {
  const normalized = prose.replace(/\r\n/g, "\n").trim();
  const product = normalized.match(/^## Product\s*$/m);
  let body = (product ? normalized.slice(product.index) : normalized).trimEnd();

  for (;;) {
    const boundary = body.lastIndexOf("\n\n");
    if (boundary === -1) break;
    const lastBlock = body.slice(boundary + 2);
    if (!isDeliveryWrapper(lastBlock)) break;
    // Never reduce a section to a bare heading: if the block a match would
    // leave exposed is the heading itself, the "sign-off" is really that
    // section's only content, so keep it and let grounding judge it instead.
    const priorBlock = body.slice(0, boundary).trimEnd().split(/\n{2,}/).pop() ?? "";
    if (priorBlock.startsWith("#")) break;
    body = body.slice(0, boundary).trimEnd();
  }

  return body;
}

/** Validate and normalize the Markdown contract before it becomes a stored artifact. */
export function validateKnowledgeProse(prose: string): string {
  const normalized = stripDeliveryWrapper(prose);
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
  // grounding_basis names what the ratio actually measures so a high number is
  // never read as behavioral proof; the comment carries that caveat to a human
  // opening the file, and the frontmatter parser ignores comment lines.
  const frontmatter = [
    "---",
    `sha: ${index.sha}`,
    `grounding_ratio: ${grounding.groundedRatio}`,
    `grounding_basis: ${GROUNDING_BASIS}`,
    "# grounding_ratio is the share of referenced files and symbols that exist in the map;",
    "# it does not verify that the surrounding behavioral prose is correct.",
    "---",
  ].join("\n");
  return {
    grounding,
    markdown: `${frontmatter}\n\n${validated}`,
  };
}
