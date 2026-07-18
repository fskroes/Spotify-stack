import { describe, expect, it } from "vitest";
import { checkGrounding } from "../src/grounding.js";
import type { RepoIndex } from "../src/types.js";

const index: RepoIndex = {
  sha: "0391daa",
  files: new Set(["App/Services/FeedService.swift", "App/Views/FeedView.swift"]),
  symbols: new Set(["FeedService", "FeedView", "runCycle"]),
};

describe("checkGrounding", () => {
  it("verifies file paths and symbols that exist at the pinned SHA", () => {
    const report = checkGrounding(
      "The sync loop lives in `App/Services/FeedService.swift`, driven by `runCycle`.",
      index,
    );

    expect(report.claims.map((c) => c.verdict)).toEqual(["verified", "verified"]);
    expect(report.groundedRatio).toBe(1);
  });

  it("flags a file that does not exist as not-found", () => {
    const report = checkGrounding("Look at `App/Services/GhostService.swift`.", index);

    expect(report.claims).toHaveLength(1);
    expect(report.claims[0]).toMatchObject({
      value: "App/Services/GhostService.swift",
      kind: "file",
      verdict: "not-found",
    });
    expect(report.groundedRatio).toBe(0);
  });

  it("classifies a file the answer proposes creating as proposed, not not-found", () => {
    const report = checkGrounding(
      "Create a new file `App/Services/ArchiveService.swift` holding the rule.",
      index,
    );

    expect(report.claims[0].verdict).toBe("proposed");
    expect(report.proposed).toBe(1);
  });

  it("excludes proposed claims from the grounded ratio", () => {
    const report = checkGrounding(
      [
        "Touch `App/Views/FeedView.swift` for the list.",
        "Add a new `App/Services/ArchiveService.swift`.",
      ].join("\n"),
      index,
    );

    expect(report.verified).toBe(1);
    expect(report.notFound).toBe(0);
    expect(report.proposed).toBe(1);
    expect(report.groundedRatio).toBe(1);
  });

  it("counts an unbacktick'd path mentioned in prose", () => {
    const report = checkGrounding("It is wired in App/Views/FeedView.swift today.", index);

    expect(report.claims[0]).toMatchObject({ kind: "file", verdict: "verified" });
  });

  it("ignores prose words and only checks code-shaped symbol claims", () => {
    const report = checkGrounding("The service handles the sync loop for the inbox.", index);

    expect(report.claims).toEqual([]);
    expect(report.groundedRatio).toBe(1);
  });

  it("deduplicates repeated claims", () => {
    const report = checkGrounding("`FeedService` calls `FeedService` again.", index);

    expect(report.claims).toHaveLength(1);
  });

  it("resolves a symbol written with member access against its owning type", () => {
    const report = checkGrounding("Call `FeedService.runCycle()` on wake.", index);

    expect(report.claims[0].verdict).toBe("verified");
  });
});
