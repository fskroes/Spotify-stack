import { describe, expect, it } from "vitest";
import {
  buildKnowledgeProsePrompt,
  buildRepoMapFromIndex,
  compileKnowledgeArtifact,
  parseKnowledgeArtifact,
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
});
