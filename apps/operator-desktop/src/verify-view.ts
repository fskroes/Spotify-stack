/**
 * How the operator says what verification proved — its half of the verification
 * tri-state (#62): the Run view's readouts, and the face the co-sign block and
 * its confirm dialog present when asking for a signature (#59).
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

/** Why this run is not proven, as a clause completing "PR #12 is open, but …".
 *
 *  Keyed like `READOUTS`, and deliberately a second table rather than a field on
 *  it: the readout states a fact for a pill, this states a *consequence* for
 *  someone about to sign. `passed` has no entry because a proven run is never
 *  asked for one. */
const CAUTIONS: Record<"failed" | "inconclusive" | "unknown", string> = {
  failed: "verification came back red",
  // Deliberately hedged. `inconclusive` arrives by two roads (CONTEXT.md,
  // "Verification state"), and an absent `unmetGates` means *not recorded* —
  // never an assertion that nothing was outstanding. So this clause may not say
  // "no verifiers ran": that is one road named as though it were both.
  inconclusive: "verification was inconclusive — nothing here proves the change",
  unknown: "this run did not record what verification proved",
};

/** Why this run is not proven, as a clause. Shared so the co-sign block and the
 *  outcome card cannot drift into describing the same run two ways. */
function unprovenCause(
  state: "failed" | "inconclusive" | "unknown",
  unmet: readonly string[],
): string {
  // A named gate beats the generic clause: "nothing was proven" and "the one
  // check you cared about never ran" are different questions for the signer.
  return state === "inconclusive" && unmet.length > 0
    ? `the task mandated ${unmet.join(", ")}, which never ran`
    : CAUTIONS[state];
}

/**
 * The outcome card's detail for an approved run that is not at the co-sign gate
 * — no live pull-request state yet, or none to fetch.
 *
 * The seventh overstating surface this map has turned up, and it was a literal:
 * `Every gate passed.`, rendered for every approved run including one whose
 * verification proved nothing. Found by running the app and reading the card,
 * which is how the fifth and sixth were found too.
 */
export function outcomeDetail(entry: Pick<LedgerEntry, "verifyState" | "unmetGates">): string {
  const state = knownVerifyState(entry.verifyState) ?? "unknown";
  if (state === "passed") return "Every gate passed.";
  return `Approved, but ${unprovenCause(state, entry.unmetGates ?? [])}.`;
}

export interface CosignAffordance {
  /** Whether this surface may imply the change was proven green. Not a restating
   *  of `VerifyState`: `failed` is *proven bad* rather than unproven, but it may
   *  no more wear the plain button than an inconclusive run may. */
  stance: "proven" | "unproven";
  /** The decision card's detail sentence, sitting above the buttons. */
  detail: string;
  /** The rail button's label — the one that opens the confirm dialog. */
  mergeLabel: string;
  /** The dialog's submit label — the button that actually signs. Carries the
   *  same warning without the PR number, which the dialog states already. */
  confirmLabel: string;
  /** Shared lucide icon name — registered in `main.ts`'s icon set. */
  mergeIcon: string;
}

/**
 * How the co-sign block presents a run the gate would accept — the card's
 * sentence and the merge button's face (#59 item 1).
 *
 * The map's last open question was whether an unproven run should be co-signable
 * at all. It is: #61 ruled an unmet mandate non-blocking, so withholding the
 * button would make declaring a gate dangerous and the field would die of
 * disuse. The answer taken instead is that the button *carries* the warning —
 * which is why this returns a label and an icon and has no way to express "no
 * button". The gate that can actually refuse is `mergeBlocker`, and it stays
 * verify-blind on purpose.
 *
 * Both merge buttons read this, and that is the point. The rail button only
 * *opens* the confirm dialog; the dialog's submit is what signs. Warning the
 * first and not the second would leave the actual signature protected by prose
 * alone — the exact state this item rejected.
 *
 * Fixing the card's header sentence came with it, and was the sixth overstating
 * surface this map has turned up: it was the literal `is open with every gate
 * green`, rendered for any run the gate accepted, directly above the button it
 * describes. Same defect as #66's dialog, one line up.
 */
export function cosignAffordance(
  entry: Pick<LedgerEntry, "verifyState" | "unmetGates">,
  opts: { prNumber: string; retry: boolean },
): CosignAffordance {
  const state = knownVerifyState(entry.verifyState) ?? "unknown";
  const verb = opts.retry ? "Retry squash-merge" : "Squash-merge";

  if (state === "passed") {
    return {
      stance: "proven",
      detail: `PR #${opts.prNumber} is open with every gate green. Squash-merge, or close it with a reason.`,
      mergeLabel: `${verb} PR #${opts.prNumber}`,
      confirmLabel: verb,
      mergeIcon: "git-merge",
    };
  }

  const cause = unprovenCause(state, entry.unmetGates ?? []);
  // A red verify is proven bad, not unproven — the warning is warranted either
  // way, but the word has to match the sentence above it. (Structurally
  // unreachable today: the runner opens no pull request on a red verify.)
  const warning = state === "failed" ? "verify red" : "unproven";

  return {
    stance: "unproven",
    detail: `PR #${opts.prNumber} is open, but ${cause}. You can still co-sign — squash-merge, or close it with a reason.`,
    mergeLabel: `${verb} PR #${opts.prNumber} — ${warning}`,
    confirmLabel: `${verb} — ${warning}`,
    mergeIcon: "alert-circle",
  };
}
