import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildIndex, checkGrounding, compareGroundingBaseline } from "../src/index.js";
import type { RepoIndex } from "../src/index.js";

const demoRepos = fileURLToPath(new URL("../../../demo-repos/", import.meta.url));

const index: RepoIndex = {
  repo: "demo",
  sha: "0391daa",
  dirty: false,
  files: ["App/Services/FeedService.swift", "App/Views/FeedView.swift"],
  parsedFiles: [],
  symbols: [
    { name: "FeedService", kind: "class", file: "App/Services/FeedService.swift", line: 1, signature: "class FeedService" },
    { name: "FeedView", kind: "struct", file: "App/Views/FeedView.swift", line: 1, signature: "struct FeedView" },
    { name: "runCycle", kind: "function", file: "App/Services/FeedService.swift", line: 2, signature: "func runCycle()" },
  ],
  filesSkipped: [],
};

describe("checkGrounding", () => {
  it("reproduces the same ratio for the same prose and pinned index", () => {
    const prose = [
      "The sync loop lives in `App/Services/FeedService.swift`, driven by `FeedService.runCycle()`.",
      "It displays in `App/Views/GhostView.swift`.",
    ].join("\n");

    const first = checkGrounding(prose, index);
    const second = checkGrounding(prose, { ...index, sha: index.sha });

    expect(first).toEqual(second);
    expect(first.groundedRatio).toBeCloseTo(2 / 3);
    expect(first.claims).toEqual([
      { value: "App/Services/FeedService.swift", kind: "file", verdict: "verified" },
      { value: "App/Views/GhostView.swift", kind: "file", verdict: "not-found" },
      { value: "FeedService.runCycle()", kind: "symbol", verdict: "verified" },
    ]);
  });

  it("reproduces the ratio against a real target at the same pinned SHA", async () => {
    const repoDir = path.join(demoRepos, "demo-ts-service");
    const prose = "`src/userService.ts` exports `getUser`.";
    const firstIndex = await buildIndex(repoDir);
    const secondIndex = await buildIndex(repoDir);

    expect(firstIndex.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(secondIndex.sha).toBe(firstIndex.sha);
    expect(checkGrounding(prose, secondIndex).groundedRatio).toBe(checkGrounding(prose, firstIndex).groundedRatio);
  });

  it("excludes proposed files from the ratio", () => {
    const report = checkGrounding(
      "Touch `App/Views/FeedView.swift`. Add a new `App/Services/ArchiveService.swift`.",
      index,
    );

    expect(report).toMatchObject({ verified: 1, notFound: 0, proposed: 1, groundedRatio: 1 });
    expect(report.claims[1]).toMatchObject({ verdict: "proposed" });
  });

  it("keeps framework vocabulary in the baseline instead of treating it as drift", () => {
    const baseline = checkGrounding(
      "`FeedService` uses `URLSession` before displaying `App/Views/FeedView.swift`.",
      index,
    ).groundedRatio;
    const current = checkGrounding(
      "`FeedService` uses `URLSession` before displaying `App/Views/FeedView.swift`.",
      index,
    ).groundedRatio;

    expect(baseline).toBeCloseTo(2 / 3);
    expect(compareGroundingBaseline(current, baseline)).toMatchObject({ drifted: false, delta: 0 });
  });
});

describe("compareGroundingBaseline", () => {
  it("triggers only when the ratio falls more than 0.05 below its compile-time baseline", () => {
    expect(compareGroundingBaseline(0.873, 0.923)).toMatchObject({ drifted: false, delta: 0.05 });
    expect(compareGroundingBaseline(0.8729996, 0.923)).toMatchObject({ drifted: true, delta: 0.05 });
    expect(compareGroundingBaseline(0.872, 0.923)).toMatchObject({ drifted: true, delta: 0.051 });
  });
});
