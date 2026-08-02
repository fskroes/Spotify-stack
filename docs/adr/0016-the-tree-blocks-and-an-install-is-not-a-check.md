# The reconstituted tree blocks, and an install is not a check

[ADR-0013](0013-verification-runs-on-the-shipped-artefact.md) moved verification
onto a tree reconstituted from the diff, and
[ADR-0014](0014-gate-inputs-are-carried-only-under-an-amendment.md) decided what
that tree does with a gate input. Neither says what the tree *already decides* as
a consequence. This records three such consequences, found by reading the
detector before building any of it.

They share a shape: each is invisible until someone starts the build, and each is
one an implementer would plausibly "fix" in the wrong direction.

Resolves #119 under map #115.

## Status

**Accepted** (2026-08-02). **Not implemented, and not separately implementable.**
Every rule below is a property of the reconstituted tree, so all of it ships as
part of ADR-0013's build or not at all. Nothing here may go ahead of it — see
*Why none of this ships early*.

## 1. The gate-input rule already blocks, and `verify-failed` is how

#119 asked whether the rule blocks, which run status it would take, and whether
blocking reopens #61. The
question presumes a decision point the design does not have: ADR-0014 states that
there is no trigger condition because there is no detection step. Nothing is
evaluated, so nothing can hang a status off it.

What the tree does instead falls out of construction:

| | Verification tree | Outcome |
|---|---|---|
| Unamended, source did not move with the gate | base gate vs. shipped source | green, and earned |
| Unamended, source moved with the gate | base gate vs. shipped source | **red → `verify-failed` → killed** |
| Amended | gate carried | verified on its merits; the licence is loud |

Row 2 is the finding. **The rule blocks, through the ordinary red path, with no
new machinery and no new status.** ADR-0014 knows this shape — it is the OpenAI
inverse predicate it declined to build, and it notes that the inverse
false-flags a genuinely wrong test — but it discusses it only as a property of a
differential it deferred, never as the permanent behaviour of its own default
tree.

So a forgotten amendment is not a quiet loss of proof. It is a kill.

### Why this does not disturb #61

#61 ruled an unmet mandated gate non-blocking because *a blocking gate makes
declaring one dangerous and the field would die of disuse*. That reason is sound
and it is untouched here, because the two conditions are different in the way
that matters to it: an unmet gate is an **absence** — a check the task demanded
and nothing ran — while a gate held at the base **ran**. Nobody declares "I
edited a gate input", so there is no field to discourage into disuse.

**#61 is linked, not superseded.** Its conclusion stands and its reasoning stays
correct for its own case. Replacing that reasoning with this record's — as was
proposed — would be a category error: there is no gate to hold at base when the
gate never ran, so the argument here cannot reach #61's case at all.

### Why not detect the gate-input edit and refuse the run

The instinct, and the one option with a published result. EvilGenie
([arXiv:2511.21654v2](https://arxiv.org/abs/2511.21654), §5) implements exactly
this rule — flag any edit to or deletion of the test files — and reports what it
caught (§4.2): in six cases Gemini deleted `test.py`, and **in all six the
solution was correct**, the deletions being cleanup of its own scratch files. A
hard block on that signal would have failed six correct runs. Its accurate
instrument was an LLM judge over the solution code, not the diff-shape heuristic.

ImpossibleBench ([arXiv:2510.20270](https://arxiv.org/abs/2510.20270), §5.2) is
the only source that ablates block-vs-allow, and its recommended middle path —
"read-only" — is implemented by reverting the modified tests during scoring.
That is reconstitution, which is what ADR-0013 already built toward.

### Why not an eighth `RunStatus`

`RUN_STATUSES` (`packages/contract/src/schemas.ts`) stays at seven. Both outcomes
already have honest homes — `verify-failed` for row 2, `approved` for rows 1 and
3 — and a status naming a condition nothing computes would be a consequence
without a signal, the mirror of the *signal without a consequence* ADR-0013
rejected detection for. `RUN_FACTS`' `satisfies` would demand facts for a state
the runner never reaches.

### Why not auto-`inconclusive`

Already rejected in ADR-0014, and now redundant. `inconclusive` annotates an
unearned green; the tree makes the verdict genuine instead. Hedging a real
verdict is strictly worse than producing one.

## 2. The tree manufactures a false green, so an install stops being a check

`npmChecks` emits `npm-install` only when `node_modules` is absent
(`packages/mcp-verify/src/verify.js`). A reconstituted tree is a clean checkout,
so it is **always** absent. And `runVerify` records `inconclusive` only when the
check list is empty.

Compose those and a `package.json` repo with no `lint`, `typecheck` or `test`
script gets exactly one check — the install — which succeeds and records
**`passed`**. A green earned by installing dependencies. After ADR-0013 such a
target can never be `inconclusive` again.

`detect()` already refuses to gate a *nested* workspace on an install alone, and
its comment names the principle: `npmChecks` is the single source of what counts
as a verifier. The root never got the same guard, because in the agent's
workspace `node_modules` normally existed and the case stayed rare.

**The decision: `npm-install` is not a check.** Installing dependencies is tree
construction — ADR-0013 already defines the tree as a clean checkout, the diff
applied, and dependencies installed from the lockfile. `git checkout` is not
modelled as a check and `npm ci` has no better claim. The check-list entry is a
workspace-era artifact: it existed because verification used to run where the
dependencies might be missing.

Deleting it leaves every remaining check a real verifier, so the empty-list rule
is correct again on its own and needs no new predicate.

### Why not a verifier-versus-step predicate

The first answer, and it was an optimisation of a part that should not survive.
It would have kept the install in the list, still executing, while barring it from
counting as evidence — which requires a distinction ("a check that must run"
versus "a check that proves something"), a rule stating that the distinction is
deliberately one-way, and a paragraph in this record explaining why the asymmetry
looks like a bug and is not. Needing that paragraph was the argument against it.

### Why this is not a third road to `inconclusive`

`CONTEXT.md` says the state arrives by two roads: nothing detectable ran, or a
mandated gate did not. Road one always *meant* "nothing that proves anything
ran"; the implementation miscounted an install as proof. Correcting a miscount
costs no wire change, no new `VerifyState`, and no operator work — the co-sign
caution is already hedged and the readout's "no verifiers ran" becomes more
accurate, not less. Declaring a third road would have bought a vocabulary
migration on a value live in every ledger line, for nothing.

One string does move: the inconclusive summary names its own cause — *no
`package.json`, `Package.swift`, or Xcode project* — which is a flat lie for a
scripts-less `package.json` repo. That is the same defect class as the seven
overstating surfaces #59 found.

## 3. A failed install is attributed, not filed

The tree can fail to build. Deferring the question was considered and produced a
worse answer than resolving it: an interim in which every install failure is
infrastructure, with an IOU to attribute it later. That interim is not neutral —
it is a period in which the ledger is wrong in a consistent, agent-flattering
direction, and an unattributed failure is the one row from which nothing can be
learned about either the agent or the environment.

**Attribution is a reorder, not machinery.** The tree build already does a base
checkout and an install:

```
checkout base → install → apply diff → install again if dependency files moved
```

- **The install fails at base** — infrastructure. No verdict on the change
  exists, which is what `engine-failed` already means at the `RUN_KINDS` level:
  the run itself broke. Its one-line comment describes an instance (an engine
  process crashing) rather than that category, and is widened to say what it
  always meant.
- **It succeeds at base and fails after the diff** — the change broke its own
  dependency resolution. `verify-failed`, `diedAt: "verify"`. A kill the agent
  earned. `detect()` already anticipates this file class: `npm ci` is preferred
  precisely because plain `npm install` can rewrite the lockfile into the diff.

The cost is one conditional extra install, on runs whose diff touches dependency
files only. The measurement behind ADR-0013 put an install at ~1 s on the one
live target that has a package manager.

**Known residual, recorded rather than chased:** a repo whose own committed
lockfile is broken fails at base and is filed as infrastructure, though the fault
is the repo's. Chasing it is a third attribution point for a case no target has
produced.

## Why none of this ships early

Verification today runs in the agent's workspace, where `npm-install` is what
makes the other checks runnable. Deleting it before the tree exists would break
verification outright. Section 1 describes a tree that does not exist yet, and
section 3 reorders a build nobody has written. The whole record is a
precondition for ADR-0013 being safe to build, not a change that can precede it.

## What this measured, and what it did not

The 26 archived `verify.log` files all show real verifiers running — 23 with
lint, typecheck and test, 2 with an Xcode build. `npm-install` appears in none of
them, because the agent's workspace had `node_modules`. **So section 2's false
green is not live today; ADR-0013 creates it.** The ledger's 12 runs hold 4
`passed`, and none of them would change under any rule here.

That makes this record prophylactic, which is the point: it is cheaper to decide
these before the build than to discover them in a green nobody can explain.

## What this does not cover

**A green still does not mean every language in the diff was checked.** `detect()`
is path-shaped — it asks whether `package.json` or `Package.swift` exists, never
which files a check governs — and `test` runs whatever the target's script runs,
which the runner cannot know. So a diff touching a language with no detector
against a repo whose JS suite passes still records `passed`.

Making coverage a property of each check was considered and **deferred, not
rejected**: the fact it needs does not exist in the detector, and it would have to
be asserted per check rather than derived from one. The live instance — a target
whose main language has no detector — is closed by registering a verifier for it
([ADR-0009](0009-registered-verifiers-live-in-the-control-repo.md)), which is a
registry edit.

Carried on #115 as unspecified, with a revisit trigger written down rather than
left to be noticed: **when a second target needs a registered verifier for its
main language.** One is an instance; two says per-target registration does not
scale and coverage should be structural.
