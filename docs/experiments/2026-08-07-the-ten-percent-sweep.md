# The 10% sweep: every remaining part, named and measured

**2026-08-07.** A point-in-time survey. Not maintained against the code.

## Why this exists

Three deletions landed on 2026-08-06/07 — the desktop operator
([ADR-0026](../adr/0026-the-desktop-operator-is-deleted.md)), the wire-contract
package ([ADR-0027](../adr/0027-the-wire-contract-package-is-deleted.md)) and the
browser dashboard ([ADR-0028](../adr/0028-the-browser-dashboard-is-deleted.md)).
Their add-back rates were 1.3%, 78% and 0%.

The rule being applied is Musk's: a cut that needed no repair was too timid, so
aim to add back about a tenth of what you removed. The 0% on the dashboard was
the signal that the sweep had not finished. This document is the rest of the
sweep — **every remaining part**, each with a named requester, a last real use,
and a decision. Two were cut. The other four are recorded here so that "we kept
it" is a measurement rather than an absence of one.

The survey is the deliverable. Deleting is easy to record; keeping is not, and
an unrecorded keep is indistinguishable from never having looked.

## The verdicts

| Part | Lines (src + test) | Named use | Verdict |
|---|---|---|---|
| In-flight store | 225 + 282 (+18 in `timeouts.ts`) | **none** | **Deleted** — [ADR-0029](../adr/0029-the-in-flight-store-is-deleted.md) |
| `vetoed` status + judge vocabulary | ~40 across 4 files | **none** | **Deleted** — [ADR-0030](../adr/0030-the-vetoed-status-leaves-the-vocabulary.md) |
| `packages/knowledge` | 1,102 + 929 | `fleet ask`; run-time injection | Kept — see below |
| `packages/intake` | 348 + 138 | `fleet draft`; gate 2 at N=30 | Kept — see below |
| `ONRAMP.md` + fixtures | 73 + 202 | the public repo's skeptic path | Kept — see below |
| Cloud-mode remnants | 2 schema fields | 2 archived rows | Kept — settled by ADR-0027 |

## The two cuts

Both have their own ADR. In summary: the in-flight store's only reader was
deleted the previous commit, and the `vetoed` status turned out to have **zero**
instances in the archive despite ADR-0025 keeping it on the claim that the
archive held "a real `vetoed` run."

The second finding is the more useful one. ADR-0025 was written four days after
the judge's deletion and stated a fact about the ledger that the ledger
falsifies. It was checkable in one command at the time and was not checked. That
is the same failure shape [the step-2 pass](../2026-08-05-step-2-the-delete-step-over-nine-adrs.md)
found in the ADR audit — *a factual claim about a record, made without opening
the record* — recurring in a new place.

## The three keeps, and what would change each

### `packages/knowledge` — 2,031 lines

**Who asked:** [ADR-0006](../adr/0006-pre-compiled-knowledge-layer.md).

**Last real use:** the `ask` seam is reachable today (`fleet ask`,
`packages/cli/src/index.ts:187`) and is the half with a positive measured
signal. The run-time injection half is wired into the live path —
`run.ts:604` calls `injectKnowledge`, `run.ts:686` folds a preamble into the
agent's first prompt — and fires whenever a compiled artifact exists for the
target. (Line numbers as of this commit, which moved both: they are here to be
found once, not maintained.)

**The measurement that does *not* settle it:** zero of the 50 archived ledger
rows record anything about knowledge. That is because **no ledger field exists
for it**, not because it never happened. Absent means not recorded
([`CONTEXT.md`](../../CONTEXT.md)) — reading that zero as "never used" is
exactly the error this repo's own rule forbids. So the survey cannot conclude
from the ledger, and does not.

**Verdict: keep, unchanged.** ADR-0006 already decided this on better evidence
than a sweep has, and it decided it *against* the seam's own payback numbers:
the run-time half is recorded as measured and negative, with an explicit
instruction not to delete it on that evidence and not to claim it pays back
either. A sweep that overturns a live ADR on a weaker measurement is not
applying the algorithm, it is skipping step 1.

**What would change it:** the run-time injection half is the deletable part, and
what it needs is the field the ledger does not have. One boolean per row —
whether a preamble was injected — turns this from unanswerable into a count.
That is a build, so it waits on ADR-0024's freeze; it is named here so the next
thaw has somewhere to start.

### `packages/intake` — 486 lines

**Who asked:** the correction log serves gate 2's voiding rule
([ADR-0022](../adr/0022-gate-3-is-deleted-absorbed-by-gate-2s-voiding-rule.md)),
whose requirement was signed at **N = 30** rows on
[2026-08-05](../2026-08-05-step-1-requirements-named.md).

**Last real use:** `fleet draft` writes a row on every drafted task handed to
`fleet run` (`packages/cli/src/index.ts:358`). The log stands at **8 rows** — 2
`narrowed`, 6 `reviewed-unchanged`, 0 `unreviewed`.

**The honest finding:** the log is **write-only**. Nothing in the codebase reads
`fleet/correction-log.jsonl` back, and nothing counts it against
`GATE_2_DECIDABLE_AT`.

**Verdict: keep.** This is the one counter in the repo that is not "a schedule
for not deciding" in [ADR-0025](../adr/0025-the-judge-is-deleted-and-verify-is-the-last-gate.md)'s
sense, because the threshold was pre-registered and signed *before* the rows
accumulated, and the decision it feeds is named. Its reader is a human at N=30,
and `wc -l` is an adequate reader for a file that will be opened once. Building
a reader now would be building 8/30ths of the way to a decision nobody can take
yet.

**What would change it:** reaching 30 rows and not taking the decision. At that
point the log stops being evidence and becomes a habit.

### `ONRAMP.md` + `tasks/onramp/` — 275 lines

**Who asked:** the README's "Don't trust it. Check it." section, which is the
public repo's answer to a skeptic.

**Last real use:** unmeasurable directly. The repo is genuinely public, and its
GitHub traffic for the 14 days to 2026-08-06 reports **11 views from 2 unique
visitors**.

**Verdict: keep.** Two visitors is a thin number, but the carried cost is 275
lines of *prose and task fixtures* — no runtime, no schema, no branch in any
code path. The 10% rule targets carried complexity, and this part has none to
shed. It uses `demo-feed-service` throughout, so it also carries no scrub risk.

**The real finding here is not about size.** Nothing verifies the on-ramp. No
docs-drift test asserts its links resolve; no e2e test runs its commands. Its
three tasks are reachable only by explicit path, so a rename anywhere in the
quickstart would rot silently, and the first person to notice would be the one
skeptic it was written for. That is the same shape as
[the co-sign walk's](2026-08-04-walking-the-cosign-line.md) finding about
surfaces claiming more than the run proved, and it is unfixed.

## What the sweep did not find

No part was discovered that nobody could name a requester for. The two cuts were
both **already known** — one was named in ADR-0028's own "part this leaves
stranded" section, the other was a leftover of ADR-0025. The sweep's value was
not discovery; it was forcing the four keeps to produce a reason, and catching
that one of the two known cuts rested on a false claim about the archive.

## Add-back

Code only — the ADRs and this document are records, not add-back.

| | Lines |
|---|---|
| Removed | 931 |
| Added | 299 |
| Net | −632 |

**32%** — above the 10% target, and the composition explains why: 193 of the 299
added lines are `run.ts` re-emitted after its `try`/`finally` disappeared and
201 lines de-indented by two. That is the same code, not new code — a
whitespace-insensitive diff of that file is 2 insertions and 43 deletions.
Excluding the reindent, the real add-back is **106 lines against 931 removed —
11%**, and it is four things: the `unclassified` count the `vetoed` removal made
necessary, the `Object.hasOwn` guard and tests that make that count actually
true, the runId lock rescued out of a deleted e2e test, and corrected comments.

So this cut lands inside the target where the dashboard's did not. The part that
needed repair was not either deletion itself — it was the hole the second one
opened in the report's arithmetic.
