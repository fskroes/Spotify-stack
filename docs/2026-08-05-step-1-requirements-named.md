# Step 1 closed: the two loose requirements, named — 2026-08-05

Panel session (Musk step: make the requirement less dumb). Two requirements
were under attack. Both now carry a name and a written form. Neither did
before this date — the first grep for "tens of rows" across `docs/`,
`CONTEXT.md`, and `fleet/` returned zero hits. A requirement that lives only
in conversation is folklore; this doc ends that state.

Owner of every requirement below: **Fernando Silva Kroes**. Re-chosen, not
inherited.

## Requirement A — gate 2's row count

The old form: "gates 2 and 3 need tens of rows." Unsigned, unwritten, and
"tens" was a comfort number.

The new form:

> Gate 2 changes one decision: is the correction log's `unreviewed` rate low
> enough to trust class-level co-sign automation, or is the instrument broken
> (the phrase `packages/intake/src/correction-log.ts` itself uses)?
> That decision flips at **N = 30 rows**, because 30 is the smallest sample
> where zero `unreviewed` observations bound the true unreviewed rate below
> 10% at 95% confidence (rule of three: 3/N).

The 10% detectable rate is itself a signed choice. If the tolerance changes,
recompute N from the rule of three — do not re-grow the number by comfort.
At a 20% tolerance, N ≈ 15.

Gate 3 inherits the same discipline: no row count for it exists until it is
written here with a decision it flips.

## Requirement B — the ADR-per-merge ratio

22 decision documents against 5 shipped merges. Each one was required by the
same person who signs this doc. The audit below re-chooses each: **KEEP**
means a real losing alternative that would bite again; **QUESTION** means the
record smells like an implementation detail or a corollary, and is a
candidate for merging, demotion to a `CONTEXT.md` line, or a comment in
place.

| ADR | Verdict | Reason |
|---|---|---|
| 0001 tolerant-reader wire contract | KEEP | The strict-schema alternative breaks on any field the other side adds first. |
| 0002 model-usage evidence contract | QUESTION | Reads like "log usage"; the rejected alternative is not recorded. |
| 0003 runner owns git | KEEP | The cage boundary; a real security alternative lost. |
| 0004 verification tri-state | KEEP | Names the boolean alternative and why both directions of the lie are unacceptable. |
| 0005 operator drives CLI over SSH | QUESTION | An infra choice; unclear a live contender lost. |
| 0006 pre-compiled knowledge layer | QUESTION | A property list, not a fork with a loser. |
| 0007 per-run artifact archive | QUESTION | Real fork, but overlaps the 0014/0020 neighbourhood. |
| 0008 one status→facts table | KEEP | Rejects "a switch per surface" — surface drift is real. |
| 0009 registered verifiers in control repo | KEEP | The alternative has a trust consequence for the public/private split. |
| 0010 scrub denylist is the leak | KEEP | Load-bearing for rule #1 of the repo. |
| 0011 runner owns judge's reads | QUESTION | A corollary of 0003; merge or demote. |
| 0012 pass reports only what it observed | QUESTION | A coding convention, not an ADR-grade fork. |
| 0013 verification on shipped artefact | KEEP | The workspace-verify alternative produces false confidence. |
| 0014 gate inputs carried only under amendment | KEEP | Named load-bearing in CLAUDE.md; a real alternative lost. |
| 0015 kill retained forever, blinded | KEEP | A real retention-vs-deletion tradeoff. |
| 0016 tree blocks, install is not a check | QUESTION | Could be a comment on the verifier's definition of "check". |
| 0017 in-session verify is the retry loop | QUESTION | Implementation detail dressed as a decision. |
| 0018 local workspace is a checkout | QUESTION | Earns one CONTEXT.md line. |
| 0019 shipping run based on what it ships against | KEEP | The task-creation-time base has a correctness consequence. |
| 0020 gate-input set is a convention | KEEP | Per-target config rejected for drift reasons; named in CLAUDE.md. |
| 0021 gate input the base never had is carried | KEEP | A real failure mode if decided the other way. |

Count: 12 KEEP, 9 QUESTION.

## What this doc does not do

It does not merge, demote, or delete anything. That is the next step of the
algorithm (delete the part), taken separately and only from this recorded
list. Per the repo's own rule, a QUESTION ADR that falls is superseded with a
link back, never rewritten.

Standing rules adopted from this session:

1. A requirement with no name attached does not survive the next panel.
2. No ADR 23 before the next shipped merge to a fleet target.

## Addendum, same date — the threshold grilled

A follow-up session walked requirement A's edges. Three rulings, same owner:

1. **One `unreviewed` row voids the zero-failure form.** Nothing restarts and
   no window slides — flushing a failure with more waiting is the comfort
   arithmetic this doc forbids. A failure is data: the panel reconvenes on the
   number (rule of three with one failure gives N ≈ 47), and the new N is a
   signed choice again.
2. **Every row the current three-outcome instrument produced counts.** The
   instrument did not change on the signing date; only the requirement's
   wording did. State at this addendum: 2 of 30 rows, both clean.
3. **Thirty clean rows makes the automation decidable, not decided.** The
   decision is taken separately, signed, as an ADR — and it queues behind the
   next shipped merge per standing rule 2. It may still come out "no" for
   reasons the row count cannot see.

The session also considered, and deleted, a `fleet report` line showing the
count: tooling for a two-row file consulted at panel cadence is process added
before the process has been exercised (the algorithm's step 2). The count is
read by hand until the ruling-3 ADR creates an ongoing need for a surface. The
number itself lives once in code, as `GATE_2_DECIDABLE_AT` in
`packages/intake/src/correction-log.ts`, beside the outcomes it counts.

## Second addendum, same date — gate 3 deleted

Gate 3's discipline sentence in Requirement A is superseded by
[ADR-0022](adr/0022-gate-3-is-deleted-absorbed-by-gate-2s-voiding-rule.md):
gate 3 is deleted as provably subsumed by ruling 1 above, phase two's price
is restated as gates 1 and 2, and gate 2's enlarged scope is re-owned there.
The sentence itself stands unrewritten, per this repo's supersession rule.
