import { describe, expect, it } from "vitest";
import { cosignAffordance, mergeStakesClaim, outcomeDetail, verifyReadout } from "../src/verify-view";

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

/** The co-sign block itself — the card header's sentence and the merge button's
 *  label. Until #59's item 1 the header was a literal reading `is open with
 *  every gate green` for *any* run the gate would accept, and the button read
 *  the same for a proven run and an unproven one. */
describe("cosignAffordance", () => {
  const opts = { prNumber: "12", retry: false };

  it("calls every gate green only when verification actually passed", () => {
    const a = cosignAffordance({ verifyState: "passed" }, opts);
    expect(a.stance).toBe("proven");
    expect(a.detail).toContain("every gate green");
    expect(a.mergeLabel).toBe("Squash-merge PR #12");
    expect(a.mergeIcon).toBe("git-merge");
  });

  it("does not claim every gate is green when a mandated gate never ran", () => {
    const a = cosignAffordance({ verifyState: "inconclusive", unmetGates: ["xcodebuild-test"] }, opts);
    expect(a.stance).toBe("unproven");
    expect(a.detail).not.toContain("every gate green");
    // The co-signer's question is which check is missing, so name it here too.
    expect(a.detail).toContain("xcodebuild-test");
  });

  it("names every unmet gate, not just the first", () => {
    const a = cosignAffordance(
      { verifyState: "inconclusive", unmetGates: ["xcodebuild-test", "live-contract-check"] },
      opts,
    );
    expect(a.detail).toContain("xcodebuild-test");
    expect(a.detail).toContain("live-contract-check");
  });

  it("does not claim every gate is green when verification was inconclusive", () => {
    const a = cosignAffordance({ verifyState: "inconclusive" }, opts);
    expect(a.stance).toBe("unproven");
    expect(a.detail).not.toContain("every gate green");
    expect(a.detail).toContain("inconclusive");
  });

  it("does not pick one road when an inconclusive line records no gates", () => {
    // `inconclusive` arrives by two roads, and an absent `unmetGates` means
    // *not recorded* — never an assertion that nothing was outstanding. So the
    // sentence may not say "no verifiers ran": that names one road as both.
    expect(cosignAffordance({ verifyState: "inconclusive" }, opts).detail)
      .not.toContain("no verifiers ran");
  });

  it("does not claim every gate is green for a line written before the state was recorded", () => {
    const a = cosignAffordance({}, opts);
    expect(a.stance).toBe("unproven");
    expect(a.detail).not.toContain("every gate green");
  });

  it("carries the warning on the button itself, not only in the card's prose", () => {
    // The decision of #59 item 1: the lever is the button. A co-signer who
    // reads nothing but the thing they are about to press still learns that
    // this run was never proven.
    for (const entry of [
      { verifyState: "inconclusive" },
      { verifyState: "inconclusive", unmetGates: ["xcodebuild-test"] },
      {},
    ]) {
      const a = cosignAffordance(entry, opts);
      expect(a.mergeLabel).toContain("unproven");
      expect(a.mergeIcon).toBe("alert-circle");
    }
  });

  it("warns on the dialog's submit too — that is the button that signs", () => {
    // The rail button only opens the dialog. Warning it and not the submit
    // would leave the signature itself guarded by prose alone.
    const unproven = cosignAffordance({ verifyState: "inconclusive", unmetGates: ["xcodebuild-test"] }, opts);
    expect(unproven.confirmLabel).toContain("Squash-merge");
    expect(unproven.confirmLabel).toContain("unproven");
    // …and stays plain for a run that earned it.
    expect(cosignAffordance({ verifyState: "passed" }, opts).confirmLabel).toBe("Squash-merge");
  });

  it("calls a red verify red, rather than merely unproven", () => {
    // Proven bad is not the same as unproven, and the button's word has to
    // match the sentence above it.
    const a = cosignAffordance({ verifyState: "failed" }, opts);
    expect(a.detail).toContain("red");
    expect(a.mergeLabel).toContain("verify red");
    expect(a.mergeLabel).not.toContain("unproven");
    // Still warned, still not green.
    expect(a.mergeIcon).toBe("alert-circle");
    expect(a.detail).not.toContain("every gate green");
  });

  it("still offers the merge — unproven is signable, not blocked", () => {
    // #61 ruled an unmet mandate non-blocking, so this surface must never
    // withhold the button. The affordance has no way to express "no button":
    // it always returns a label, and the gate that *can* block is mergeBlocker.
    const a = cosignAffordance({ verifyState: "inconclusive", unmetGates: ["xcodebuild-test"] }, opts);
    expect(a.mergeLabel).toContain("Squash-merge PR #12");
    expect(a.detail).toContain("still");
  });

  it("keeps the retry wording in both stances", () => {
    for (const entry of [{ verifyState: "passed" }, { verifyState: "inconclusive" }]) {
      expect(cosignAffordance(entry, { prNumber: "12", retry: true }).mergeLabel)
        .toContain("Retry squash-merge PR #12");
    }
  });
});

/** The outcome card's detail — an approved run not (yet) at the co-sign gate.
 *  Was a literal "Every gate passed." for every approved run, including one whose
 *  verification proved nothing (#59, found by running the app). */
describe("outcomeDetail", () => {
  it("says every gate passed only when every gate passed", () => {
    expect(outcomeDetail({ verifyState: "passed" })).toBe("Every gate passed.");
  });

  it("does not claim a pass an inconclusive run never earned", () => {
    const detail = outcomeDetail({ verifyState: "inconclusive" });
    expect(detail).not.toContain("Every gate passed");
    expect(detail).toContain("inconclusive");
  });

  it("names the mandated gate that never ran", () => {
    expect(outcomeDetail({ verifyState: "inconclusive", unmetGates: ["xcodebuild-test"] }))
      .toContain("xcodebuild-test");
  });

  it("does not claim a pass for a line written before the state was recorded", () => {
    expect(outcomeDetail({})).not.toContain("Every gate passed");
  });
});
