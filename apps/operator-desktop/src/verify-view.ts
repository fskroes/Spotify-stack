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

/** What this run's verification proved, for a completed run's ledger line.
 *
 *  An inconclusive run names its unmet gates when it has them: the co-signer's
 *  question is not "was this proven" but "is the *missing* check one I care
 *  about for this change", and only the names answer that. A run that declared
 *  no gates, and one whose gates were all met, both carry none and read exactly
 *  as they did before — the affordance appears only when something is
 *  outstanding. */
export function verifyReadout(entry: Pick<LedgerEntry, "verifyState" | "unmetGates">): VerifyReadout {
  const readout = READOUTS[knownVerifyState(entry.verifyState) ?? "unknown"];
  const unmet = entry.unmetGates ?? [];
  if (readout.tone !== "warn" || unmet.length === 0) return readout;
  return {
    value: unmet.length === 1 ? `${unmet[0]} never ran` : `${unmet.length} gates never ran`,
    tone: "warn",
    phrase: `verify inconclusive — ${unmet.join(", ")} never ran`,
  };
}

/**
 * What the merge-confirm dialog says it is about to merge — the last sentence a
 * co-signer reads before the branch is squashed into their default branch.
 *
 * Extracted here, and pure, because it was a string literal reading `verify
 * green, judge approved` for every run regardless of what verification did (#66).
 * The dialog is the surface with the least excuse for that: the other three all
 * read the recorded state, so the one asking for the signature was the only one
 * still asserting a pass it had not checked.
 *
 * The judge half stays a constant on purpose, and is not the same sin: a run
 * only carries a `prUrl` if it was approved — the runner opens a pull request on
 * no other path — and the dialog opens only for a run that has one. That is a
 * precondition of the surface, not an inference from prose.
 */
export function mergeStakesClaim(entry: Pick<LedgerEntry, "verifyState" | "unmetGates">): string {
  return `${verifyReadout(entry).phrase}, judge approved`;
}
