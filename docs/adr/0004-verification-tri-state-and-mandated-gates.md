# Verification is a tri-state, and a gate asserts rather than instructs

Two decisions that only make sense together.

**1. Verification ends in `passed`, `failed`, or `inconclusive`** (`VerifyState`),
never a boolean. `inconclusive` means *nothing proved anything* — either no
verifier was detectable in the repo, or a check the task demanded never ran.

**2. A task's `gates:` frontmatter names checks that must have run** for its
verification to count. A gate is an assertion about evidence, not an instruction
to the fleet. It never supplies a check the fleet could not already run.

Definitions are in [`CONTEXT.md`](../../CONTEXT.md#verification-state); this
record holds the alternatives.

## Why not a boolean

A boolean cannot express *nothing ran*, so it has to lie in one direction. Both
directions were unacceptable:

- **`true` when nothing ran** — a repo with no detectable verifiers renders as
  green. This is the single most dangerous output the system could produce: a
  co-sign button that says "verified" over a run nothing checked. It is a false
  claim the fleet has not earned, and it is invisible precisely where the risk is
  highest (a new target, first run, no test harness yet).
- **`false` when nothing ran** — turns every unverifiable repo into a failure and
  blocks legitimate on-ramp tasks, whose entire purpose is to *establish* the
  harness a later task can be gated on.

The tri-state costs one extra branch on every rendering surface. That was judged
cheap against a false green.

A related rejected shortcut: **inferring the state by string-matching the
verification summary prose**. Every surface reads the field
(`VerifyResult.state`, or the ledger line's `verifyState`) precisely so prose
edits can never silently change a verdict. A missing field on an old ledger line
means *not known*, which must never render as green.

## Why gates assert instead of instruct

The tempting design is `gates: [test]` meaning *make sure a test check exists and
run it*. Rejected: that turns a task declaration into a capability request, and
the runnable set is a function of *(repo shape, host platform)* — knowable only
at detection time, not at authoring time. A task cannot conjure `xcodebuild-test`
onto a Linux runner.

So the vocabulary is deliberately **open, with no registry**. Any string is
legal. The direct consequence — accepted, not overlooked — is that a **typo and
a deliberately unrunnable mandate are indistinguishable**. Both produce a loud
unmet gate and an `inconclusive` verification. Neither can produce a false green,
which is the only property that had to hold.

The alternative of validating gate names against a fixed registry was rejected
because the registry would be wrong on any host or repo shape the fleet had not
met yet, and a task would fail to *validate* rather than fail to *prove*.

## Why an unmet gate does not block the run

An unmet gate leaves [run status](../../CONTEXT.md#run-status-vs-verification-state)
alone: a good diff with an unmet gate still ships as `approved`, carrying
`unmetGates` by name to every surface.

Blocking was considered and rejected on an incentive argument: if declaring a
gate can kill your run, authors stop declaring gates, and the feature deletes
itself. The proposition has to be **cheap to declare, loud when unmet**. What is
unproven is the verification, not the run — which is also why run status and
verification state are two orthogonal fields rather than one merged verdict.

## Consequences

- The composition — folding mandated gates into the recorded state — lives in
  the runner, because only the runner holds both halves. `mcp-verify` stays
  task-blind: it answers "what does this repo offer, and did it pass", nothing
  more. Do not teach it about tasks.
- A `skipped` check does **not** meet a mandate. It was detected and never
  reached, which is exactly the "did not run" case the tri-state names.
- Surfaces must distinguish three absences: no gates declared, all gates met,
  and *field not recorded* (a pre-tri-state ledger line). Only the first two are
  assertions that nothing was outstanding.
- Every co-sign affordance over an `inconclusive` run carries the warning. A
  merge dialog that says "verify green" for such a run is a bug, and has been
  one (#66) — the tri-state is only as good as the surfaces that read it.
