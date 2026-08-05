# Step 2 run: the delete step over the nine QUESTION ADRs — 2026-08-05

The [step-1 audit](2026-08-05-step-1-requirements-named.md) marked nine ADRs
QUESTION and left the merging, demoting, and deleting to a separate step. This is
that step, run over 0002, 0005, 0006, 0007, 0011, 0012, 0016, 0017, and 0018.

**Result: nine of nine keep. Nothing was superseded and nothing was demoted.**

A delete step that deletes nothing is normally a dodge, so the finding is stated
with its evidence rather than asserted. Each record below is kept on one named
alternative that a reasonable engineer would propose again — not on the record
being nice to have. Shoot any single row down and that ADR falls.

## The nine, with the loser each one is kept for

| ADR | The audit's stated ground | The alternative that would be proposed again |
|---|---|---|
| 0002 model-usage evidence | "the rejected alternative is not recorded" | One `totalTokens` or `costUsd` ledger field — the obvious simplification, which loses cache categories, rail attribution, and resume provenance. Also: using zero, null, or omission for every missing fact, which collapses observed zero, unavailable, and not recorded. |
| 0005 operator drives the CLI over SSH | "an infra choice; unclear a live contender lost" | Let the desktop app reach GitHub directly. It is the shape most desktop tools take, it puts merge credentials in a desktop application, and it routes around the co-sign gate that deliberately has no `--force`. |
| 0006 pre-compiled knowledge layer | "a property list, not a fork with a loser" | Declining the bet entirely — recorded with the reference system on the other side of the decision. The run-time half is then **measured negative** on two targets. The record exists to stop both errors: deleting the injection seam on that evidence, and assuming the layer pays back because it exists. |
| 0007 per-run artifact archive | "overlaps the 0014/0020 neighbourhood" | Flat set only, disambiguated by ledger order. A same-task rerun then replaces the diff, verdict, and verify log of a run still awaiting review, and attribution becomes a guess exactly when two runs are in flight. |
| 0011 runner owns the judge's reads | "a corollary of 0003; merge or demote" | `--tools ""` on the CLI path — one flag, and both transports become identical today. |
| 0012 a pass reports only what it observed | "a coding convention, not an ADR-grade fork" | Inherit the prior pass's verification, marked stale. Strictly more information and honestly labelled, and it re-introduces the tri-state's own failure mode one field over: a fourth, weaker state that four surfaces must learn and then be trusted never to render green. |
| 0016 the tree blocks, an install is not a check | "could be a comment on the verifier's definition of check" | Detect the gate-input edit and refuse the run. The one option with a published result: EvilGenie implements exactly this rule, and in all six cases it caught, the solution was correct. |
| 0017 the in-session verify is the retry loop | "implementation detail dressed as a decision" | Delete the Stop hook as redundant. ADR-0013's own wording invites it, and the deletion takes with it the only retry a verification failure ever gets. |
| 0018 the local workspace is a checkout | "earns one CONTEXT.md line" | `git archive \| tar` — the idiomatic one-liner. It honours `export-ignore` in the target's `.gitattributes`, so a target that keeps tests out of release tarballs hands the fleet a workspace with no tests, and verification goes green on a tree missing the files it was meant to check. |

Two further constraints, independent of the merits above:

- **0011, 0016, 0017, and 0018 are cited by name** from `CONTEXT.md`, `CLAUDE.md`,
  or another ADR. Superseding one is not free; it moves the citation.
- **0017 supersedes a bullet of ADR-0013**, which is a KEEP. Deleting 0017
  reinstates a sentence that is wrong in the direction of a destructive deletion.
  ADR-0013 carries no back-link to it, so 0017 is the only place the correction
  lives.

Two merges were considered and are not available. Folding 0011 into 0003, and
0012's naming rules into a keeper, both require **editing an ADR that is not
falling** — which is the retconning the supersede rule exists to prevent. The
only clean shape is a new consolidating record superseding a KEEP, which is
outside this pass and buys no net reduction: it renames the document rather than
removing it.

## Where the audit was wrong, and the pattern in it

The audit's nine calls split cleanly, and the split is legible.

Its two most specific calls were **right about the content and wrong about the
disposition**: 0016 really does contain a definition of "check", and 0018 really
does earn a `CONTEXT.md` line (below). Both had been read.

Its five wrong calls share one shape: the stated ground is a **factual claim
about the document that the document falsifies**. 0002's rejected alternatives
are recorded — seven of them. 0006 has six considered options under a heading
that says so. 0007 does not mention gate inputs at all; its real neighbours are
0002 and 0005, which share its evidence seam and its reviewer allowlist. 0011's
first rejected option is an argument that it is *not* a corollary of 0003, and
the disanalogy is the load-bearing part. 0005 names four contenders.

Those five were judged from the index table — title and seam — and the index
table is the one artefact that cannot show whether a loser was recorded. That is
the method error, and it is cheap to avoid: the audit's own verdict column
demands a property only the body carries.

## What the pass did fix

`CONTEXT.md` had no entry for **workspace**, a term it used in six other
definitions. That gap is what the audit saw at 0018 and mislabelled as the ADR
being redundant. The term is now defined, including the distinction from the
verification tree, which ADR-0013 and ADR-0017 both turn on and which no glossary
line previously held apart.

The ADR stays. A glossary defines what a workspace *is*; it does not carry why
`git archive` was refused.

## What the pass could not fix

The nine records hold real padding, and it is not their count. Several carry
build logs — implementation status sections, staged status markers, "what
remains" notes — which is the *how the code works* class the repo's own
classification table sends nowhere. That prose is what makes twenty-two ADRs read
as too many.

It cannot be removed here. Editing it out is rewriting an ADR, which the repo
forbids, and superseding a whole record to shed a section deletes the loser with
it. **The lever is at authoring time, not at audit time.**

## Requirement B's instrument, unsigned

One ruling follows from the above and is **not taken in this doc**, because it is
a requirement change and requirements carry an owner's name:

> The ADR-per-merge ratio should be retired as an instrument. It measures
> documents against merges, but an ADR is written per fork, and forks arrive with
> design rather than with merges. A design-heavy period produces a high ratio and
> no defect. The replacement is already in `docs/adr/README.md`: keep the record
> if a reasonable engineer would choose differently and the code alone cannot
> tell them why.

Recorded here as a finding for the owner to sign or reject. Nothing in the repo
has been changed on its strength, and `docs/adr/README.md` is untouched.

No ADR was written for this pass. The standing condition — no ADR 23 before the
next shipped merge — is satisfied, and the ruling above still fails the
hard-to-reverse test: a criterion for writing records is re-decidable at the next
panel, and it belongs where the criterion already lives.

## What this doc does not do

It does not revise the step-1 audit. That document is a dated record of what was
believed on the day, its QUESTION column stands unrewritten, and the corrections
above are made here rather than there.
