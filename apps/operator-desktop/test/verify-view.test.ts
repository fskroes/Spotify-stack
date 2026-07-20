import { describe, expect, it } from "vitest";
import { verifyReadout } from "../src/verify-view";

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
