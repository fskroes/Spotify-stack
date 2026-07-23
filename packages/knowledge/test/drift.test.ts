import { describe, expect, it } from "vitest";
import { checkKnowledgeDrift, parseKnowledgeArtifact } from "../src/index.js";
import type { RepoIndex } from "../src/index.js";

const index: RepoIndex = {
  repo: "demo",
  sha: "current-sha",
  dirty: false,
  files: ["src/current.ts"],
  parsedFiles: [],
  symbols: [{ name: "currentThing", kind: "function", file: "src/current.ts", line: 1, signature: "function currentThing()" }],
  filesSkipped: [],
};

const artifact = `---
sha: compiled-sha
grounding_ratio: 0.923
---

The old implementation lives in \`src/old.ts\` beside \`oldThing\`.
`;

describe("knowledge artifacts", () => {
  it("parses the compile-time SHA, baseline, and prose body", () => {
    expect(parseKnowledgeArtifact(artifact)).toEqual({
      sha: "compiled-sha",
      groundingRatio: 0.923,
      prose: "The old implementation lives in `src/old.ts` beside `oldThing`.\n",
    });
  });

  it("rejects a missing or invalid grounding baseline", () => {
    expect(() => parseKnowledgeArtifact("---\nsha: compiled-sha\n---\ntext")).toThrow("grounding_ratio");
    expect(() => parseKnowledgeArtifact("---\nsha: compiled-sha\ngrounding_ratio: 1.1\n---\ntext")).toThrow("grounding_ratio");
  });
});

describe("checkKnowledgeDrift", () => {
  it("requests recompilation when current grounding falls more than five points below the artifact baseline", () => {
    const report = checkKnowledgeDrift(parseKnowledgeArtifact(artifact), index);

    expect(report).toMatchObject({
      artifactSha: "compiled-sha",
      currentSha: "current-sha",
      dirty: false,
      baseline: 0.923,
      current: 0,
      delta: 0.923,
      drifted: true,
      recompileRequired: true,
    });
    expect(report.grounding.claims).toEqual([
      { value: "src/old.ts", kind: "file", verdict: "not-found" },
      { value: "oldThing", kind: "symbol", verdict: "not-found" },
    ]);
  });
});
