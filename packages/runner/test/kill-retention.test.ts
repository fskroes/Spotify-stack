/**
 * The retained kill store (ADR-0015).
 *
 * Two properties carry the decision and neither is visible from a happy-path
 * assertion, so they are tested directly: the reason is **one directory down**
 * from the diff (blinding is a property of the path, not of a reader's
 * discipline), and `outcome.json` is **never written** (absence means "not yet
 * re-adjudicated", which must never be readable as "upheld").
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  KILL_OUTCOME_FILE,
  killRetentionLog,
  retainKill,
  retainedKillDir,
  type KillRetention,
} from "../src/kill-retention.js";

function tmpControlRepo(): string {
  return mkdtempSync(path.join(os.tmpdir(), "fleet-kill-"));
}

/** The artefacts a run of `status` would have left in its flat artifacts dir. */
function seedArtifacts(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-kill-artifacts-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

const DIFF = "diff --git a/src/a.ts b/src/a.ts\n+const a = 1;\n";

/** A retention over a run that died at `status`, with the artefacts it wrote. */
function retain(status: string, files: Record<string, string>): {
  outcome: KillRetention;
  controlRepo: string;
  runId: string;
} {
  const controlRepo = tmpControlRepo();
  const runId = randomUUID();
  const outcome = retainKill({ evidenceRoot: controlRepo, runId, status, artifactsDir: seedArtifacts(files) });
  return { outcome, controlRepo, runId };
}

describe("retained kill store", () => {
  it("keeps the diff and the artefact that killed it, apart", () => {
    const verdict = JSON.stringify({ verdict: "veto", violations: ["a", "b"], readPaths: ["src/a.ts"] });
    const { outcome, controlRepo, runId } = retain("vetoed", { "diff.patch": DIFF, "verdict.json": verdict });

    expect(outcome.kind).toBe("retained");
    const dir = retainedKillDir(controlRepo, runId);
    expect(readFileSync(path.join(dir, "diff.patch"), "utf8")).toBe(DIFF);
    expect(readFileSync(path.join(dir, "why", "verdict.json"), "utf8")).toBe(verdict);
  });

  it("blinds by path: the kill directory itself holds only the diff", () => {
    // A reader handed `kill/` sees the question and no part of the answer. Two
    // files in one directory would make "don't open that one" the entire
    // protection, and it would fail the first time somebody globbed.
    const { controlRepo, runId } = retain("vetoed", { "diff.patch": DIFF, "verdict.json": "{}" });

    expect(readdirSync(retainedKillDir(controlRepo, runId)).sort()).toEqual(["diff.patch", "why"]);
  });

  it("never writes the outcome slot — absence is the ordinary state", () => {
    // Absent means *not yet re-adjudicated*. Writing anything here at retention
    // time would make every retained kill claim a review it never had.
    const { controlRepo, runId } = retain("verify-failed", { "diff.patch": DIFF, "verify.log": "VERIFY FAILED" });

    expect(existsSync(path.join(retainedKillDir(controlRepo, runId), KILL_OUTCOME_FILE))).toBe(false);
  });

  it("takes the killing artefact from the gate that killed the run", () => {
    const cases = [
      { status: "verify-failed", file: "verify.log", content: "VERIFY FAILED\n✗ eslint" },
      { status: "scope-violation", file: "scope-violation.json", content: '{"offendingFiles":["src/a.ts"]}' },
    ];
    for (const { status, file, content } of cases) {
      const { outcome, controlRepo, runId } = retain(status, { "diff.patch": DIFF, [file]: content });

      expect(outcome, status).toMatchObject({ kind: "retained", why: file });
      expect(readFileSync(path.join(retainedKillDir(controlRepo, runId), "why", file), "utf8")).toBe(content);
    }
  });

  it("retains nothing for a run that was not killed", () => {
    // An approved run's evidence is the PR. Nothing here is awaiting review.
    const { outcome, controlRepo, runId } = retain("approved", { "diff.patch": DIFF, "verdict.json": "{}" });

    expect(outcome.kind).toBe("nothing-to-retain");
    expect(existsSync(retainedKillDir(controlRepo, runId))).toBe(false);
  });

  it("retains nothing for an agent that produced no diff, and does not call it a failure", () => {
    // `agent-failed` is a kill, but there is no change to re-adjudicate: the
    // status exists precisely because the diff was empty. Nothing to retain and
    // a failure to retain are different facts, and only the second is loud.
    const { outcome, controlRepo, runId } = retain("agent-failed", {});

    expect(outcome.kind).toBe("nothing-to-retain");
    expect(existsSync(retainedKillDir(controlRepo, runId))).toBe(false);
  });

  it("is best-effort: a kill whose artefacts have vanished reports, and does not throw", () => {
    const controlRepo = tmpControlRepo();
    const runId = randomUUID();

    const outcome = retainKill({
      evidenceRoot: controlRepo,
      runId,
      status: "vetoed",
      artifactsDir: path.join(controlRepo, "artifacts", "gone"),
    });

    expect(outcome.kind).toBe("failed");
  });

  it("keeps nothing at all when only half of it could be copied", () => {
    // A diff with an empty `why/` is a blinded question with no answer key, and
    // it would count as a retained kill to anyone counting them. Not retained is
    // a state the store can describe; half-retained is not.
    const { outcome, controlRepo, runId } = retain("vetoed", { "diff.patch": DIFF }); // no verdict.json

    expect(outcome.kind).toBe("failed");
    expect(existsSync(retainedKillDir(controlRepo, runId))).toBe(false);
  });

  it("never silently replaces a retained kill", () => {
    // Canonical evidence is append-only, as it is for model usage: an existing
    // path is a collision or an operator intervention, never a reason to
    // overwrite the record of a judgement — and never a reason for the rollback
    // above to delete one either.
    const controlRepo = tmpControlRepo();
    const runId = randomUUID();
    const artifactsDir = seedArtifacts({ "diff.patch": DIFF, "verify.log": "VERIFY FAILED" });
    const once = { evidenceRoot: controlRepo, runId, status: "verify-failed", artifactsDir };

    expect(retainKill(once).kind).toBe("retained");
    expect(retainKill(once).kind).toBe("failed");
    const dir = retainedKillDir(controlRepo, runId);
    expect(readFileSync(path.join(dir, "diff.patch"), "utf8")).toBe(DIFF);
    expect(readFileSync(path.join(dir, "why", "verify.log"), "utf8")).toBe("VERIFY FAILED");
  });
});

/**
 * Best-effort, but loud. A retention failure must never fail a run — and must
 * never pass silently either, because a silent failure is indistinguishable
 * from a run that had nothing to retain, and those are different facts.
 */
describe("killRetentionLog", () => {
  it("reports a failure, naming what was lost", () => {
    const line = killRetentionLog({ kind: "failed", reason: "ENOENT: diff.patch" });

    expect(line).toContain("⚠");
    expect(line).toContain("kill not retained");
    expect(line).toContain("ENOENT: diff.patch");
  });

  it("says nothing about a run that had nothing to retain", () => {
    expect(killRetentionLog({ kind: "nothing-to-retain", reason: "approved is not a kill" })).toBeUndefined();
  });

  it("names the store a retained kill landed in, so a reviewer can find it", () => {
    const line = killRetentionLog({ kind: "retained", dir: "/fleet/evidence/abc/kill", why: "verdict.json" });

    expect(line).toContain("/fleet/evidence/abc/kill");
  });
});
