/**
 * The app side of the runner's cosign contract (fleet cosign --json, PR #19).
 *
 * The wire shapes — CosignResult, CosignRefusal, the reason cap — and the
 * stdout-line extraction (parseCosignStdout) now live in @fleet/contract, the
 * one declaration of the runner→operator seam. What stays here is the operator
 * gate logic that reads those shapes: the merge blocker, the awaiting-review
 * derivation, and the close-reason check the dialog runs before an SSH round-trip.
 */
import { MAX_REASON_LENGTH } from "@fleet/contract";

export { MAX_REASON_LENGTH };
export type { CosignRefusal, CosignResult } from "@fleet/contract";

/** What the merge gate needs to know about a run — mirrors FleetRun's shape.
 *  `mode` and `cosignState` stay open strings: a newer runner may speak PR
 *  states or run modes this build has never heard of, and the gate degrades. */
export interface MergeGateInput {
  kind: "inflight" | "completed";
  mode?: string;
  status?: string;
  prUrl?: string;
  /** Live PR state from the serve's co-sign polling; undefined until it lands. */
  cosignState?: string;
}

/**
 * Why the merge button must not render for this run — null when the runner's
 * gate could plausibly accept the merge (approved, PR present and open per live
 * state). Mode-blind, exactly like the runner's gate (#36): a cloud run is
 * co-signable here too. The UI shows the returned reason in the button's place,
 * so it never offers a decision the gate would refuse. Evidence adjacency — the
 * hard "no synced diff, no button" invariant — is enforced separately at the
 * render site, since it depends on artifact state this pure gate can't see.
 */
export function mergeBlocker(run: MergeGateInput): string | null {
  if (run.kind === "inflight") return "Run is still in progress — only shipped runs can be co-signed.";
  if (run.status !== "approved") return `Run is ${run.status} — only approved runs can be merged.`;
  if (!run.prUrl) return "Run has no pull request — nothing to merge.";
  if (!run.cosignState) return "Waiting for live pull-request state from the runner.";
  if (run.cosignState === "merged") return "Pull request is already merged.";
  if (run.cosignState === "closed") return "Pull request was closed without merging.";
  return null;
}

/**
 * Whether this run is shipped and waiting on the operator's co-sign decision —
 * the queue's awaiting-review attention state. Defined as "the merge gate
 * would accept a decision right now", so the attention treatment and the merge
 * button judge a run identically (the decision block additionally requires a
 * live runner connection and synced evidence). Derived from live co-sign state
 * (#20), it appears only once the serve reports the PR open and leaves when the
 * PR merges or closes. Cloud runs qualify too (#36) — a synced cloud run needs
 * the operator's co-sign exactly as a local one does.
 */
export function awaitingReview(run: MergeGateInput): boolean {
  return run.kind === "completed" && mergeBlocker(run) === null;
}

/**
 * Why this close reason cannot be dispatched — null when the trimmed reason
 * satisfies the runner's contract (present, at most MAX_REASON_LENGTH chars).
 * The Rust boundary enforces the same rules; this copy exists so the dialog
 * can refuse before the invoke, with a message worth showing.
 */
export function closeReasonProblem(reason: string): string | null {
  const trimmed = reason.trim();
  if (trimmed.length === 0) return "A reason is required — it lands as the PR comment.";
  if (trimmed.length > MAX_REASON_LENGTH) {
    const over = trimmed.length - MAX_REASON_LENGTH;
    return `The reason is ${over} character${over === 1 ? "" : "s"} over the ${MAX_REASON_LENGTH}-character cap.`;
  }
  return null;
}
