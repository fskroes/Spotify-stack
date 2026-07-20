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
