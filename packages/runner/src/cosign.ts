/**
 * The co-sign gate — the human decision on a shipped run, executed on the
 * runner (`fleet cosign <runId> --merge | --close`).
 *
 * Merging is the one irreversible write in the fleet, so the gate lives here
 * at the trust boundary, not in any UI: a PR merges only when the ledger says
 * the run shipped (verify green + judge approved, i.e. status "approved") and
 * GitHub says it is mergeable. There is deliberately no --force — a refusal is
 * the product working, and every refusal names its reason in a structured way
 * so operator surfaces can render it verbatim.
 *
 * Kept pure over an injected `gh` runner so every gate path is testable
 * without GitHub.
 */
import {
  MAX_REASON_LENGTH,
  type CosignAction,
  type CosignRefusal,
  type CosignResult,
  type KnownCosignRefusalCode,
  type LedgerEntry,
} from "@fleet/contract";

/** Runs `gh` with the given args and returns stdout; throws on failure. */
export type GhRunner = (args: string[]) => string;

export interface CosignInput {
  entries: LedgerEntry[];
  runId: string;
  action: CosignAction;
  /** Required for close; lands as a PR comment. */
  reason?: string;
  gh: GhRunner;
}

interface PrView {
  state: string;
  mergeable: string;
  mergeStateStatus: string;
}

/** mergeStateStatus values that mean "GitHub will not take this merge cleanly". */
const BAD_MERGE_STATES: Record<string, string> = {
  DIRTY: "merge conflicts with the base branch",
  BLOCKED: "blocked by required checks or reviews",
  BEHIND: "branch is behind the base and must be updated",
  UNSTABLE: "commit checks are failing",
  DRAFT: "the PR is still a draft",
};

/** The writer stays strict: only codes the contract knows may be emitted here,
 *  even though the wire type is an open string for tolerant readers. */
function refuse(
  base: Omit<CosignResult, "ok" | "refusals">,
  refusal: CosignRefusal & { code: KnownCosignRefusalCode },
): CosignResult {
  return { ...base, ok: false, refusals: [refusal] };
}

/** The latest ledger line for a run wins, matching how live views dedupe. */
export function findRun(entries: LedgerEntry[], runId: string): LedgerEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].runId === runId) return entries[i];
  }
  return undefined;
}

export function cosign(input: CosignInput): CosignResult {
  const { entries, runId, action, gh } = input;
  const base: Omit<CosignResult, "ok" | "refusals"> = { action, runId };

  if (action === "close") {
    const reason = input.reason?.trim() ?? "";
    if (reason.length === 0) throw new Error("--close requires --reason (it lands as the PR comment)");
    if (reason.length > MAX_REASON_LENGTH)
      throw new Error(`--reason is capped at ${MAX_REASON_LENGTH} characters (got ${reason.length})`);
  }

  const entry = findRun(entries, runId);
  if (!entry) {
    return refuse(base, {
      code: "run-not-found",
      detail: `no ledger run with id ${runId} — see fleet report`,
    });
  }
  base.task = entry.task;
  base.repo = entry.repo;

  // The gate is mode-blind: a cloud run's evidence reaches the operator through
  // the artifact sync (#35), and evidence adjacency is a UI invariant, not a
  // CLI precondition — a ledger-approved, GitHub-mergeable run merges the same
  // whether it ran here or in Actions.
  if (entry.status !== "approved") {
    const evidence = entry.reason ?? entry.evidence?.[0];
    return refuse(base, {
      code: "not-shipped",
      detail: `run status is ${entry.status}, not approved${evidence ? ` — ${evidence}` : ""}`,
    });
  }

  if (!entry.prUrl) {
    return refuse(base, {
      code: "no-pr",
      detail: "run was a dry-run: no PR was opened (re-run with --pr)",
    });
  }
  base.prUrl = entry.prUrl;

  const pr = JSON.parse(gh(["pr", "view", entry.prUrl, "--json", "state,mergeable,mergeStateStatus"])) as PrView;
  if (pr.state === "MERGED") {
    return refuse(base, { code: "already-merged", detail: "the PR is already merged" });
  }
  if (pr.state !== "OPEN") {
    return refuse(base, { code: "already-closed", detail: "the PR is already closed" });
  }

  if (action === "close") {
    try {
      gh(["pr", "close", entry.prUrl, "--comment", input.reason!.trim()]);
    } catch (err) {
      return refuse(base, { code: "close-failed", detail: `gh pr close failed: ${(err as Error).message}` });
    }
    return { ...base, ok: true, state: "closed", refusals: [] };
  }

  // Merge-only gates: GitHub must take the squash cleanly.
  if (pr.mergeable === "CONFLICTING") {
    return refuse(base, { code: "conflicts", detail: "merge conflicts with the base branch" });
  }
  const badState = BAD_MERGE_STATES[pr.mergeStateStatus];
  if (badState) {
    return refuse(base, { code: "not-mergeable", detail: `GitHub reports ${pr.mergeStateStatus}: ${badState}` });
  }

  try {
    gh(["pr", "merge", entry.prUrl, "--squash", "--delete-branch"]);
  } catch (err) {
    return refuse(base, { code: "merge-failed", detail: `gh pr merge failed: ${(err as Error).message}` });
  }

  // The receipt: read the merge back from GitHub. Best-effort — the merge
  // already happened, so a readback failure must not turn success into failure.
  const result: CosignResult = { ...base, ok: true, state: "merged", refusals: [] };
  try {
    const merged = JSON.parse(gh(["pr", "view", entry.prUrl, "--json", "mergeCommit,mergedBy,mergedAt"])) as {
      mergeCommit: { oid: string } | null;
      mergedBy: { login: string } | null;
      mergedAt: string | null;
    };
    result.mergedSha = merged.mergeCommit?.oid?.slice(0, 7);
    result.mergedBy = merged.mergedBy?.login ?? undefined;
    result.mergedAt = merged.mergedAt ?? undefined;
  } catch {
    // receipt fields stay undefined; the merge itself succeeded.
  }
  return result;
}

/** Human-readable rendering; `--json` consumers get the raw result instead. */
export function formatCosignResult(result: CosignResult): string {
  const target = [result.task, result.repo].filter(Boolean).join(" on ");
  if (!result.ok) {
    const r = result.refusals[0];
    return `cosign refused (${r.code}): ${r.detail}${target ? `\n  run: ${target}` : ""}`;
  }
  if (result.state === "merged") {
    return [
      `co-signed: squash-merged ${result.prUrl}`,
      `  run:    ${target}`,
      `  sha:    ${result.mergedSha ?? "(unknown)"}${result.mergedBy ? `  by ${result.mergedBy}` : ""}${result.mergedAt ? `  at ${result.mergedAt}` : ""}`,
      `  branch: deleted`,
    ].join("\n");
  }
  return `closed without merging: ${result.prUrl}\n  run: ${target}\n  (reason recorded as a PR comment)`;
}
