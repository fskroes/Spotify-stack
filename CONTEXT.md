# Domain glossary

Canonical terms for this codebase. When code, docs, or conversation drift from
these definitions, either fix the drift or sharpen the term here.

## Wire contract

Everything the runner tells the operator, regardless of transport. Today that
is the ledger-server HTTP responses (ledger entries, in-flight runs, catalog,
artifact metadata, sync state) and the co-sign result emitted as a JSON line
over SSH stdout. The contract is defined by the seam — runner speech — not by
which pipe carried it.

## Tolerant reader

The wire contract's stance toward version skew. The operator app and the
runner checkout can be at different commits at any time; that is the normal
state, not an edge case. A tolerant reader ignores unknown fields, degrades
gracefully on missing optional fields, and fails **loudly, naming the field**
only when a required field is absent or mistyped. Silence is the failure mode
being designed out; strictness that rejects skew would be a different one.

A consequence: a run's `status` stays a plain string on the wire (a newer
runner may speak statuses an older operator doesn't know), with known-status
narrowing provided alongside rather than enforced by parsing.

## Co-sign

The human decision on a shipped run — merging or closing its pull request,
executed through the gate (`fleet cosign`). Distinct from [PR live
state](#pr-live-state): the co-sign is the act; the PR's live state is the
evidence of it.

## PR live state

GitHub's current answer about a shipped run's pull request — open, merged, or
closed, and by whom. Fetched live at render time and never recorded in the
ledger (the merge happens after the run, so GitHub stays the source of truth).
Formerly also called "Cosign" in code, which collided with the co-sign
*result*; the canonical name is now PR live state (`PrLiveState`).

## Verification state

How deterministic verification ended: `passed`, `failed`, or **`inconclusive`**
(`VerifyState`). The third value exists because a boolean cannot say *nothing
ran* — a repo with no detectable verifiers is a legitimate state, but claiming a
pass for it is an assertion the fleet has not earned.

The state a *run records* is a composition, not a passthrough of what
verification returned. Verification answers only "what does this repo offer, and
did it pass"; the runner folds in whether the task's [mandated
gates](#mandated-gate) actually ran. So `inconclusive` now arrives by two roads —
nothing was detectable to run, or something the task demanded did not — and
`passed` means both that every check that ran was green *and* that every
mandated gate was among them. Only the runner holds both halves, which is why
the composition lives there and verification stays task-blind.

Orthogonal to [run status](#run-status-vs-verification-state). Every surface
reads the state from its field — `VerifyResult.state`, or the ledger line's
`verifyState` — and none may infer it by string-matching summary prose. A
missing field (any line written before the tri-state existed) means *not
known*, which is not the same as green and must never render as green.

## Mandated gate

A verifier check name a task's `gates:` frontmatter declares must have run for
its verification to count. A gate is an **assertion, not an instruction**: it
names a check the fleet could already run and demands evidence that it did. It
never supplies a new one — that is a capability question, deliberately kept out.

The names are the check names verification emits (`test`, `tsc`,
`xcodebuild-test`, …), an **open vocabulary** with no registry. Any string is
legal, because the runnable set is a function of *(repo shape, host platform)*
and is only knowable at detection time. A typo and a deliberately unrunnable
mandate are therefore indistinguishable — by design, since both produce a loud
[unmet gate](#unmet-gate) and neither can produce a false green.

## Unmet gate

A mandated gate that no check satisfied. A gate is **met** when a check of that
name reached `passed` or `failed` — it *executed*. A `skipped` check does not
meet a mandate: it was detected and then never reached, which is the "did not
run" case the tri-state exists to name.

Any unmet gate makes the recorded [verification state](#verification-state)
`inconclusive`, and travels to every surface by name (`unmetGates` on the wire,
plus the verification summary prose the judge reads). It does **not** change
[run status](#run-status-vs-verification-state): a good diff with an unmet gate
still ships as `approved`. Blocking would make declaring a gate dangerous, so
authors would stop declaring them; the proposition is *cheap to declare, loud
when unmet*. What is unproven is the verification, not the run.

A run that declared no gates and a run whose gates were all met both record
none, and no surface shows an unmet-gate affordance for either. A ledger line
with no `unmetGates` field at all means *not recorded* — never an assertion that
nothing was outstanding.

## Run status vs. verification state

Two independent questions, deliberately not merged. Run status answers *what
happened to the change* (the seven-value `RunStatus`); verification state
answers *what was proven about it*. A run that shipped a good diff against a
repo with no verifiers is `approved` with `verifyState: "inconclusive"` — the
run succeeded, and what is unproven is the verification, not the run.
