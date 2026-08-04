# A gate input the base never had is carried, and a tree that equals the base is inconclusive

[ADR-0014](0014-gate-inputs-are-carried-only-under-an-amendment.md) decided that
an un-amended [gate input](../../CONTEXT.md#gate-input) is taken from the base
rather than from the diff. Building it required a second answer that record did
not give: what the tree does with a gate input **the base does not have**. The
build answered *delete it* — "a gate the change brought with it is not a gate it
inherited". Two decisions replace that answer.

**1. A gate input absent from the base is carried into the verification tree and
runs.** There is nothing to hold it at, and a file the base never had cannot have
been weakened. No amendment is required, because there is no licence to grant.

**2. When every path in a diff is held, so the verification tree equals the base
commit, verification is `inconclusive` and never `passed`.** The checks ran on
code containing no part of the change. That is
[ADR-0004](0004-verification-tri-state-and-mandated-gates.md)'s existing third
value, arriving by a third road.

**What is superseded is the build's answer, not ADR-0014's.** That record never
decided the added-file case — read it and the question is simply absent, which is
why this one exists rather than an edit to it. The rule ADR-0014 *did* decide —
an un-amended edit to a gate the base carries is judged by the base version — is
untouched, and it is the half that works.

Decision 2 lands in ADR-0004's territory and not in #119's. ADR-0014 deferred
what a hold does to the recorded **run status**, and that deferral stands
unchanged: a run here still ships `approved`, exactly as a run with an unmet gate
does. What changes is the **verification state**, which was ADR-0004's all along.

## Status

**Accepted and built** (2026-08-04). Both halves ship in
`packages/runner/src/gate-inputs.ts` and `verification-tree.ts`.

`RUN_STATUSES` is unchanged and stays at seven — #119's decision, reasoned on the
record, is not reopened here. Decision 2 needed no new status precisely because
the tri-state already had the value for it.

## What the evidence was

Three observations, and the decision follows from what they disagree about.

**The rule works, on edits.** The hermetic e2e fixture is the case the rule
exists for: one patch removes a check from the source *and* rewrites the
assertion that would have caught it. The tree takes the test from the base, the
base assertion runs against the shipped source, and the run dies `verify-failed`
(`packages/runner/test/e2e.test.ts`, the un-amended and amended pair). Nothing
about that depends on the deleted-file branch.

**On additions it protects nothing, and costs everything.** A live mock-engine
run on 2026-08-04 (ledger `15ebcd28`, task `probe-0014-hold`) produced a diff of
exactly one *new* test file. Every path was a gate input, none was amended, so
the tree deleted the only file in the diff and became byte-identical to the base.
The base suite ran, passed in 0.1 s, and the run shipped `approved`. The PR
header said three times that the file was not part of what proved the change, and
the judge — which received the same note in its verification summary — approved
without mentioning it, having read two files that were not the file under review.
The entire defence was one human reading one header line.

**And it is the common shape, not an edge case.** The
[2026-08-04 history measurement](../experiments/2026-08-04-the-gate-input-convention-against-history.md)
found the test-directory globs hold **newly added** test files on 25 of one
target's holding commits and 9 of the other's. That document also named the
reading problem in advance: *"held at the base" reads as "an older version was
used", and for an added file it means "this file was not there"*.

## Why deleting the branch is not a weakening

The anti-tamper property lives entirely in the edit branch. Stated as the
question the tree asks: *does the shipped source satisfy the gate the agent
inherited?* An added file is not a gate anything inherited, so it is not part of
that question, and removing it from the tree answers nothing.

What an agent can still do is add a test that asserts nothing and passes. That
was true before this record and is unchanged by it, because a vacuous new test
makes no *other* check pass — the inherited suite still runs in full, from the
base, on the shipped source. It is
[playing to the scoreboard](../../CONTEXT.md#playing-to-the-scoreboard), which
ADR-0014 already places outside its own reach and #115 carries as unspecified. No
path-shaped rule distinguishes a weak new assertion from a strong one; only
reading it does. So the deletion gives up protection this rule never supplied.

It is reported rather than left silent, and that is the whole of what replaces
it: the judge's summary names the added gate inputs and asks what they assert,
and the PR names them in "what actually ran". Not as a warning — nothing is
outstanding, the files ran — but as the fact that part of the evidence arrived
with the change.

## Rejected alternatives

**Keep deleting, and fix the judge's prompt instead.** The judge did read the
note and approve anyway, so a stronger instruction is the obvious repair. It
optimises a thing that should not exist: it spends the judge's attention on a
tree that is deliberately missing the change, and it leaves the vacuous green in
place for every run whose judge is unavailable, cheap, or simply wrong. Fix the
tree first; the note becomes rare and meaningful, and *then* the judge's handling
of it is worth measuring.

**Require an `amends:` for an added gate input.** Consistent-looking, and it
inverts the licence: `amends:` declares that a task may change *the files that
judge it*, and a file that does not exist yet judges nothing. It would also make
the amendment the rule rather than the exception for any task that adds a test —
which is most of them — and ADR-0014's own revisit trigger says that if
amendments stop being rare, the design is wrong.

**Auto-`inconclusive` for any diff that touches a gate input.** ADR-0014
considered exactly this and rejected it, and the rejection holds: a task whose
job is fixing tests would be inconclusive forever. Decision 2 is not that option
narrowed — it is a different predicate. It does not ask whether the diff *touched*
a gate input; it asks whether anything of the change reached the tree at all. A
test-fixing task under an amendment is verified normally, and one that adds a new
test is now verified normally too. The predicate fires only when the checks
observed literally nothing, which is the case ADR-0004 already names.

**An eighth run status for "verified nothing".** Rejected on #119's record, which
decided `RUN_STATUSES` stays at seven, and unnecessary on ADR-0004's: a check
that ran and observed nothing about the change is `inconclusive` by the
definition already written. The tri-state exists exactly so this case does not
need new vocabulary.

**Kill the run when the tree equals the base.** Tempting, and wrong for the
reason ADR-0004 gives about blocking gates: what is unproven is the verification,
not the run. The diff is not necessarily bad — a task that legitimately edits
only test files produces this shape — and killing it deletes the task class the
amendment exists to serve. `inconclusive` says the true thing and lets a human
decide, and every co-sign affordance over an inconclusive run already carries the
warning.

**Detect "tree equals base" by comparing the tree to the commit.** A direct
observation would be stronger than an inference, and it cannot be made reliably:
the tree carries installed dependencies, so `git status` there answers a question
about `.gitignore` as much as about the diff. The path-set derivation is exact
instead — after decision 1 every held path is in the base and is restored to it,
so "every path was held" *is* "the tree is the base" — and it is computed before
the tree is built, from the diff's own paths.

## Consequences

- **`holdAtBase` gets smaller, and the base question moves to the caller.** The
  tree now restores and never removes; `decideGateInputs` asks git which paths
  the base has (`pathsInBase`) and returns a three-way decision. The tree is
  handed an answer instead of computing one, and a path in `hold` that the base
  does not carry is now a loud caller bug rather than a silent deletion.
- **A red on a tree that equals the base stays `failed`.** Only a pass is
  rewritten. A red there is a red about the base, and reporting it as a failure
  kills the run — the direction that cannot manufacture a green.
- **Nothing new is written to the ledger.** `heldGateInputs` and `amendments`
  record what went unproven and what was licensed; an added gate input is
  neither, and giving that section a third meaning would cost more than the fact
  is worth. The run's `verifyState` already carries the consequence that matters.
- **The degenerate case is now narrow and real.** It needs a diff of nothing but
  edits to gate inputs the base already has, with no licence. That is a task
  which should have declared `amends:`, and the run now says so instead of
  shipping a green.
- **ADR-0020 is undisturbed.** *Which* files are gate inputs is still a
  convention in the runner and still not per-target configuration. This record
  changes what the tree does with one class of them, not how the class is
  recognised.
