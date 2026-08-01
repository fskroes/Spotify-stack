/**
 * The retained kill store — what survives a killed run (ADR-0015).
 *
 * A correct kill and a wrongly-killed good diff write near-identical ledger
 * lines, and until now the change that would have proven the second one wrong
 * was destroyed by `pruneRunArtifacts` days later. So each kill's diff and the
 * artefact that killed it are copied into the canonical evidence store, where
 * nothing prunes and nothing expires:
 *
 *     fleet/evidence/<runId>/kill/diff.patch     the blinded view
 *     fleet/evidence/<runId>/kill/why/…          verdict.json | verify.log | scope-violation.json
 *     fleet/evidence/<runId>/kill/outcome.json   absent until someone re-adjudicates
 *
 * The separation is a property of the **path**, not of a reader's discipline: a
 * blind re-adjudicator reads `kill/`, and the key is one directory down.
 *
 * Not an exemption inside `artifacts/runs/` — that archive is evidence, not the
 * record, which is exactly why its pruning is allowed to fail. Making it durable
 * for some runs would give it a guarantee it was designed not to carry.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { runFacts, type TerminalStage } from "@fleet/contract";
import { runEvidenceDir } from "./evidence.js";

/** The blinded view: the change a killed run proposed, and nothing about why. */
export const KILL_DIFF_FILE = "diff.patch";

/** The unblinding key's directory — one level below the diff, on purpose. */
export const KILL_WHY_DIR = "why";

/**
 * The verdict slot, written by nothing here and read by nobody yet.
 *
 * Defined at retention time because the store has to distinguish three states
 * that are not the same claim: **absent** (not yet re-adjudicated — the
 * ordinary state), recorded-and-upheld, and recorded-and-overturned. Absence
 * means *not yet* and must never render as *upheld*.
 *
 * Its shape belongs to whatever `fleet resurrect` turns out to mean (#121), so
 * no schema is declared for it here — declaring one now would invent the answer
 * ADR-0015 deliberately handed off. What is fixed is the path, so a kill
 * retained today does not have to be retrofitted when that lands.
 */
export const KILL_OUTCOME_FILE = "outcome.json";

/**
 * Which artefact killed the run, keyed by the **gate it died at**.
 *
 * Keyed on `RUN_FACTS.diedAt` rather than on the status, because that is the
 * real relation: the artefact is written by the gate, and a second status-keyed
 * table beside the contract's one would be free to disagree with it (ADR-0008).
 * `satisfies Record<TerminalStage, …>` then makes a new gate a compile error
 * here until someone states what it leaves behind.
 *
 * The `agent` gate retains nothing because there is nothing to re-adjudicate:
 * `agent-failed` exists precisely because the agent produced no diff.
 */
const KILLING_ARTEFACT = {
  agent: null,
  scope: "scope-violation.json",
  verify: "verify.log",
  judge: "verdict.json",
} as const satisfies Record<TerminalStage, string | null>;

export type KillRetention =
  /** Copied. `why` names the artefact under `why/`. */
  | { kind: "retained"; dir: string; why: string }
  /** Legitimately nothing to keep — not a kill, or a kill with no change. */
  | { kind: "nothing-to-retain"; reason: string }
  /** The copy did not happen, and left nothing behind. Never fatal to the run. */
  | { kind: "failed"; reason: string };

/** Where a run's retained kill lives, whether or not one was written. */
export function retainedKillDir(evidenceRoot: string, runId: string): string {
  return path.join(runEvidenceDir(evidenceRoot, runId), "kill");
}

/**
 * Copy a killed run's diff and killing artefact into the evidence store.
 *
 * Best-effort by contract: this never throws, because a retention failure must
 * not fail a run the fleet has already decided about. It is not silent, though —
 * see `killRetentionLog`.
 *
 * All-or-nothing, because a half-copy is a state the store cannot describe: a
 * diff with an empty `why/` is a blinded question with no answer key, and it
 * would read as a retained kill to anyone counting them.
 *
 * @param artifactsDir  This run's flat artifact directory, which the run has
 *   just finished writing. The copy is taken from there rather than re-derived
 *   from the result, so the retained bytes are the same bytes the reviewer of
 *   the live run would have read.
 */
export function retainKill(opts: {
  evidenceRoot: string;
  runId: string;
  status: string;
  artifactsDir: string;
}): KillRetention {
  const diedAt = runFacts(opts.status)?.diedAt;
  if (!diedAt) return { kind: "nothing-to-retain", reason: `${opts.status} killed nothing` };
  const why = KILLING_ARTEFACT[diedAt];
  if (!why) {
    return { kind: "nothing-to-retain", reason: `a run that died at the ${diedAt} gate left no change to re-adjudicate` };
  }
  const dir = retainedKillDir(opts.evidenceRoot, opts.runId);
  // Canonical evidence is append-only, as it is for model usage beside it. A run
  // id is a fresh UUID, so an existing store is a collision or an operator
  // intervention — never a reason to replace the record of a judgement. Checked
  // before anything is written, which is also what makes the rollback below safe
  // to do: everything under `dir` is then this call's own work.
  if (existsSync(dir)) return { kind: "failed", reason: `a retained kill already exists at ${dir}` };
  try {
    mkdirSync(path.join(dir, KILL_WHY_DIR), { recursive: true });
    copyFileSync(path.join(opts.artifactsDir, KILL_DIFF_FILE), path.join(dir, KILL_DIFF_FILE));
    copyFileSync(path.join(opts.artifactsDir, why), path.join(dir, KILL_WHY_DIR, why));
    return { kind: "retained", dir, why };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * What the run says out loud about its retention, if anything.
 *
 * A failure is reported because a silent one is indistinguishable from a run
 * that had nothing to retain, and those are different facts — the first means
 * evidence was lost, the second means none existed. `nothing-to-retain` is the
 * ordinary case for every approved run, so it says nothing at all.
 *
 * The path is echoed on success because the store has no reader yet: a human
 * with an editor is the intended one, and they need to be told where to look.
 */
export function killRetentionLog(outcome: KillRetention): string | undefined {
  switch (outcome.kind) {
    case "retained":
      return `· kill retained → ${outcome.dir}`;
    case "failed":
      return `⚠ kill not retained: ${outcome.reason}`;
    case "nothing-to-retain":
      return undefined;
  }
}
