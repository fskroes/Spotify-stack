/**
 * What leaves the cloud runner.
 *
 * `agent-task.yml` stages a directory and uploads it with
 * `actions/upload-artifact`. This repo is public, so that artifact is
 * publicly downloadable: every path the staging step sweeps is a publication
 * decision about a private target's prose, not a plumbing detail.
 *
 * The step needs the run's `model-usage.json`, which is git-ignored and so
 * cannot be enumerated with `git diff` — it uses `git ls-files --others`. That
 * reaches for *untracked* files, which is exactly the property the private
 * stores under `fleet/evidence/` also have. When the retained kill store
 * (ADR-0015) landed there, a sweep of the whole directory silently began
 * uploading killed diffs and `scope-violation.json` — the latter deliberately
 * outside `REVIEW_ARTIFACTS`, which is the set a reviewer may see.
 *
 * So the sweep is pinned to the one file it exists for. This test is the pin:
 * widening it back to a directory is a red build, not something a reviewer has
 * to notice in a YAML diff.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(path.join(repoRoot, ".github/workflows/agent-task.yml"), "utf8");

describe("the cloud run's uploaded artifact", () => {
  it("sweeps untracked evidence by filename, never by directory", () => {
    const sweeps = [...workflow.matchAll(/git ls-files --others --\s+(\S+)/g)].map((m) => m[1]);

    expect(
      sweeps.length,
      "anchor not found: agent-task.yml no longer stages untracked evidence with `git ls-files --others`. " +
        "The step was restructured — re-point this lock at what stages the upload now.",
    ).toBeGreaterThan(0);
    // A pathspec ending in a filename can only ever match that filename. A bare
    // directory — `fleet/evidence` — matches the whole private store.
    expect(sweeps).toEqual(["'fleet/evidence/*/model-usage.json'"]);
  });

  it("copies no path inside the retained kill store", () => {
    // Nothing about a kill may ride this artifact: the diff is the target's
    // source, and the killing artefact is the judge's prose about it. Prose
    // may say "kill" — a *path* may not.
    const paths = [...workflow.matchAll(/fleet\/evidence\S*/g)].map((m) => m[0]);

    expect(paths.filter((p) => p.includes("kill"))).toEqual([]);
  });
});
