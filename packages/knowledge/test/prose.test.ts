import { describe, expect, it } from "vitest";
import {
  buildKnowledgeProsePrompt,
  buildRepoMapFromIndex,
  compileKnowledgeArtifact,
  parseKnowledgeArtifact,
  stripDeliveryWrapper,
  validateKnowledgeProse,
  type RepoIndex,
} from "../src/index.js";

const index: RepoIndex = {
  repo: "demo",
  sha: "a".repeat(40),
  dirty: false,
  files: ["src/service.ts"],
  parsedFiles: [{ file: "src/service.ts", references: [], symbols: [{ name: "serve", kind: "function", file: "src/service.ts", line: 1, signature: "function serve()" }] }],
  symbols: [{ name: "serve", kind: "function", file: "src/service.ts", line: 1, signature: "function serve()" }],
  filesSkipped: [],
};

const prose = `## Product

The product exposes \`serve\` from src/service.ts.

## Architecture

A single service module owns the implementation.

## Key seams

\`serve\` is the entry point.

## Principal data flows

Requests reach \`serve\`.

## Conventions

Source lives under src/service.ts.

## Feature landing zones

Add service behavior in src/service.ts.

## Verify gate

Run the repository test suite.

## Unknowns

No runtime integrations are visible in the structural map.
`;

describe("knowledge prose compilation", () => {
  it("renders one supplied structural snapshot into the compiler prompt", () => {
    const map = buildRepoMapFromIndex(index);
    expect(map.sha).toBe(index.sha);
    const prompt = buildKnowledgeProsePrompt(map);
    expect(prompt).toContain("## Structural map");
    expect(prompt).toContain("src/service.ts");
    expect(prompt).toContain("function serve()");
  });

  it("validates headings, computes grounding independently, and serializes compatible frontmatter", () => {
    const compiled = compileKnowledgeArtifact(prose, index);
    const artifact = parseKnowledgeArtifact(compiled.markdown);

    expect(artifact.sha).toBe(index.sha);
    expect(artifact.groundingRatio).toBe(compiled.grounding.groundedRatio);
    expect(compiled.grounding.groundedRatio).toBe(1);
    expect(artifact.prose).toBe(prose);
  });

  it("rejects prose with a missing required heading before it can be written", () => {
    expect(() => validateKnowledgeProse(prose.replace("## Unknowns\n\nNo runtime integrations are visible in the structural map.\n", ""))).toThrow(/Unknowns/);
  });

  it("strips a leading delivery-wrapper preamble the model prints before the artifact", () => {
    const wrapped = `This is a content-generation task, so here is the knowledge artifact. I have full grounding.\n\n${prose}`;
    expect(stripDeliveryWrapper(wrapped)).toBe(prose.trim());
    expect(validateKnowledgeProse(wrapped)).toBe(prose);
  });

  it("strips a trailing sign-off the final section would otherwise absorb", () => {
    const signOff = "Since this was a documentation deliverable, there's nothing to implement — the artifact above is complete. Let me know if you want changes.";
    const wrapped = `${prose.trimEnd()}\n\n${signOff}\n`;
    const validated = validateKnowledgeProse(wrapped);
    expect(validated).toBe(prose);
    expect(validated).not.toContain("Let me know");
    expect(validated).not.toContain("nothing to implement");
  });

  it("keeps a genuine trailing Unknowns paragraph that is not a sign-off", () => {
    const factual = `${prose.trimEnd()}\n\nThe upstream API host is a placeholder and its real contract is unverified.\n`;
    expect(validateKnowledgeProse(factual)).toContain("The upstream API host is a placeholder");
  });

  it("preserves a final Unknowns paragraph that names the deliverable itself", () => {
    // Ordinary words a grounded section may legitimately use — "deliverable",
    // "knowledge artifact" — must not be mistaken for a sign-off and deleted.
    const factual = `${prose.trimEnd()}\n\nWhether the V5 schema stage was intentionally skipped is a decision a maintainer must confirm before this knowledge artifact is treated as a complete deliverable.\n`;
    const validated = validateKnowledgeProse(factual);
    expect(validated).toContain("knowledge artifact is treated as a complete deliverable");
    expect(validated).toContain("a maintainer must confirm");
  });

  it("never strips a section down to a bare heading, even when its only paragraph reads like a sign-off", () => {
    // A single-paragraph Unknowns whose text matches a sign-off pattern is still
    // that section's only content; peeling it would silently empty the section.
    const soleUnknown = prose.replace(
      "No runtime integrations are visible in the structural map.",
      "Whether the sync loop retries on rate-limit responses is unclear; a maintainer should let me know the intended policy.",
    );
    const validated = validateKnowledgeProse(soleUnknown);
    expect(validated).toContain("a maintainer should let me know the intended policy");
  });

  it("labels the grounding ratio as structural-reference coverage, not behavioral proof", () => {
    const compiled = compileKnowledgeArtifact(prose, index);
    expect(compiled.markdown).toContain("grounding_basis: structural-references");
    expect(compiled.markdown).toContain("# grounding_ratio is the share of referenced files and symbols");
    // The clarifying frontmatter comment must not disturb the narrow parse contract.
    const artifact = parseKnowledgeArtifact(compiled.markdown);
    expect(artifact.groundingRatio).toBe(compiled.grounding.groundedRatio);
    expect(artifact.prose).toBe(prose);
  });

  it("instructs the model to bound behavioral claims, disclose doc conflicts, and skip preamble", () => {
    const prompt = buildKnowledgeProsePrompt(buildRepoMapFromIndex(index));
    expect(prompt).toMatch(/Do not assert behavior from a name or signature alone/);
    expect(prompt).toMatch(/documentation and current source materially disagree/);
    expect(prompt).toMatch(/Prefer current source for runtime behavior/);
    expect(prompt).toMatch(/declaration-truncation counts or omitted-file counts/);
    expect(prompt).toMatch(/Do not write any sentence before ## Product or after the final section/);
  });
});
