/**
 * Per-run artifact archive.
 *
 * The flat `artifacts/<task>/<repo>/` directory is latest-run-wins: every run
 * replaces the whole set, which is right for humans browsing "the current
 * state of this task" but destroys the evidence of an earlier run that is
 * still awaiting review. Each run therefore also archives its reviewable
 * artifacts under `artifacts/runs/<runId>/`, which nothing overwrites. The
 * operator API attributes those files to their run exactly, instead of
 * guessing from ledger order.
 */
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

/**
 * The artifacts a reviewer may see, with their content types. Shared with the
 * operator API's allowlist: anything not named here is never archived per-run
 * and never served (transcripts stay out — they are large and not part of the
 * review contract).
 */
export const REVIEW_ARTIFACTS = new Map<string, string>([
  ["diff.patch", "text/x-diff; charset=utf-8"],
  ["verify.log", "text/plain; charset=utf-8"],
  ["verdict.json", "application/json; charset=utf-8"],
  ["result.json", "application/json; charset=utf-8"],
  ["pr-preview.md", "text/markdown; charset=utf-8"],
]);

/** Run ids are UUIDs; pruning must never touch anything else that ends up
 *  under artifacts/runs (e.g. a task that happens to be named "runs"). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function runArtifactsRoot(controlRepo: string): string {
  return path.join(controlRepo, "artifacts", "runs");
}

export function runArtifactsDir(controlRepo: string, runId: string): string {
  return path.join(runArtifactsRoot(controlRepo), runId);
}

/**
 * Keep the newest `keep` run archives, drop the rest. Best-effort: the archive
 * is evidence, not the record (that is the ledger + GitHub), so a prune
 * failure must never fail a run.
 */
export function pruneRunArtifacts(controlRepo: string, keep = 20): void {
  try {
    const root = runArtifactsRoot(controlRepo);
    const dirs = readdirSync(root)
      .filter((name) => UUID.test(name))
      .map((name) => {
        const dir = path.join(root, name);
        return { dir, mtimeMs: statSync(dir).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const { dir } of dirs.slice(keep)) {
      rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // Missing root, races with a concurrent run — all fine to ignore.
  }
}

/** Create this run's archive directory (and prune old ones while here). */
export function prepareRunArtifactsDir(controlRepo: string, runId: string, keep = 20): string {
  const dir = runArtifactsDir(controlRepo, runId);
  mkdirSync(dir, { recursive: true });
  pruneRunArtifacts(controlRepo, keep);
  return dir;
}
