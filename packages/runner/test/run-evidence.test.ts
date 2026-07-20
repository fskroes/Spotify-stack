import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { VERIFY_STATES } from "@fleet/contract";
import { runVerify } from "@fleet/mcp-verify";
import { evidenceFor } from "../src/run.js";

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
