# A pass reports only what it observed

A run's veto-retry loop repeats four phases — agent, scope, verify, judge. That
sequence is one [**pass**](../../CONTEXT.md#pass), implemented once in `runPass`
and looped by `run()`. A pass reports **only the facts it produced itself**: it
never pairs its own diff with an earlier pass's verification or verdict.

The related naming decisions: the four-phase unit is a *pass*, never an
*attempt* — an [attempt](../../CONTEXT.md#attempt) is one model invocation on one
[rail](../../CONTEXT.md#rail), so a single pass contains two — and only a veto
may seed another pass, which is enforced by `runPass` accepting a `VetoedPass`
and no other outcome.

## Why the invariant

The loop used to be written twice, and the two copies had to be kept in step by
hand. They were not: the retry never classified an empty diff, so an agent that
**reverted** its vetoed change reached `approved` with a zero-byte `diff.patch`
and a judge's approval of a change that no longer existed. That was a false
green — the one output this system may not produce
([ADR-0004](0004-verification-tri-state-and-mandated-gates.md)) — reachable by
forgetting to duplicate one branch.

De-duplicating the sequence removes that class of drift, but it forces the
question the duplicated code answered only by accident: when a pass dies, which
of the *previous* pass's facts belong on the record? The answer has to be a rule,
because every plausible answer looks reasonable in isolation and only one of them
cannot manufacture a false green.

## Considered options

**Inherit the prior pass's verification silently** ("last known state"). The
simplest type — no optionality to reason about — and rejected outright. Pass 1
verifies diff A green; the judge vetoes; pass 2's diff B breaks scope. Recording
A's green beside B is a claim that something verified a change nothing verified.
That it reads as *more* information is exactly what makes it dangerous.

**Inherit it, marked stale** (a `stale` flag, or the verified diff's sha). Strictly
more information than we keep today, and honestly labelled. Rejected because it
adds a fourth, weaker verification state that every one of the four rendering
surfaces would have to learn and then be trusted never to render as green — the
tri-state's own failure mode, re-introduced one field over. ADR-0004 already
notes that the tri-state is only as good as the surfaces that read it (#66).

**Report nothing at all when a pass ends early.** The strict reading, and wrong on
one path: when the *agent invocation itself* throws, the pass never reached the
workspace, so the change the previous pass verified and judged is still precisely
what is staged there. Diff, verification and verdict continue to describe the
same change, and reporting nothing would call a dirty workspace clean. So the
rule is keyed on **whether this pass reached a diff of its own**, not on whether
it ended early.

## Consequences

- A pass that dies at scope, at verify, or at its own judge carries no earlier
  facts. `composedVerifyState` then returns `undefined`, which the ledger records
  as *nothing known* — never as green.
- A pass whose agent call threw carries the prior pass's diff, verification and
  verdict, because those three still agree with the workspace. This is the single
  exception, and it is commented at the site.
- **An `ended` pass carries no verdict of its own, ever.** If it had one it would
  be `approved` or `vetoed`. This fixed a real defect: a judge failure on a retry
  used to record the *previous* pass's veto beside the current pass's diff.
- One empty-diff rule applies to every pass — sentinel declared → `no-changes`,
  otherwise `agent-failed`. A revert after a veto is therefore recorded as a
  failure to correct, and the veto that caused it stays on the run's record.
- Retry policy lives in `run()` alone. A pass does not know `maxJudgeRetries`,
  which is why it cannot decide whether its own veto is the final one — and why
  the loop, not the pass, names the verdict artifact.
- The inflight record's ordinal is `pass`, not `attempt`. Renaming a wire field
  was affordable exactly once: inflight records are ephemeral per-PID files
  cleared when a run becomes durable, so there was no history to be tolerant
  about ([ADR-0001](0001-tolerant-reader-wire-contract.md) is untroubled here).
