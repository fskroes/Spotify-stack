# Gate inputs are carried into verification only under an amendment

[ADR-0013](0013-verification-runs-on-the-shipped-artefact.md) put verification on
a tree reconstituted from the diff. This decides what that reconstitution does
with the part of the diff that touches the things doing the judging.

**When the diff edits a [gate input](../../CONTEXT.md#gate-input), the
verification tree takes that file from the base, not from the diff — unless the
task's `amends:` frontmatter names it.** The agent's edit still ships in the PR.
It simply does not get to be part of what proves itself.

There is no trigger condition, because there is no detection step. The rule is a
property of how the verification tree is built, applied on every run.

Resolves #118 under map #115, against the audit on #116 and the two independent
surveys on #117.

## Status

**Accepted** (2026-08-01). **Not implemented.** `amends:` does not exist in task
frontmatter, and no gate input is treated differently from any other file today.
Depends on [ADR-0013](0013-verification-runs-on-the-shipped-artefact.md), which is
also unbuilt: without a reconstituted tree there is nothing to carry a gate input
*into*.

The four-cell differential below is recorded as design, not as a commitment to
build it.

**This rule is built, and the paragraph above was stale before it was**
(2026-08-04), corrected in this marker rather than in place: this record has been
readable since 2026-08-01, so editing its prose would be the retconning [the
supersede rule](README.md) exists to prevent. There is no superseding record
either — the decision here is untouched, and a record that decides nothing is not
an ADR. Everything above stays exactly as written.

Two claims above are no longer true, and neither is the **decision**.
[ADR-0013](0013-verification-runs-on-the-shipped-artefact.md) shipped on
2026-08-03, so the reconstituted tree this rule had nothing to carry a gate
input *into* has existed since. As of 2026-08-04 `amends:` is task frontmatter
whose reason is required and must be non-empty; `constructVerificationTree`
holds an un-amended gate input at the base while carrying the rest of the diff;
and the reason travels to the PR header, to the verification summary the judge
reads, and to the ledger line (`amendments`, beside `heldGateInputs`).

What this record did *not* decide, the build had to: **which** files are gate
inputs. That set is a constant in the runner — what detection already reads, plus
one test-and-fixture convention — and
[ADR-0020](0020-the-gate-input-set-is-a-convention.md) carries the argument for a
convention over configuration, including why being wrong in either direction is
survivable and why the set is partial by construction. It disturbs nothing below.

Still unbuilt, and still deliberately: the four-cell differential, the red-first
predicate, and both halves of the holdout gate. Their sections are unchanged, and
[run status](../../CONTEXT.md#run-status-vs-verification-state) remains #119's.

## What an amendment is, and why it can be trusted

```yaml
amends:
  "tests/rate-limit.test.ts": the asserted bound is off by one
```

A glob-to-reason mapping. It is trustworthy for one structural reason: **task
files live in the control repo, which the agent cannot write.** The agent cannot
grant itself the licence, in the same way it cannot edit `scope`, `gates:`, or a
[registered verifier](../../CONTEXT.md#registered-verifier)
([ADR-0009](0009-registered-verifiers-live-in-the-control-repo.md)).

The reason string is required, and it is not decoration. The one failure mode
this design cannot mechanically prevent is an operator declaring amendments
reflexively to keep runs moving — the pattern GitHub documents when it advises
adding the agent as a ruleset bypass actor. A glob can be added without thought;
a justification cannot. The reason travels to the PR header and to the judge,
which is what makes the licence loud rather than merely recorded.

## Why not `scope`

`scope` was the obvious candidate and it cannot serve. A task scoped to `src/**`
*and* `tests/**` — the ordinary shape for a test-writing task — excludes nothing
that matters, so the permission would be granted by accident and invisibly.

Overloading `scope` with a stricter reading (a gate input must be named
explicitly rather than swept up by a wildcard) was also considered. Rejected: it
gives one term two meanings, and it makes the licence implicit again, recoverable
only by noticing the *absence* of a wildcard. Explicitness was the whole purchase.

## What happens to a legitimate test-fixing task

It declares an amendment, and its edits are carried and verified normally. That
question is the reason three of the surveyed mechanisms were rejected outright:

- **Restore unconditionally.** Aider's benchmark restores every test file from
  the original before running, making a weakening ineffective rather than
  detected. It also makes a legitimate test fix *impossible* — reverted before it
  is measured. Cheapest option on the table, and it deletes a task class.
- **Auto-`inconclusive`.** Any diff touching a gate input is unproven by
  construction. Its own author priced it as unacceptable when proposing it: a
  task whose job is fixing tests would be inconclusive forever. No prior art was
  found for it anywhere.
- **Deny list.** Cannot be `scope` inverted, because `stagedFiles` never sees the
  invisible tiers. It would have to live at the permission layer, and Claude
  Code's own documentation states deny rules "don't apply to arbitrary
  subprocesses that read or write files indirectly" — which is exactly the path
  the audit found, since `Bash(npm test:*)` is allowlisted and `scripts.test` is
  agent-writable.

## Why no differential check runs yet

**Red-first** — run the new gate against the pre-edit source and require it to
fail — is real prior art. Google's Passerine rejects a patch whose generated test
does not fail pre-patch; SWT-Bench formalises the predicate and measures it at
47.8% precision for 20% recall. OpenAI ships the inverse: revert the gate edits,
re-run against the shipped source. The inverse generalises to every gate input;
red-first needs a fail/pass semantic and so reaches only test-shaped ones.

Neither is built, and the reason is map #115's own standing test: *before
specifying a measurement, write down what you would do differently at a given
reading.* This ADR is barred from saying what any reading changes, because run
status belongs to #119 and must reconcile with #61's ruling that a blocking gate
makes declaring one dangerous. An instrument whose consequence is undecided is
the gauge nobody steers by.

Both predicates also mis-handle the exact case the amendment exists to serve. If
a test was simply *wrong* and the source was always right, red-first false-kills
it (the corrected test passes on old source, so there is no red) and the inverse
false-flags it (reverting the fix makes the old, wrong test fail on new source).

**The design, recorded so it need not be rediscovered.** When a differential is
built, it should record SWT-Bench's four cells rather than collapse them:

| new gate vs. base source | base gate vs. shipped source | Reading |
|---|---|---|
| red | green | clean fix, strongly evidenced |
| green | red | loosened assertion *or* a genuinely wrong test — ambiguous |
| green | green | the edit discriminates nothing |
| red | red | source and gate both moved; ordinary behaviour change |

Two known limits carry with it: a flaky gate makes any two-point reading a coin
toss and cannot be told from a signal, and red-for-the-wrong-reason (an import
error, a missing fixture) satisfies the predicate while proving nothing.

**Revisit trigger, written down rather than left to be noticed: if amendments
stop being rare, this decision is wrong.** The whole design rests on the declared
case being an exception a human reads.

## What this does not cover

Two independent taxonomies (PatronusAI TRACE, ImpossibleBench) collapse the
observed attacks to five shapes. This decision closes one and a half of them:

| Shape | Status |
|---|---|
| edit tests and fixtures | **closed** — not carried without an amendment |
| patch the harness | **split** — `conftest.py`-shaped files are gate inputs and closed; a stubbed library the framework imports is ordinary source and untouched |
| exit or skip before the assertion | **split**, the same way |
| defeat the comparison (`__eq__` overrides) | **untouched** |
| read the answer instead of computing it | **untouched** |

This is not a coverage gap that a longer path list would close. Shapes 4 and 5
and the surviving halves of 2 and 3 are changes to **ordinary source code** —
the thing the agent is employed to write — and no path-shaped mechanism can
distinguish a stubbed dependency from a legitimate one, in principle rather than
in this version.

That is a different defect, and `CONTEXT.md` now names it: this ADR closes
[moving the scoreboard](../../CONTEXT.md#moving-the-scoreboard); it does not
touch [playing to the scoreboard](../../CONTEXT.md#playing-to-the-scoreboard),
which is carried on #115 as unspecified.

## The holdout gate, both halves

Not adopted here; the rule governs gate inputs, and a holdout is a question about
check *supply*.

- **A check the agent cannot enumerate** — strong deployed prior art (SWE-bench's
  unseen tests, Multimodal's private split, SWE-Bench Pro's 858 held-out, Kaggle's
  private leaderboard). It is now **unblocked**: METR's finding that Opus 4.6
  reward-hacked in ~80% of attempts *when tests were hidden* — by instrumenting
  the scoring script and binary-searching the scorer — means a holdout is only
  meaningful given execution separation, which ADR-0013 supplies. It is also a
  smaller change than it looks: a disclosure setting on ADR-0009's registered
  verifiers, which the agent already cannot edit. It is deferred on **sequencing**
  — ADR-0009 is decided and unbuilt — not on value, and it is the leading
  candidate mechanism for *playing to the scoreboard*.
- **Rotated per run from a pool** — rejected on the record. Deterrence by
  unpredictability requires unpredictability the subject cannot model, and a
  finite, reused pool is learnable: the one adjacent rotating system has a
  published attack explicitly "robust to various forms of randomisation" for that
  reason, and the holdout-reuse literature (Ladder, Thresholdout) considered
  rotation and chose to keep the holdout **fixed**, restricting the answer
  instead. A rotating gate that returns a rich failure message leaks its own pool.
  No prior art exists in coding agents or ML evaluation — corroboration, not the
  argument.

Recorded as unresolved in the sources rather than adjudicated here: announcing
that unseen checks exist may deter, or may provoke reconnaissance. METR's
evidence points the second way.

## Consequences

- **Cost is zero on undeclared runs**, which is currently all of them. The
  reconstitution in ADR-0013 does the work; there is no extra gate execution.
- An amended gate input is a **loud** fact — named with its reason in the PR
  header, on the ledger line, and in what the judge reads.
- Nothing here changes [run status](../../CONTEXT.md#run-status-vs-verification-state).
  A diff that edits a gate input without an amendment is not killed and not
  blocked; its edit ships unverified. What that does to the recorded verdict is
  #119's, deliberately.
- `amends:` is a licence, not a mandate — the mirror of `gates:`, which asserts
  evidence and never grants anything
  ([ADR-0004](0004-verification-tri-state-and-mandated-gates.md)).
