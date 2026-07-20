import { describe, expect, it } from "vitest";
import { mergeStakesClaim, verifyReadout } from "../src/verify-view";

describe("verifyReadout", () => {
  it("calls verification green only when it passed", () => {
    expect(verifyReadout({ verifyState: "passed" })).toEqual({
      value: "Green",
      tone: "ok",
      phrase: "verify green",
    });
  });

  it("says nothing ran — in its own tone — when verification was inconclusive", () => {
    const readout = verifyReadout({ verifyState: "inconclusive" });
    expect(readout.tone).toBe("warn");
    expect(readout.value).toBe("Nothing ran");
    expect(readout.phrase).toContain("no verifiers ran");
  });

  it("names the gate the task demanded when one went unmet", () => {
    const readout = verifyReadout({ verifyState: "inconclusive", unmetGates: ["live-contract-check"] });
    expect(readout.tone).toBe("warn");
    expect(readout.value).toContain("live-contract-check");
    // Not the other cause of inconclusive — verifiers ran, just not that one.
    expect(readout.phrase).not.toContain("no verifiers ran");
    expect(readout.phrase).toContain("live-contract-check");
  });

  it("shows no gate affordance for a run that left nothing outstanding", () => {
    // Declared none, and declared-and-all-met, are deliberately the same here.
    for (const entry of [{ verifyState: "passed" }, { verifyState: "passed", unmetGates: [] }]) {
      expect(verifyReadout(entry).value).toBe("Green");
    }
    // And an inconclusive line with no gate field recorded reads as before.
    expect(verifyReadout({ verifyState: "inconclusive" }).value).toBe("Nothing ran");
  });

  it("admits it does not know, rather than assuming a pass", () => {
    // A ledger line written before the tri-state existed, and a state only a
    // newer runner speaks. Neither may render as green.
    for (const entry of [{}, { verifyState: "quarantined" }]) {
      const readout = verifyReadout(entry);
      expect(readout.value).toBe("Not recorded");
      expect(readout.tone).toBe("neutral");
    }
  });
});

/** The merge-confirm dialog's sentence — the last thing read before a branch is
 *  squashed into the default branch, and until #66 a string literal claiming
 *  every run was verified green. */
describe("mergeStakesClaim", () => {
  it("claims green only for a run that actually verified green", () => {
    expect(mergeStakesClaim({ verifyState: "passed" })).toBe("verify green, judge approved");
  });

  it("does not claim green when a mandated gate never ran", () => {
    const claim = mergeStakesClaim({ verifyState: "inconclusive", unmetGates: ["xcodebuild-test"] });
    expect(claim).not.toContain("verify green");
    // Named here too: the co-signer's last chance to notice is this sentence.
    expect(claim).toContain("xcodebuild-test");
    expect(claim).toContain("judge approved");
  });

  it("does not claim green when nothing ran at all", () => {
    expect(mergeStakesClaim({ verifyState: "inconclusive" })).not.toContain("verify green");
  });

  it("does not claim green for a line written before the state was recorded", () => {
    // The dialog is the worst possible place to assume a pass on a run that
    // never said what it proved.
    expect(mergeStakesClaim({})).not.toContain("verify green");
    expect(mergeStakesClaim({})).toContain("not recorded");
  });
});
