import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { VERIFY_STATES } from "@fleet/contract";
import { runVerify } from "@fleet/mcp-verify";
import { composedVerifyState, evidenceFor, findUnmetGates } from "../src/run.js";
import type { VerifyCheck } from "../src/pr.js";

/** Checks as verification reports them — only `name` and `status` decide a
 *  mandate, so the rest is filler. */
const check = (name: string, status: VerifyCheck["status"]): VerifyCheck => ({
  name,
  label: `npm run ${name}`,
  status,
  summary: "",
  durationMs: status === "skipped" ? 0 : 100,
});

/** The ledger evidence line for an approved run — the surface every reader of
 *  the committed ledger sees first. Its headline must follow the verify state,
 *  not the run status: `approved` says the change shipped, not that it was
 *  verified. */
describe("evidenceFor — approved runs", () => {
  const approved = (state: "passed" | "inconclusive", summary: string) =>
    evidenceFor({
      status: "approved",
      resultText: "",
      verify: { state, checks: [], summary },
    });

  it("claims all green only when verification actually passed", () => {
    const lines = approved("passed", "VERIFY PASSED\n✔ npm run test passed (3.2s)");
    expect(lines?.[0]).toBe("✓ scope · verify · judge all green");
  });

  it("does not claim green when no verifier ran", () => {
    const lines = approved("inconclusive", "VERIFY INCONCLUSIVE — no verifiers detected for this repository");
    expect(lines?.[0]).not.toContain("all green");
    expect(lines?.[0]).toContain("INCONCLUSIVE");
    // The state decides the headline; the summary prose is only carried along.
    expect(lines?.[1]).toContain("no verifiers detected");
  });
});

/** The comparison a task's `gates:` mandate gets: which demanded checks nothing
 *  satisfied. Tested directly rather than through a run, because the case
 *  density is table-shaped and none of it should cost a hermetic workspace. */
describe("findUnmetGates", () => {
  const ran = [check("test", "passed"), check("eslint", "passed")];

  it("reports nothing when a task declares no gates", () => {
    expect(findUnmetGates(undefined, ran)).toEqual([]);
    expect(findUnmetGates([], ran)).toEqual([]);
  });

  it("reports nothing when every mandated gate executed", () => {
    expect(findUnmetGates(["test", "eslint"], ran)).toEqual([]);
  });

  it("reports the gates no check satisfied, in the order the task named them", () => {
    expect(findUnmetGates(["contract-check", "test", "smoke"], ran)).toEqual(["contract-check", "smoke"]);
  });

  it("counts a failed check as having run — a red gate is a failure, not an absence", () => {
    expect(findUnmetGates(["eslint"], [check("eslint", "failed")])).toEqual([]);
  });

  it("does not let a skipped check meet a mandate", () => {
    // Detected, then never reached because an earlier check failed. That is
    // exactly the "did not run" the tri-state exists to name.
    const checks = [check("eslint", "failed"), check("test", "skipped")];
    expect(findUnmetGates(["test"], checks)).toEqual(["test"]);
  });

  it("treats a gate no verifier could ever produce as unmet, not as an error", () => {
    // An open vocabulary: a typo and a deliberately unrunnable mandate are
    // indistinguishable here, and both are loud rather than a false green.
    expect(findUnmetGates(["xcodebuild-test", "tset"], ran)).toEqual(["xcodebuild-test", "tset"]);
  });
});

/** What the run *records*, which is not what verification returned: the runner
 *  folds the task's mandate into the state every surface then reads. */
describe("composedVerifyState", () => {
  const passed = { state: "passed" as const, checks: [check("test", "passed")], summary: "" };

  it("is undefined when the run died before verify — nothing known is not green", () => {
    expect(composedVerifyState({ verify: undefined, unmetGates: [] })).toBeUndefined();
  });

  it("passes only when verification passed and nothing was left outstanding", () => {
    expect(composedVerifyState({ verify: passed, unmetGates: [] })).toBe("passed");
    expect(composedVerifyState({ verify: passed, unmetGates: undefined })).toBe("passed");
  });

  it("downgrades a green verification to inconclusive when a mandated gate never ran", () => {
    expect(composedVerifyState({ verify: passed, unmetGates: ["contract-check"] })).toBe("inconclusive");
  });

  it("keeps an already-inconclusive verification inconclusive", () => {
    const nothing = { state: "inconclusive" as const, checks: [], summary: "" };
    expect(composedVerifyState({ verify: nothing, unmetGates: ["test"] })).toBe("inconclusive");
    expect(composedVerifyState({ verify: nothing, unmetGates: [] })).toBe("inconclusive");
  });

  it("lets a red check outrank an unmet mandate — this adds no new way to report a failure", () => {
    const failed = { state: "failed" as const, checks: [check("eslint", "failed")], summary: "" };
    expect(composedVerifyState({ verify: failed, unmetGates: ["test"] })).toBe("failed");
  });
});

/** The ledger evidence line, once a mandate is in play. */
describe("evidenceFor — unmet gates", () => {
  it("names the gate that never ran instead of claiming green", () => {
    const lines = evidenceFor({
      status: "approved",
      resultText: "",
      verify: { state: "passed", checks: [check("test", "passed")], summary: "VERIFY PASSED" },
      unmetGates: ["contract-check"],
    });

    expect(lines?.[0]).not.toContain("all green");
    expect(lines?.[0]).toContain("INCONCLUSIVE");
    // Named, not merely counted: which gate is missing is what a reader judges.
    expect(lines?.[0]).toContain("contract-check");
    // And not the other cause of inconclusive — verifiers did run here.
    expect(lines?.[0]).not.toContain("no verifiers ran");
  });
});

/** @fleet/mcp-verify is dependency-free plain JS, so its VerifyState typedef is
 *  a hand-copy of the contract's VERIFY_STATES rather than an import — and
 *  run.ts bridges the two with an unchecked `as VerifyResult` cast. The runner
 *  is where the two vocabularies meet, so this is where the drift is caught. */
describe("verify vocabulary, across the package boundary", () => {
  it("only ever speaks states the wire contract knows", async () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), "verify-vocab-"));
    expect(VERIFY_STATES).toContain((await runVerify(empty)).state);
  });
});
