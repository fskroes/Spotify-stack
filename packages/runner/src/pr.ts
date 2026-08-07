/**
 * The PR surface — everything a skeptical reviewer needs to co-sign a fleet
 * change without opening the diff: what/why/what-not/who-checked/how-to-undo.
 * Kept pure (string in, string out) so the body is unit-testable and can be
 * previewed in dry-run as the pr-preview.md artifact.
 */
import type { VerifyState } from "./wire.js";
import { noGateInputs, type GateInputDecision } from "./gate-inputs.js";
import { formatRecordLine, type FleetRecord } from "./ledger.js";
import type { Task } from "./task.js";

/** Per-check result shape from @fleet/mcp-verify (plain JS, typed here).
 *  `skipped` = detected but never executed, which a boolean could not say. */
export type CheckStatus = "passed" | "failed" | "skipped";

export interface VerifyCheck {
  name: string;
  label: string;
  status: CheckStatus;
  /** Empty unless the check failed; capped failure summary when it did. */
  summary: string;
  durationMs: number;
}

export interface PrBodyInput {
  task: Task;
  diff: string;
  verifyChecks: VerifyCheck[];
  /** How verification ended. Read from the field, never inferred from the
   *  summary prose — the co-sign body's claims depend on getting this right. */
  verifyState: VerifyState;
  /** Checks the task's `gates:` mandated that never executed. Empty or absent
   *  when the task declared no gates or all were met — neither leaves anything
   *  outstanding, and neither renders an unmet-gate affordance at all. */
  unmetGates?: string[];
  /** What the verification tree did with this diff's gate inputs (ADR-0014) —
   *  what it held at the base, and what this task's `amends:` carried into it
   *  with the reason. Absent or empty on an ordinary run, which renders no
   *  gate-input affordance at all. */
  gateInputs?: GateInputDecision;
  verifySummary: string;
  record: FleetRecord;
  /** Commit sha for the revert instruction; dry-run preview omits it. */
  sha?: string;
  /** Link to the task file in the control repo (falls back to a plain path). */
  taskFileUrl?: string;
  /** New-issue link on the control repo for reporting fleet defects. */
  newIssueUrl?: string;
}

export function diffStats(diff: string): { files: string[]; additions: number; deletions: number } {
  const files: string[] = [];
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    const header = line.match(/^diff --git a\/.* b\/(.*)$/);
    if (header) {
      files.push(header[1]);
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      additions += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions += 1;
    }
  }
  return { files, additions, deletions };
}

const STANDING_RULE =
  "Standing rule: dependency manifests and lockfiles (package.json, package-lock.json, pnpm-lock.yaml, …) are never modified unless a task explicitly asks for it. Nothing enforces this mechanically inside a task's own scope — check the file list above.";

const code = (paths: string[]): string => paths.map((p) => `\`${p}\``).join(", ");

/**
 * The gate-input clause of the header, when there is one.
 *
 * In the header rather than only in the sections below, because both halves
 * change what the reviewer is being asked to co-sign: a held file is an edit
 * that shipped without being proven, and a carried one is a change to the thing
 * doing the proving. ADR-0014 requires the amendment to arrive with its reason,
 * so the reason is quoted here and not summarised.
 */
function gateInputHeader(decision: GateInputDecision): string[] {
  const clauses = [
    ...decision.carried.map(
      (a) => `carried under this task's amendment of \`${a.glob}\` — "${a.reason}": ${code(a.files)}`,
    ),
    ...(decision.held.length > 0
      ? [`held at the base, so the edit ships here unverified: ${code(decision.held)}`]
      : []),
  ];
  // A diff that only *adds* gate inputs has nothing for this clause to say. The
  // files ran, the banner is the ordinary one, and the fact keeps its place in
  // "what actually ran" below — putting it here would train a reader to skim the
  // line that exists to stop them (ADR-0021).
  if (clauses.length === 0) return [];
  return [`>`, `> **Gate inputs** · ${clauses.join(" · ")}`];
}

/** The same facts at the length a reviewer deciding on them needs. */
function gateInputLines(decision: GateInputDecision): string[] {
  return [
    ``,
    ...decision.carried.map(
      (a) =>
        `- ⚠ **Gate input carried under an amendment**: ${code(a.files)} — this task licences \`${a.glob}\` ` +
        `("${a.reason}"), so the change to the files that judge it was verified along with the rest of the diff.`,
    ),
    ...(decision.held.length > 0
      ? [
          `- ⚠ **Gate input held at the base**: ${code(decision.held)} — this diff edits ${decision.held.length === 1 ? "a file" : "files"} ` +
            `the checks read when they run, and this task does not amend ${decision.held.length === 1 ? "it" : "them"}. ` +
            `Verification used the base version, so ${decision.held.length === 1 ? "that edit is" : "those edits are"} **not** part of what proves this change.`,
        ]
      : []),
    // Beside the checks and not marked as a warning, because nothing here is
    // outstanding: these files ran. What the line buys the reviewer is that part
    // of the green above arrived with the diff, so its strength is whatever the
    // new assertions are worth (ADR-0021).
    ...(decision.introduced.length > 0
      ? [
          `- ✔ **Gate ${decision.introduced.length === 1 ? "input" : "inputs"} added by this change**: ${code(decision.introduced)} — the base ` +
            `does not have ${decision.introduced.length === 1 ? "this file" : "these files"}, so ${decision.introduced.length === 1 ? "it was" : "they were"} ` +
            `verified as part of the change rather than taken from the base. Read what ${decision.introduced.length === 1 ? "it asserts" : "they assert"}.`,
        ]
      : []),
  ];
}

export function buildPrBody(input: PrBodyInput): string {
  const { task, record } = input;
  const stats = diffStats(input.diff);
  const sha = input.sha ?? "<sha>";
  // Asked once: two sections of this body make claims that are only true when
  // something actually verified the change. Inconclusive arrives by two roads —
  // nothing was detectable to run, or the task demanded a check that did not
  // run — and the reviewer needs to be told which, since the second leaves a
  // named hole they can judge and the first does not.
  const unverified = input.verifyState === "inconclusive";
  const unmet = input.unmetGates ?? [];
  const nothingRan = input.verifyChecks.length === 0;
  // Absent and empty are the same claim here, and it is the ordinary one: this
  // diff touched no gate input, so nothing was held and no licence was used.
  const gateInputs = noGateInputs(input.gateInputs) ? undefined : input.gateInputs;

  const scopeSection = task.scope
    ? [
        `Mechanically confined to ${task.scope.map((g) => `\`${g}\``).join(", ")} — the runner kills any diff outside this scope before a human sees it.`,
        ``,
        STANDING_RULE,
      ]
    : [
        `This task carries no scope contract, so nothing bounded the diff — read the file list below against the task prompt.`,
        ``,
        STANDING_RULE,
      ];

  // What actually ran — and, when nothing did, the fact that nothing did. The
  // reviewer is being asked to co-sign on this section's word; an empty check
  // set that reads like silence would let them assume a pass.
  const checkLines = [
    ...(unverified && nothingRan
      ? [
          `- ⚠ **No verifiers detected for this repository** — nothing was executed.`,
          `- This change is **unverified**: no build, test, or lint gate has run against it.`,
        ]
      : input.verifyChecks.map((c) =>
          c.status === "skipped"
            ? `- – \`${c.label}\` did not run (earlier check failed)`
            : `- ${c.status === "passed" ? "✔" : "✖"} \`${c.label}\` ${c.status === "passed" ? "passed" : "FAILED"} (${(c.durationMs / 1000).toFixed(1)}s)`,
        )),
    // Named, not merely counted: which gate went unmet is what decides whether
    // the hole matters for this particular change.
    ...(unmet.length > 0
      ? [
          ``,
          `- ⚠ **This task mandated ${unmet.length === 1 ? "a check that did not run" : "checks that did not run"}**: ${unmet.map((g) => `\`${g}\``).join(", ")}`,
          `- What ran above is not the set the task required, so the mandate is **unproven** — whether that matters here is your call.`,
        ]
      : []),
    // Beside the checks, because it is the same question: what did and did not
    // get proven about this diff.
    ...(gateInputs ? gateInputLines(gateInputs) : []),
  ];

  // The banner's claim has to survive the verify state. "A verified change" is
  // only true when something verified it.
  // A held gate input is the third way this claim can be too strong, and it is
  // not the tri-state's business: every check that ran was green, and the state
  // is `passed` (ADR-0014 changes neither the verification state nor the run
  // status — that is #119's). What is untrue is "a verified change", because
  // part of the diff in front of the reviewer was not part of what proved it.
  const held = gateInputs?.held ?? [];
  const banner = !unverified
    ? held.length > 0
      ? `> **Risk: ${task.risk}** · Proposed by the fleet runner, and every check that ran was green — but ${held.length === 1 ? "one file in this diff was" : `${held.length} files in this diff were`} **not part of what proved it**: ${code(held)} ${held.length === 1 ? "is a gate input" : "are gate inputs"} this task did not amend, so verification used the base version. Read ${held.length === 1 ? "that edit" : "those edits"}.`
      : `> **Risk: ${task.risk}** · Proposed by the fleet runner and verified — every check that ran was green. Nothing reviewed the change for intent; that is what you are doing now.`
    : // Ahead of the unmet-gate clause and of the no-verifiers one, because it is
      // the strongest of the three claims and the only one where checks ran and
      // still proved nothing: the tree they ran on was the base commit (ADR-0021).
      // Without this branch a run here would read as "this repository has no
      // verifiers", which is false — they ran, on the wrong tree.
      gateInputs?.treeIsBase
      ? `> **Risk: ${task.risk}** · Proposed by the fleet runner but **nothing of this change was verified** — every file in this diff is a gate input this task did not amend, so the checks ran against the base commit and none of this change was in what they ran. A green above says nothing about the diff below. Read all of it.`
      : unmet.length > 0
        ? `> **Risk: ${task.risk}** · Proposed by the fleet runner but **the fleet could not fully verify it** — this task mandated ${unmet.map((g) => `\`${g}\``).join(", ")}, which did not run. Read the diff.`
        : `> **Risk: ${task.risk}** · Proposed by the fleet runner but **the fleet could not verify it** — this repository has no verifiers, so no check ran. Read the diff.`;

  return [
    banner,
    ...(gateInputs ? gateInputHeader(gateInputs) : []),
    ``,
    `## What changed`,
    ``,
    `${stats.files.length} file${stats.files.length === 1 ? "" : "s"}, +${stats.additions} −${stats.deletions}:`,
    ...stats.files.map((f) => `- \`${f}\``),
    ``,
    `## Why`,
    ``,
    task.why,
    ``,
    `Task: ${input.taskFileUrl ? `[\`${task.id}\`](${input.taskFileUrl})` : `\`${task.id}\``} — ${task.title}`,
    ``,
    `## What this deliberately did not touch`,
    ``,
    ...scopeSection,
    ``,
    `## What actually ran`,
    ``,
    ...checkLines,
    ``,
    `<details><summary>Raw verify log</summary>`,
    ``,
    "```",
    input.verifySummary,
    "```",
    ``,
    `</details>`,
    ``,
    `## Undo`,
    ``,
    `Single commit. Revert is one step: the **Revert** button on this PR, or \`git revert ${sha}\`.`,
    ``,
    `## Accountability`,
    ``,
    `Authored by the fleet runner, not a person. A wrong change here is a fleet defect, not a reviewer failure — report it: ${input.newIssueUrl ?? "open an issue on the fleet control repo"}.`,
    ``,
    `## Fleet record`,
    ``,
    formatRecordLine(record),
  ].join("\n");
}
