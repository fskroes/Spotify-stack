import { describe, expect, it } from "vitest";
import {
  buildAskPrompt,
  buildRepoMapFromIndex,
  checkKnowledgeDrift,
  formatAnswerGrounding,
  type GroundingReport,
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

const prose = "The product exposes `serve` from src/service.ts.";

/** A stored artifact whose prose names something the current index no longer has. */
function driftedArtifact() {
  return { sha: "compiledsha0000", groundingRatio: 1, prose: "The old path is `src/old.ts` beside `oldThing`." };
}

/** A stored artifact that still fully resolves against the current index. */
function freshArtifact() {
  return { sha: index.sha, groundingRatio: 1, prose };
}

describe("buildAskPrompt", () => {
  it("injects the question, the compiled prose, and the freshly rendered map", () => {
    const map = buildRepoMapFromIndex(index);
    const prompt = buildAskPrompt(map, prose, "where would 'mute this thread' land?", checkKnowledgeDrift(freshArtifact(), index));

    expect(prompt).toContain("## Question");
    expect(prompt).toContain("where would 'mute this thread' land?");
    expect(prompt).toContain("## Compiled prose");
    expect(prompt).toContain("`serve` from src/service.ts");
    expect(prompt).toContain("## Structural map");
    expect(prompt).toContain("function serve()");
  });

  it("names the three #52 classes so a story is answered as a dispatch-ready brief", () => {
    const prompt = buildAskPrompt(buildRepoMapFromIndex(index), prose, "add mute", checkKnowledgeDrift(freshArtifact(), index));

    expect(prompt).toMatch(/Placement/);
    expect(prompt).toMatch(/Wiring/);
    expect(prompt).toMatch(/dispatch-ready brief/);
    expect(prompt).toMatch(/verify gate/i);
  });

  it("stays clean when the prose is within baseline tolerance", () => {
    const prompt = buildAskPrompt(buildRepoMapFromIndex(index), prose, "add mute", checkKnowledgeDrift(freshArtifact(), index));
    expect(prompt).not.toMatch(/has drifted/);
    expect(prompt).not.toMatch(/unverified at the current SHA/);
  });

  it("still answers when the prose has drifted, naming the stale claims as unverified", () => {
    const drift = checkKnowledgeDrift(driftedArtifact(), index);
    expect(drift.recompileRequired).toBe(true);

    const prompt = buildAskPrompt(buildRepoMapFromIndex(index), driftedArtifact().prose, "where does mute land?", drift);

    // The question is still asked — drift never blocks the human path.
    expect(prompt).toContain("## Question");
    expect(prompt).toContain("where does mute land?");
    // ...and the drifted claims are flagged for the model to hedge.
    expect(prompt).toMatch(/has drifted/);
    expect(prompt).toMatch(/Treat them as unverified at the current SHA/);
    expect(prompt).toContain("- file: src/old.ts");
    expect(prompt).toContain("- symbol: oldThing");
  });
});

describe("formatAnswerGrounding", () => {
  const report = (claims: GroundingReport["claims"]): GroundingReport => {
    const verified = claims.filter((c) => c.verdict === "verified").length;
    const notFound = claims.filter((c) => c.verdict === "not-found").length;
    const checked = verified + notFound;
    return { claims, verified, notFound, proposed: claims.length - checked, checked, groundedRatio: checked === 0 ? 1 : verified / checked };
  };

  it("lists every ungrounded reference under the dead-end count and ratio", () => {
    const formatted = formatAnswerGrounding(
      report([
        { value: "src/service.ts", kind: "file", verdict: "verified" },
        { value: "src/ghost.ts", kind: "file", verdict: "not-found" },
        { value: "phantom", kind: "symbol", verdict: "not-found" },
      ]),
    );

    expect(formatted).toContain("dead-ends: 2 ungrounded references");
    expect(formatted).toContain("(grounded ratio 0.333, 1/3 resolved)");
    expect(formatted).toContain("- file: src/ghost.ts");
    expect(formatted).toContain("- symbol: phantom");
  });

  it("reports zero dead-ends without a list when every reference resolves", () => {
    const formatted = formatAnswerGrounding(report([{ value: "src/service.ts", kind: "file", verdict: "verified" }]));

    expect(formatted).toBe("dead-ends: 0 ungrounded references (grounded ratio 1.000, 1/1 resolved)");
    expect(formatted).not.toContain("\n");
  });
});
