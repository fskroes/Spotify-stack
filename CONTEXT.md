# Domain glossary

Canonical terms for this codebase. When code, docs, or conversation drift from
these definitions, either fix the drift or sharpen the term here.

This is the one doc that is *supposed* to be maintained by hand: it holds the
domain language, which no type name fully carries. Decisions live in
[`docs/adr/`](docs/adr); navigation lives in [`docs/README.md`](docs/README.md).

## Control repo

This repository — the one holding tasks, the fleet registry, the ledger, and the
CLI. It is never a target. "Local" paths in the CLI resolve against it, and the
public/private split (`repos.local.yaml`, `tasks/private/`, `knowledge/private/`)
exists because the control repo is public and the targets need not be.

## Target

A repo the fleet acts *on*, registered in `fleet/repos.yaml` (or the git-ignored
`repos.local.yaml`). Targets are read and modified; they never contain fleet
machinery. `local_path` points at a working tree so a local run can act on
uncommitted work — which is the point, and also why a stale tree makes a task
hit its own precondition.

## Task

A version-controlled natural-language prompt in `tasks/`, with frontmatter
declaring `targets`, [`scope`](#scope-contract), [`gates`](#mandated-gate),
`risk`, and `why`. It describes an **end state and its preconditions**, not
steps. A task is the unit that fans out: one prompt, many targets.

## Scope contract

The `scope:` globs a task's diff may touch. The runner kills any run whose diff
falls outside them (`scope-violation`) **before** verify, judge, or PR —
mechanically, without a model in the loop. Omitting `scope` means unrestricted,
and leaves the judge as the only scope police. Distinct from a
[mandated gate](#mandated-gate): scope constrains *what may change*, gates
constrain *what must have been proven*.

## Run

One task executed against one target, start to fate. It carries a `runId`, ends
in exactly one of seven `RunStatus` values, and is appended to the ledger whether
it shipped or was killed. The status → facts table (`RUN_FACTS`) is the single
source of truth for what a status means; no surface may re-derive it.

## Engine

The thing that produces the diff — `claude` (headless Claude Code, the default)
or `mock` (applies a fixture patch, for hermetic tests). Swapping the engine
changes nothing about the gates: scope, verify, and judge run identically.

## Dispatch

Fanning a task out over targets on GitHub Actions (`fleet dispatch`), as opposed
to `fleet run --local` on this machine. The workflows are a thin wrapper around
the same CLI — cloud buys fan-out and autonomy, not different behaviour.

## Dry run

The default everywhere. The full loop executes and writes `diff.patch`,
`verdict.json`, `verify.log`, and `pr-preview.md` to `artifacts/`, but no branch
is pushed and no PR opened. `--pr` opts in. A dry run is the honest rehearsal:
`pr-preview.md` is the *exact* body a real run would have opened.

## Kill log

The half of the ledger recording runs the fleet stopped **before anyone reviewed
them** — scope violations, red verifiers, judge vetoes — each with its reason. A
system that showed only its successes would be advertising; the kill log is what
makes the successes mean something.

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

## Structural map

The deterministic, token-budgeted rendering of what exists in a target — files
and symbols, no model call, no network (`fleet knowledge map`). It is rebuilt
fresh whenever [knowledge prose](#knowledge-prose) is checked, which is why the
prose can be stale while the check is not. The map is the substrate; the prose is
the layer grounded against it.

## Knowledge prose

The stored, fleet-generated explanatory layer for one target. It is distinct
from a run artifact: knowledge prose lives under `knowledge/`, is stamped with
the target SHA, and is checked against an ephemeral structural map before a
consumer trusts it.

## Grounding ratio

The fraction of checkable file and symbol claims in text that the target's
freshly rebuilt structural index confirms. It is intentionally approximate:
framework vocabulary can be reported missing, while suffix file matches and
name-level dotted symbols can be overly permissive. It compares a knowledge
prose's current result to the same mechanic's compile-time baseline; it is not
a precision claim about correctness.

## Drift

A knowledge prose layer whose grounding ratio has fallen more than 0.05 below
its compile-time baseline. The relative comparison preserves a stable
framework-vocabulary floor that an absolute threshold would incorrectly flag.
Drift requests recompilation; it does not itself make the structural map stale.

## Ask

The human-facing ideation seam (`fleet ask`): a question answered from a
target's [knowledge prose](#knowledge-prose) plus a freshly rebuilt
[structural map](#structural-map), so the reader never opens the target. Three
question classes are named in the prompt and are the vocabulary to use when
talking about one — **placement** (where a change would land), **wiring** (how
something works today, in the order things happen), and **story → brief** (a
story turned into a dispatch-ready task brief). An ask answers immediately even
when the prose has drifted; it flags the unverified claims rather than blocking
on a recompile. Its reply *is* the answer — there is no follow-up turn and no
file it may defer to.

## Primed vs. cold

The two arms of every knowledge-payback experiment. A **primed** run starts with
the target's compiled prose rendered into `<workspace>/.fleet-knowledge.md`; a
**cold** run explores the repo from nothing. The vocabulary exists because the
comparison is the only thing that can justify the layer's run-time half — and so
far it has not (see [ADR-0006](docs/adr/0006-pre-compiled-knowledge-layer.md)).

## Rail

One of the two independently-accounted model consumers in a run: the **agent**
rail (the coding CLI invocations, initial plus resumes) and the **judge** rail
(each logical judge call). They are never collapsed into a single scalar total,
because attribution across a veto→resume loop is the fact worth keeping.

## Attempt

One model invocation on a rail — a single agent CLI call (`initial` or `resume`)
or a single judge `review`. Ordinals are 1-based *per rail*. Attempts are ordered
and recorded even when they produced no usable usage envelope, because an
attempt that yielded nothing is evidence, not absence.

## Reported estimate

A cost figure a producer emitted, summed only when every component is an observed
compatible estimate. It is deliberately **not** called a billed charge: API
response dollars and incremental subscription charges are unavailable, and no
token-price calculation is permitted anywhere in this codebase.

## Refusal

A structured, named `no` from a gated CLI action — `fleet cosign`'s
`run-not-found`, `not-shipped`, `no-pr`, `already-merged`, `already-closed`,
`conflicts`, `not-mergeable`, `merge-failed`, `close-failed`. A refusal is the
gate working, not an error to route around; there is deliberately no `--force`.
The code vocabulary is open on the wire, like every other non-structural
vocabulary ([ADR-0001](docs/adr/0001-tolerant-reader-wire-contract.md)).

## Wayfinder map

The planning shape this repo is developed with: one GitHub issue labelled
`wayfinder:map` holding Notes / Decisions-so-far / Fog, with child tickets
(`wayfinder:research` / `prototype` / `grilling` / `task`) linked as sub-issues
and blocked via native issue dependencies. Commit messages and ADRs cite these
numbers; [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md) has the
operations.
