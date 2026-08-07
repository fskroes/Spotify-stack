# The `vetoed` status leaves the vocabulary, and an unclassified row is counted

**Date of decision: 2026-08-07.** Corrects and completes
[ADR-0025](0025-the-judge-is-deleted-and-verify-is-the-last-gate.md), which kept
this status on a claim about the archive that the archive does not support.

## The decision

**`vetoed` is removed from `RUN_STATUSES` and `RUN_FACTS`**, and `judge` with it
from `TERMINAL_STAGES` and from `kill-retention.ts`'s killing-artefact table.
`fleet report` no longer prints a judge-veto tally.

**In its place, `fleetRecord` counts rows it cannot classify**, and
`formatRecordLine` prints that count whenever it is non-zero.

## Why ADR-0025's reason does not hold

ADR-0025 deleted the judge but kept the vocabulary, on this:

> …**archived ledger rows carry them**, one of which is a real `vetoed` run.

Measured against the archive on 2026-08-07 — all 50 rows of
`fleet/ledger.jsonl`, plus every committed revision of that file, plus
`fleet/evidence/`:

| | Rows |
|---|---|
| status `vetoed` | **0** |
| any status matching `/veto/i` | **0** |
| `verdict.json` in the evidence store | **0** |
| field `vetoes` (always `0`) | 50 |
| `timings.judgeMs` non-zero | 30 |
| `modelUsage.judge` | 44 |

There is no real `vetoed` run. There never was one. The bottom three rows are
why `vetoes`, `judgeMs` and the `judge` usage rail **stay declared** — those are
fields every archived row actually holds, and dropping them would make 50 rows
unreadable. The status is the opposite case: a vocabulary entry with no
producer, no archived instance, and no reader that needs it.

This is the same test [ADR-0027](0027-the-wire-contract-package-is-deleted.md)
applied to tolerance, and it gives the same answer from the other direction:
carry what the archive holds, drop what it does not.

Per the repo's own rule, ADR-0025 is **not** edited to agree with this. It stands
as written, including the sentence measured false here.

## The alternative that lost

**Keep `vetoed` declared, as ADR-0027 kept `vetoes` and `mode: "cloud"`.** The
symmetry is superficial. Those are *fields on rows that exist*; this is a *value
no row has*. Keeping it costs a permanent branch in the fate table, a killing
artefact (`verdict.json`) that is never written, and a line in every `fleet
report` announcing a gate this system does not have — `0 judge vetoes`, forever,
on the surface whose entire purpose is the kill count meaning something.

## The thing this cut created, and the 10% put back

Removing a value from `RUN_STATUSES` makes it the first **previously-known**
status that `runFacts()` now returns `undefined` for. `fleetRecord` buckets by
that lookup, so an unclassifiable row landed in no bucket at all: not shipped,
not killed, not infra, not neutral. It vanished from the tally, and a record
missing runs read exactly like a record with none.

That is close enough to a false green to fix rather than note
([ADR-0004](0004-verification-tri-state-and-mandated-gates.md)). `FleetRecord`
gains `unclassified`, and `formatRecordLine` prints it in its own sentence
**after** the parenthetical — that breakdown itemises the killed count beside
it, and an unclassified run is by definition not a kill. The property is locked
directly: every row in the window lands in exactly one bucket, and the buckets
sum to the window.

Making that true required one more thing than the count. `runFacts` indexed the
fate table directly, so a row whose status collided with an `Object.prototype`
key — `constructor`, `toString`, `valueOf` — resolved to a truthy non-`RunFacts`
value and was neither classified **nor** reported as unclassified: the exact
silent drop this field exists to close, reachable because `status` is
`z.string()` on the wire. The lookup now guards with `Object.hasOwn`, and the
sum property is asserted against those four keys.

The hole was not created by this change — `runFacts` has always returned
`undefined` for an unknown status, and a test has always asserted it. What this
change did was make the case reachable from real data instead of hypothetical,
which is what made it worth closing.

## Consequences

- Adding a status back is still a compile error until its facts are stated;
  that guarantee is untouched.
- A ledger written by an older build that produced `vetoed` is still readable —
  the row parses, renders, and is now *counted* rather than dropped.
- `cosign` is unaffected: it refuses anything whose status is not `approved`,
  which is already the correct answer for a status it cannot classify.

## Status

Accepted. Reversing it means the judge returns, which
[ADR-0025](0025-the-judge-is-deleted-and-verify-is-the-last-gate.md) already
gates on one named defect that verify let through.
Owner: **Fernando Silva Kroes**.
