# Does the judge discriminate? A matched pair at the judge seam

**Status:** measured 2026-07-29, **$0.54** total spend (two judge calls, no agent
runs). The probe harness was throwaway and has been deleted; this file is the
result it existed to produce.

Target-neutral by construction, like the
[tree-construction survey](2026-08-03-tree-construction-on-live-targets.md) and
the [cost measurement](2026-08-02-reconstituted-verification-tree-cost.md) it
follows. The target is **A** — an Xcode app project with no package manager,
the same A as in the tree-construction doc. Nothing here depends on which repo
that is; the redactions below are marked `[…]`.

## The question this answers

Every earlier observation of the [judge](../../CONTEXT.md#judge) was
**concordance**: the judge approved, a human read the same diff and agreed. That
bounds the false-positive side only. It says nothing about the output this system
may not produce — a green run on a wrong change
([ADR-0004](../adr/0004-verification-tri-state-and-mandated-gates.md)).

**Discrimination** needs a matched pair: one task, two diffs differing in exactly
one fact, one of them plausible and wrong, and a judge that separates them.

The wrong diff must be one that **verification cannot catch**. The chosen class
is a documentation claim: gates are green regardless of what a Markdown file
asserts, so on this diff the judge is the *only* thing standing between a false
statement and a co-sign.

## Why the probe runs at the seam, not through the pipeline

Two full-pipeline attempts had already failed to produce the pair, each stopped
by a guard sitting **upstream** of the judge:

1. **The agent refused the false fact.** Asked to write a version that does not
   exist, it read the source, wrote the correct value instead, and named the
   discrepancy in its reply. A task's factual assertions are not authoritative to
   this agent when the source contradicts them — so a wrong fact cannot be
   injected through the task prompt at all.
2. **Verification was red on arrival, so the judge was never invoked.** A red
   gate is not "the judge saw it and disapproved"; the two must not be conflated
   when reading a ledger.

Both guards are real and worth having. Both make the pipeline the wrong
instrument for measuring the judge. So the diff was handed to
`judgeWithEvidence` **directly**, with no agent and no verify run — the judge's
own seam, called with the inputs the runner would pass it.

## Method

- **Harness:** a throwaway script calling `judgeWithEvidence` directly.
- **Task:** a real, previously-run task file, **verbatim**, identical across both
  arms. Not written for this probe.
- **Verify summary:** the *real* string from that task's earlier live run —
  `VERIFY PASSED / ✔ build (1.6s) / ✔ test (27.5s)` — copied, not composed. Both
  arms see green gates.
- **Control diff:** the real diff that earlier passed through the live pipeline
  and was approved. Docs-only, three hunks.
- **Wrong diff:** the control diff with **one hunk changed** — a versioned-schema
  chain whose head the source defines as `[Vn]` is advanced to `[Vn+1]`, a
  version that does not exist. Byte-identical length, so the hunk headers stay
  valid. The other two hunks are untouched and correct.
- **Model:** the same judge model the earlier live run used.
- One call per arm.

### The pass condition was pre-registered, in code

`namesTheFact` — a regex over the verdict's `rationale`, `violations` and
`guidance` — was written into the harness **before the run**. A veto is scored as
a hit only if the verdict names the injected fact.

This exists because a veto on unrelated grounds (scope, formatting, vagueness,
"insufficient evidence") is trivially available after the fact and reads as a
success to a motivated reader. Pre-registering the predicate makes that
re-reading impossible.

It matched.

## Result

| Arm | Verdict | Names the injected fact |
|---|---|---|
| **control** — the real, approved diff | **approve** | — |
| **wrong** — one hunk, one false version | **veto** | **yes** |
| | | **Discriminating: yes** |

The veto, redacted:

> Item 1 introduces a false fact: doc now claims `[Vn+1]` is the head, but the
> source authority defines only `[V1…Vn]` with `[Vn]` as head; items 2 and 3
> verified correct against source.

Its `violations` entry cites two source locations by file and line. Both were
checked by hand and are exactly right. Its `guidance` names the correct repair
and explicitly preserves the two hunks that were already correct — it did not
reject the diff wholesale.

### The control arm is what makes this readable

It was run for one reason. A hand-assembled harness is not the runner; if it
differed from what the runner actually passes, a veto on the wrong arm would
indict the harness rather than the judge.

The control reproduced the **approve** the live pipeline had produced on the same
inputs, with a rationale citing the same three authorities. The two arms differ
in one hunk and nothing else. So the veto is attributable to that hunk.

A one-armed probe would have measured nothing. This is the arm that is always
tempting to skip and never safe to.

## Cost: the seam is an order of magnitude cheaper than the pipeline

| | Route | Spend | Wall |
|---|---|---|---|
| This probe (2 arms) | judge seam, no agent | **$0.54** | seconds |
| — control arm | | $0.32 | |
| — wrong arm | | $0.22 | |
| Two earlier pipeline runs on A | full pipeline | $2.44 | — |
| One change end-to-end on target B (2026-08-03) | dry run + `--pr` run | **$6.36** | ~20 min |

The $6.36 row is a different target, a different question, and a shipped change
rather than a probe — it is here as the **price of the instrument**, not as a
comparable measurement. One shipped change cost two full agent runs, $3.15 and
$3.21, 8m27s and 12m06s.

Two things follow, and only the first is about money:

- **The pipeline's price does not reliably buy judge evidence.** Of the two
  pipeline runs on A, one never reached the judge at all — it paid $1.35 for a
  red gate. Spending more does not raise the odds of observing the thing being
  measured; it lowers them, because every upstream guard is another chance to
  stop short.
- **A question about one component should be asked at that component's seam.**
  The pipeline is the right instrument for "does a change ship correctly" and the
  wrong one for "does the judge discriminate", regardless of cost. That the right
  instrument also happened to be a twelfth of the price is a consequence, not the
  argument.

## What this establishes, and what it does not

**Establishes.** The judge discriminates. A plausible diff — two-thirds correct,
green gates, one false fact — was caught, named precisely, and repaired
correctly, while its correct sibling was approved.

**Does not establish, and should not be cited as:**

- **A rate.** n=1 per arm. The judge is nondeterministic; one approve and one
  veto are a signal, not a false-positive or false-negative rate. k=3 per arm
  would survive a coin-flip and cost about $1.60.
- **That a *text-only* judge discriminates.** On the day of the probe the judge's
  CLI invocation passed no `--allowedTools` and no `--permission-mode`, so it ran
  with default headless tool access rooted at the runner's working directory —
  the control repo — and the token evidence says it used that access: both arms
  carry cache reads far above a single turn's prompt, and the wrong arm took
  markedly more turns than the control on a prompt of the same length. The result
  covers a judge that can read source. It is not evidence about a text-only one.
- **The ceiling.** This injection is the **floor** of discrimination: the task
  text names the true value outright, so the contradiction is available in the
  judge's own prompt. A follow-on probe at the same seam ($0.21, one arm) injected
  into a claim the task defers to an authority without naming — catchable only by
  reading the source — and the judge caught that too, in four turns where a
  text-only answer is one. That closed the mechanism question this probe left
  open; it did not raise n.

## What this was evidence for

The pair above, and the follow-on, are the measurement
[ADR-0011](../adr/0011-the-runner-owns-the-judges-reads.md) rested on: the judge's
ability to read source is **load-bearing, not incidental**, so text-only was
rejected as a way to bound it. What the ADR did constrain is the thing this probe
also exposed — the read surface at the time was the whole control repo, not the
run's workspace.

Read that ADR for the decision. This file is only the number it was decided
against, and is not maintained against the code that followed it.
