/**
 * Unit tests for the run-time seam (#89, Stage 5): the pure renders that compose
 * the injected `.fleet-knowledge.md` body and the first-prompt preamble. No
 * filesystem, no agent — just the shape a dispatched run is handed.
 */
import { describe, expect, it } from "vitest";
import {
  buildRepoMapFromIndex,
  buildRunKnowledgeFile,
  buildRunPreamble,
  checkKnowledgeDrift,
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

/** A stored artifact that still fully resolves against the current index. */
const freshArtifact = () => ({ sha: index.sha, groundingRatio: 1, prose });

/** A stored artifact whose prose names something the current index no longer has. */
const driftedArtifact = () => ({ sha: "compiledsha0000", groundingRatio: 1, prose: "The old path is `src/old.ts` beside `oldThing`." });

describe("buildRunKnowledgeFile", () => {
  it("carries the rendered structural map and the compiled prose, titled by repo", () => {
    const map = buildRepoMapFromIndex(index);
    const file = buildRunKnowledgeFile(map, prose, checkKnowledgeDrift(freshArtifact(), index));

    expect(file).toContain("# Target knowledge — demo");
    expect(file).toContain("## Compiled prose");
    expect(file).toContain("`serve` from src/service.ts");
    expect(file).toContain("## Structural map");
    expect(file).toContain("function serve()");
  });

  it("stays banner-free when the prose is within baseline tolerance", () => {
    const file = buildRunKnowledgeFile(buildRepoMapFromIndex(index), prose, checkKnowledgeDrift(freshArtifact(), index));

    expect(file).not.toContain("STALE");
    expect(file).not.toMatch(/has drifted/);
  });

  it("leads with a STALE banner listing the ungrounded claims when the prose has drifted", () => {
    const drift = checkKnowledgeDrift(driftedArtifact(), index);
    expect(drift.recompileRequired).toBe(true);

    const file = buildRunKnowledgeFile(buildRepoMapFromIndex(index), driftedArtifact().prose, drift);

    // The banner is the first thing after the header, before the prose section.
    expect(file).toMatch(/STALE — the compiled prose has drifted/);
    expect(file.indexOf("STALE")).toBeLessThan(file.indexOf("## Compiled prose"));
    // Its stamped SHA is named so a reader can see how stale.
    expect(file).toContain("compiledsha0000");
    // And every claim a current map no longer confirms is enumerated.
    expect(file).toContain("- file: src/old.ts");
    expect(file).toContain("- symbol: oldThing");
  });
});

describe("buildRunPreamble", () => {
  it("names the injected path and its stamped commit", () => {
    const preamble = buildRunPreamble(".fleet-knowledge.md", "abc1234");

    expect(preamble).toContain("`.fleet-knowledge.md`");
    expect(preamble).toContain("abc1234");
    expect(preamble).toMatch(/read it first/);
  });

  it("encodes the artifact-vs-memory authority rule: file wins on code facts, memory owns episodic", () => {
    const preamble = buildRunPreamble(".fleet-knowledge.md", "abc1234");

    // The file is authoritative on code facts at its stamped commit...
    expect(preamble).toMatch(/authoritative on code facts/i);
    // ...memory owns episodic and preference knowledge...
    expect(preamble).toMatch(/episodic and preference/i);
    // ...and on conflict the file wins, said out loud rather than silently chosen.
    expect(preamble).toMatch(/file wins over memory/i);
    expect(preamble).toMatch(/say so explicitly/i);
  });

  it("adds a stale-claims note only when told the prose has drifted", () => {
    expect(buildRunPreamble(".fleet-knowledge.md", "abc1234", false)).not.toMatch(/STALE banner/);

    const stale = buildRunPreamble(".fleet-knowledge.md", "abc1234", true);
    expect(stale).toMatch(/STALE banner/);
    expect(stale).toMatch(/confirm them in the code/i);
  });
});
