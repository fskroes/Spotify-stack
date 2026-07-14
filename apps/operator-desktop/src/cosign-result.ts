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
  | "cloud-run"
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
 * gate could plausibly accept the merge (local, approved, PR present and open
 * per live state). The UI shows the returned reason in the button's place, so
 * it never offers a decision the gate would refuse.
 */
export function mergeBlocker(run: MergeGateInput): string | null {
  if (run.kind === "inflight") return "Run is still in progress — only shipped runs can be co-signed.";
  if (run.mode === "cloud") return "Cloud run — review and merge on GitHub.";
  if (run.status !== "approved") return `Run is ${run.status} — only approved runs can be merged.`;
  if (!run.prUrl) return "Run has no pull request — nothing to merge.";
  if (!run.cosignState) return "Waiting for live pull-request state from the runner.";
  if (run.cosignState === "merged") return "Pull request is already merged.";
  if (run.cosignState === "closed") return "Pull request was closed without merging.";
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
