/**
 * How the Run view says what verification proved — the operator's half of the
 * verification tri-state (#62).
 *
 * Pure, so the honesty rule is testable without a DOM: the state is read from
 * the ledger line's `verifyState` field and never inferred by string-matching
 * the evidence prose. Three inputs map to four renderings, because "the field
 * is absent" is its own answer: a line written before the tri-state existed
 * knows nothing about what ran, and nothing-known is not green.
 */
import { knownVerifyState, type LedgerEntry } from "@fleet/contract";

/** Tone vocabulary shared with the gate band's readout pills. */
export type VerifyTone = "ok" | "bad" | "warn" | "neutral";

export interface VerifyReadout {
  /** The pill's value text. */
  value: string;
  tone: VerifyTone;
  /** The same fact as a clause for the spotlight's detail sentence. */
  phrase: string;
}

const READOUTS: Record<"passed" | "failed" | "inconclusive" | "unknown", VerifyReadout> = {
  passed: { value: "Green", tone: "ok", phrase: "verify green" },
  failed: { value: "Red", tone: "bad", phrase: "verify red" },
  // The point of the tri-state: a repo with no verifiers is legitimate, and
  // saying so plainly is the whole fix. Amber, not green, and never silent.
  inconclusive: { value: "Nothing ran", tone: "warn", phrase: "verify inconclusive — no verifiers ran" },
  // Pre-tri-state ledger lines. Honest about the gap rather than assuming a pass.
  unknown: { value: "Not recorded", tone: "neutral", phrase: "verify not recorded" },
};

/** What this run's verification proved, for a completed run's ledger line. */
export function verifyReadout(entry: Pick<LedgerEntry, "verifyState">): VerifyReadout {
  return READOUTS[knownVerifyState(entry.verifyState) ?? "unknown"];
}
