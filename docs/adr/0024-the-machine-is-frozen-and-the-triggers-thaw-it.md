# The machine is frozen at 0023, and three triggers thaw it

**Date of decision: 2026-08-06.**

The fleet works. It is now used, not built. This record closes the build phase
and names the only three events that reopen it.

## The measurement this rests on

Taken 2026-08-06, over the repo's whole life (first commit 2026-07-09):

| Question | Measurement |
|---|---|
| Do the fleet's PRs merge? | **15 of 16.** The one closed was `probe-adr-0019-base`, a deliberate probe. So 15 of 15 real PRs. |
| Is the work real? | Four merged PRs, by diff size: +1085/−8 · +354/−143 · +3/−1082 · +137/−85. Not one-line edits, and one is a net deletion. |
| Does the verify gate catch? | **Yes.** It stopped 10 of 48 runs — 5 verify-failed, 4 no-changes, 1 engine-failed. 4 retained kills on disk. The poisoned probe `bm-2-architecture-drift-poisoned` was caught here. |
| Does the judge catch? | **Never yet. 0 vetoes in 48 runs.** It discriminates at the seam — [the matched pair proves it](../experiments/2026-07-29-judge-discrimination-matched-pair.md) — but nothing has reached it in production that needed vetoing. Scope and verify fire first and hand it clean runs. |
| Where does the effort go? | 165 commits: **37% decisions** (ADR + docs), **34.5% building the machine**, **3.6% running it on targets**. |
| Is anyone else here? | **No.** Public 27 days: 0 stars, 0 forks, 0 outside issues. The distribution stack was deleted on 2026-08-06 for the same reason. |

## The decision

**No new capability, and no new decision record, until a trigger below fires.**

The operator is the only user, and the tool already produces work the operator
merges without exception. Under those two facts the binding constraint is the
operator's review rate, and every hour spent on the machine buys nothing that a
100%-merge tool was missing.

### The three triggers, and only these

1. **The judge vetoes once on a real run.** Judge work reopens that day. If the
   ledger reaches **100 runs** with zero vetoes, delete the judge and keep the
   verify gate — a billed call that has never changed an outcome is insurance
   with a proven mechanism and no claims.
2. **A run goes red in a way the current gates missed.** That, and nothing else,
   authors ADR-0025. This is the same shape as the `amends:` trigger, which
   fired on 2026-08-04 and was spent.
3. **Targets 3 and 4 land and 20 further PRs merge.** At that point the ceiling
   is measurable, and the question of whether it is the machine or the operator's
   review rate becomes answerable rather than arguable.

Until one fires, the answer to *should I build X* is no.

## The cloud path: the entry point goes, the read path stays

The cloud path is dead by measurement — 2 dispatches of 48, none since 24 July —
and its deletion was priced in conversation at ~870 lines. **That price was
wrong**, and the corrected shape changes what gets deleted:

- **Delete the entry point.** `agent-plan.yml`, `agent-task.yml`, `fleet-run.yml`,
  the `fleet dispatch` verb, and the operator's Dispatch control. This is the
  part that makes a cloud run *possible*.
- **Keep the read path.** `mode: "cloud"` in `@fleet/contract`, the ledger union,
  and `CloudArtifactSync` stay. **Two real ledger rows carry `mode: "cloud"`.**
  The ledger is append-only history; a reader that cannot parse its own past is
  a worse outcome than a dead code path. This is the tolerant-reader rule of
  [ADR-0001](0001-tolerant-reader-wire-contract.md) applied to time.

**Executed 2026-08-06**, the same day this was written. It was cheaper than the
"not urgent" above assumed: three workflows, the `dispatch` verb, the operator's
Dispatch control and its `FleetAction::Dispatch` SSH capability, and the
`GITHUB_ACTIONS` branch in the ledger writer. `test/cloud-upload-reach.test.ts`
went with it — it pinned what `agent-task.yml` was allowed to upload publicly,
and with no workflow there is nothing to pin.

No ADR-0025 was written for it. The decision is this record; carrying it out is
not a second decision, and the freeze above forbids one.

**What this closes.** [ADR-0015](0015-a-kill-is-retained-forever-and-blinded.md)'s
second bullet waited on the next cloud dispatch to decide whether kill evidence
travels through a publicly downloadable artifact. There is no next cloud
dispatch. The question is answered by removal: kill evidence is local-only, and
the promise in that record holds unconditionally.

## The alternative that lost

**Unblock the cloud path first, so the fleet runs while the operator sleeps.**
This was recommended and then withdrawn on its own evidence: the fleet produced
36 runs in the three days the operator was present, roughly 12 a day. It is not
run-starved when the operator sits down. Cloud dispatch adds runs that still
need one person to review, so it moves the queue and leaves the ceiling exactly
where it was.

**Delete gates to raise throughput** — the harder reading of the same data.
Rejected on the split verdict above: the verify gate has a 10% catch rate on
real runs and pays for itself. Only the judge is unproven, and trigger 1 puts a
number on it rather than guessing.

## Status

This is a freeze, not a finish. It is deliberately falsifiable: three named
events, each observable in the ledger, each reopening a specific piece of work.
Owner: **Fernando Silva Kroes**.
