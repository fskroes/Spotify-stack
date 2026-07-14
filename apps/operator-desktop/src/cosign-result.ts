/**
 * The app side of the runner's cosign contract (fleet cosign --json, PR #19).
 *
 * The runner prints one structured JSON result line, but the channel around it
 * is noisy: pnpm's script banner precedes it and lifecycle errors can trail it
 * — the judge CLI has already been broken once by hook-leaked stdout. So the
 * contract here is "the last line that parses as a cosign result", scanned
 * from the end, never "the last line".
 */

export type CosignRefusalCode =
  | "run-not-found"
  | "not-shipped"
  | "no-pr"
  | "already-merged"
  | "already-closed"
  | "conflicts"
  | "not-mergeable"
  | "merge-failed"
  | "close-failed";

export interface CosignRefusal {
  code: CosignRefusalCode;
  detail: string;
}

export interface CosignResult {
  ok: boolean;
  action: "merge" | "close";
  runId: string;
  task?: string;
  repo?: string;
  prUrl?: string;
  state?: "merged" | "closed";
  mergedSha?: string;
  mergedBy?: string;
  mergedAt?: string;
  refusals: CosignRefusal[];
}

function isCosignResult(value: unknown): value is CosignResult {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result.ok === "boolean" &&
    (result.action === "merge" || result.action === "close") &&
    typeof result.runId === "string" &&
    Array.isArray(result.refusals)
  );
}

/** What the merge gate needs to know about a run — mirrors FleetRun's shape. */
export interface MergeGateInput {
  kind: "inflight" | "completed";
  mode?: "local" | "cloud";
  status?: string;
  prUrl?: string;
  /** Live PR state from the serve's co-sign polling; undefined until it lands. */
  cosignState?: "open" | "merged" | "closed";
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

/** Mirrors the CLI's --reason cap — a reason accepted by the form is never
 *  rejected after the fact by the runner. */
export const MAX_REASON_LENGTH = 500;

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

/** The last line of `output` that parses as a cosign result, or null. */
export function parseCosignResult(output: string): CosignResult | null {
  const lines = output.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isCosignResult(parsed)) return parsed;
    } catch {
      /* not the result line — keep scanning */
    }
  }
  return null;
}
