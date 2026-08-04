# A kill is retained forever, blinded, with a slot for its verdict

When a run is killed, the runner copies its diff and the artefact that killed it
into `fleet/evidence/<runId>/kill/`, laid out so the two can be read apart:

```
fleet/evidence/<runId>/kill/diff.patch     the blinded view
fleet/evidence/<runId>/kill/why/…          verdict.json | verify.log | scope-violation.json
fleet/evidence/<runId>/kill/outcome.json   absent until someone re-adjudicates
```

It is never pruned, never expires, and is not cleaned up when a kill is
overturned. Resolves #120 under map #115. Definitions are in
[`CONTEXT.md`](../../CONTEXT.md#retained-kill).

## Status

**Accepted** (2026-08-01). **Retention built for local runs** (2026-08-01): a
run killed at the scope, verify, or judge gate copies its diff and its killing
artefact into `kill/`. An `agent-failed` kill retains nothing, and that is not an
omission — the status exists because the agent produced no diff, so there is no
change to re-adjudicate.

**One measurement below is corrected** (2026-08-04), in this marker rather than
in place: this record has been readable since 2026-08-01, so editing its prose
would be the retconning [the supersede rule](README.md) exists to prevent, and
the licence [ADR-0019](0019-a-shipping-run-is-based-on-what-it-ships-against.md)
took applies only to a draft nobody could yet have read. No superseding record
either — the decision here is untouched, and a record that decides nothing is not
an ADR. *Why this was urgent* is left exactly as written.

What was corrected is the **driver**, not the mechanism. The eviction is still
`pruneRunArtifacts(keep = 20)`, still mtime-ordered and still indiscriminate. But
the pressure filling those twenty slots is not the *"routine approved run"* named
below: the end-to-end suite ran with its control repo set to the real checkout
and no way to redirect artifacts, so `pnpm test` wrote fixture archives into the
live `artifacts/runs/` and evicted every genuine run. Measured on 2026-08-04:
fifteen real run ids in the ledger, **zero** surviving archives, all twenty
survivors fixtures. The 2026-08-01 observation that *"the twenty survivors all
[came] from one later burst"* was correct; only its implied cause was not, and
whether *that* burst was also the suite is no longer measurable. Full method in
[`../experiments/2026-08-04-walking-the-cosign-line.md`](../experiments/2026-08-04-walking-the-cosign-line.md).

This strengthens rather than weakens the decision two sections down. If the
prune's pressure is fixture noise, teaching it about run status would have been a
patch over a test-isolation defect — a worse trade than the one that section
already rejected. `run()` now takes an artifacts root, and the suite passes a
temporary one.

Two things are deliberately still unbuilt:

- Nothing writes `outcome.json`. The slot is defined here and filled by whatever
  #121 decides a resurrection means.
- **A cloud run's kill is not retained anywhere durable.** It is written to
  `fleet/evidence/` on the Actions runner, which is destroyed with it. Landing it
  in the operator's store needs a decision this ADR did not make: the only
  channel home is a public-repo Actions artifact, and `scope-violation.json` is
  not in the set that channel carries. Until then the promise below holds for
  `mode: local` and not for `mode: cloud`.

**The trigger for the second bullet, written here because this is where it will
be read** (2026-08-04): it is not waiting on a date. It is waiting on **the next
cloud dispatch**, and that dispatch is where it has to be decided — #123 carries
the four questions, of which the first is whether kill evidence travels through a
publicly downloadable artifact at all. Two cloud runs exist, both approved, none
since 24 July, so nothing has been lost yet. The loss is irreversible the first
time it is not. **A cloud run dispatched without deciding this throws a kill away
on purpose.**

## Why this was urgent, and it is not the reason the map gave

The map said the kill destroys the diff. That is right in outcome and wrong in
mechanism, and the mechanism matters because it changes the fix.

The diff *is* retained. Every kill path writes `diff.patch`, and the per-run
archive from [ADR-0007](0007-per-run-artifact-archive.md) mirrors it into
`artifacts/runs/<runId>/`, which nothing overwrites. What destroys it is
`pruneRunArtifacts(keep = 20)` — mtime-ordered and indiscriminate, because it has
no way to tell a kill still awaiting review from a routine approved run.

**Measured on 2026-08-01: it had already happened to every kill in the ledger.**
Twelve rows, two kills; both archives gone, the twenty survivors all from one
later burst. What did survive for those runs was `model-usage.json`, which is not
pruned — so the fleet was retaining what a killed run *cost* and not what it
*did*.

ADR-0007 called this in advance: *"20 is a disk-pressure guess, not a derived
number. If reviewers routinely lose evidence to it, raise it — nothing depends on
the value."*

## Why a separate store rather than exempting the prune

Teaching `pruneRunArtifacts` about run status was the smaller diff and the worse
decision. ADR-0007's load-bearing line is *"the archive is evidence, not the
record"* — which is precisely why pruning is best-effort and why a prune failure
must never fail a run. Making it durable for some runs gives that archive a
guarantee it was deliberately designed not to carry, and the next reader has to
learn which half of it means what.

A kill store is a different thing making a different promise, and it belongs in
the store that already makes that promise. `docs/README.md`'s fourth seam already
says so: *"the ledger is a compact projection; the canonical record lives in
`fleet/evidence/`."* This fills that seam for kills; it does not invent one.

## Why the killing artefact is kept, and kept apart

The obvious economy is to keep the patch alone, on the grounds that the reason is
already on the ledger line and the ledger is never pruned. Rejected on inspection:
**the ledger's kill fields are lossy projections**, and the loss falls exactly
where a re-adjudication would need precision.

- `verify-failed` records only the **first** failed check. Three fail, two are
  invisible. Evidence is capped at 8 lines, 200 characters each.
- `vetoed` records `violations[0]`. `verdict.json` carries the full array, the
  rationale, `readPaths`, and the judge identity pair that
  [ADR-0011](0011-the-runner-owns-the-judges-reads.md) exists to preserve.
- `scope-violation` records the first 5 offenders; the artefact carries all of
  them and the globs they broke.

So the ledger says *that* a run was killed and roughly why. It cannot reconstruct
the judgement, and [blind re-adjudication](../../CONTEXT.md#blind-re-adjudication)
cannot be **scored** without one. Patch-only retains the question and discards the
answer key.

The separation is a property of the **path**, not of a reader's discipline. A
blinded reader reads `kill/`; the key is one directory down. Two files in one
directory would make "don't open that one" the entire protection, and it would
fail the first time somebody globbed.

## Why forever, with no retention policy at all

Measured on 2026-08-01: 19 stored diffs, **mean 1.6 KB, max 1.7 KB**. With one
killing artefact each and kills running at two in twelve, a thousand runs costs
well under a megabyte. Even a hundredfold larger refactor diff puts it in tens of
megabytes.

So a window would be a policy, a date comparison, a configuration value and a bug
class, bought to reclaim kilobytes — and it would cap the length of the gradient
this whole map exists to obtain. The volume argument that justified ADR-0007's
prune does not transfer: that archive keeps **every** run, including large
payloads. Same repo, different regime, and the difference is written down here so
the prune is not cargo-culted into the next store.

**A resurrected kill is not cleaned up either.** It is a confirmed false kill —
the positive class, the rarest and most expensive row the fleet will ever
produce, and the only thing that could ever demonstrate the system was wrong.
Deleting it on resurrection would delete the finding.

## Why an empty file is part of the decision

`outcome.json` is defined here and written by nothing. That is deliberate: the
store has to be able to distinguish three states that are not the same claim.

| | |
|---|---|
| `outcome.json` absent | not yet re-adjudicated — the ordinary state |
| recorded, kill upheld | reviewed, and the fleet was right |
| recorded, kill overturned | a false kill |

Without the slot, a retained kill store is a pile of diffs with no verdicts, and
no rate can be computed from it — the substrate would ship unable to carry the
gradient it exists for. Deferring the slot to #121 would mean retrofitting it into
every kill retained in the meantime, which is the same irreversible-loss argument
that made this ticket urgent.

Absence means *not yet*, and must never render as *upheld* — the same distinction
[ADR-0002](0002-model-usage-evidence-contract.md),
[ADR-0004](0004-verification-tri-state-and-mandated-gates.md) and ADR-0007 each
draw for their own fields.

## Consequences

- **The copy is best-effort but loud.** As in ADR-0007, a retention failure must
  never fail a run. Unlike ADR-0007, it must be reported: a silent failure is
  indistinguishable from a run that had nothing to retain, and those are different
  facts.
- **`fleet resurrect` is handed off**, and belongs with #121 rather than
  free-floating. This ADR decides where the answer goes; #121 decides what
  question it answers and what a rate would mean. The map's standing instrument
  test applies there, and deliberately not here — retention is the substrate, not
  the instrument.
- **The store is usable with no tool.** A diff and two JSON files at a documented
  path can be read, and `outcome.json` written, by a human with an editor. If #121
  never closes, retention still works; it is merely manual. That is the difference
  between deferring a reader and deferring the data.
- **Target prose lives here by construction**, so the whole store stays in
  git-ignored `fleet/evidence/`. Nothing about a kill may reach
  `fleet/ledger.jsonl` beyond what its already-scrubbed projection carries.
- This does not change what a kill *is*, or [run
  status](../../CONTEXT.md#run-status-vs-verification-state), or when the fleet
  kills. It changes only what survives one.
