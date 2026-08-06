# The judge is deleted, and green verify is the last gate

**Date of decision: 2026-08-06.** Supersedes
[ADR-0011](0011-the-runner-owns-the-judges-reads.md) and trigger 1 of
[ADR-0024](0024-the-machine-is-frozen-and-the-triggers-thaw-it.md).

## The decision

**No model reviews a change before a person does.** A run is agent → scope →
verify → a pull request a human reads. Green verify is the last gate the machine
holds.

## What it cost, measured before deleting

| | |
|---|---|
| Vetoes in production | **0 in 48 runs** |
| Dedicated code | `packages/judge` + `packages/judge-read`, **3,374 lines across 16 files** |
| Other source files referencing it | 25 |
| ADRs naming it | 17 of 24 |
| Tests deleted with it | 166 of 737 |
| Spend | `claude-cli-estimate` **$6.94 across 27 runs**, 9.9% of the fleet's estimated total — on a flat subscription, so never an invoice |

The spend column is why ADR-0024 kept it and why that reasoning was wrong. The
judge was defended on price. Price was never what it cost. It cost a quarter of
the architecture's weight and 17 of 24 decision records, and it had never once
changed an outcome.

## The alternative that lost

**Wait for 100 runs, as ADR-0024's trigger 1 said.** Rejected: 48 trials at zero
is already the answer, and a counter is a schedule for not deciding. The
matched-pair experiment
([2026-07-29](../experiments/2026-07-29-judge-discrimination-matched-pair.md))
stands and is not retracted — the judge *does* discriminate at its own seam.
That was a lab result. Production never fired it, because scope and verify run
first and hand it clean runs.

**Stop calling it but keep the packages.** Rejected: it removes the call and
none of the weight, which is the whole cost. A dormant package still has to be
understood by whoever reads the repo next.

## What this gives up, plainly

1. **The standing lockfile rule is no longer enforced inside a task's own
   scope.** The scope gate still kills a diff that leaves `task.scope`; nothing
   now stops a manifest edit that stays inside it. The PR body tells the
   reviewer to read the file list instead of asserting a veto that never ran.
2. **The agent's deterrent is gone.** The harness rules told it a veto costs a
   full retry loop. They now tell it the truth: a person reads the diff.
3. **Self-correction is gone.** Only a veto could seed a second pass, so
   deleting the judge deleted the retry loop, and with it `Engine.resume`. A run
   is one pass. An agent that produces a bad diff produces a bad diff.

None of the three is a false green, which is the one output this system may not
produce ([ADR-0004](0004-verification-tri-state-and-mandated-gates.md)). Verify
still owns that, and verify has a measured 10-of-48 catch rate.

## What stays, and why

`vetoes`, `judgeMs`, the `vetoed` status, `USAGE_RAILS`, `JudgeIdentitySchema`,
`VerdictEvidence` and `STAGES` all stay on the wire and in every reader. **48
archived ledger rows carry them**, one of which is a real `vetoed` run. The
ledger is append-only history; a reader that cannot parse its own past is worse
than a dead type. This is the same rule the cloud mode was kept under —
[ADR-0001](0001-tolerant-reader-wire-contract.md) applied to time.

[`judge-cage-spec.md`](../judge-cage-spec.md) stays for the same reason:
ADR-0011 cites it, and a record is not a part.

> **2026-08-06, later the same day: the spec was deleted after all.** A file in
> the tree is inventory, whatever it records, and `Historical` is a label on the
> shelf rather than a deletion. Git holds it at `ae9acbb`. ADR-0011's two
> citations of it were left pointing at a path that no longer resolves —
> repairing them would rewrite an ADR to agree with later code. This note
> retracts the paragraph above it and nothing else; the ledger-type clause
> stands.

## Status

Reversible, and the reversal is named: **if a merged fleet PR turns out to carry
a defect a reader should have caught, that is the evidence this decision was
wrong**, and the judge comes back at its seam. Until then it does not.
ADR-0024's other two triggers stand unchanged. Owner: **Fernando Silva Kroes**.
