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
[`amends`](#amendment), `risk`, and `why`. It describes an **end state and its
preconditions**, not steps. A task is the unit that fans out: one prompt, many
targets.

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

## Pass

One traversal of the four phases inside a [run](#run) — the agent produces a
diff, [scope](#scope-contract) is enforced, verification runs, the judge rules.
A run has at least one pass; a judge veto starts another, up to the run's retry
limit. A pass reports **only what it observed**: one that died before verifying
carries no [verification state](#verification-state) at all, because an earlier
pass's green belongs to an earlier diff. Not an [attempt](#attempt) — an attempt
is one model invocation on one [rail](#rail), so a single pass contains two.

## Engine

The thing that produces the diff — `claude` (headless Claude Code, the default)
or `mock` (applies a fixture patch, for hermetic tests). Swapping the engine
changes nothing about the gates: scope, verify, and judge run identically.

## Judge

The model review standing between a green diff and a human. It reads the task,
the diff, and the verification summary, and returns approve or veto with reasons.
It may also read the run's workspace — read-only, through a tool the runner roots
there ([ADR-0011](docs/adr/0011-the-runner-owns-the-judges-reads.md)), because a
reviewer that can only check what the task asserted is examining the wrong
document.

Two transports carry the call, an SDK client and the local `claude` CLI, and
which one runs is a **billing** question. It is never a capability question: the
judge's [cage](#cage) is the same either way, and evidence records which
capability produced a verdict rather than only which model did.

## Cage

The capabilities a fleet-invoked model process has — enforced by the runner, not
requested of the model. The agent's is an allowlist plus a hook injected into its
workspace; the judge's is a rooted read tool and nothing else. Every such process
has one, and a process nobody chose a cage for has the widest one available,
which is how the judge came to be less constrained than the agent it reviews.

Widening a cage is therefore a decision, not a feature — it belongs in an ADR
with the failure mode it accepts, alongside
[ADR-0003](docs/adr/0003-the-runner-owns-git.md) and
[ADR-0011](docs/adr/0011-the-runner-owns-the-judges-reads.md).

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
makes the successes mean something. What each of those runs *left behind* is a
[retained kill](#retained-kill).

## Retained kill

What survives a killed run: its diff, the artefact that killed it, and a slot for
the verdict of any later review — kept apart from each other on purpose, so the
first can be read without the second
([ADR-0015](docs/adr/0015-a-kill-is-retained-forever-and-blinded.md)).

Kept **forever**, in the git-ignored private evidence store, and not cleaned up
when a kill is overturned — an overturned kill is the rarest and most valuable row
the fleet produces, and deleting it would delete the finding. Retention is the
**substrate**, never the instrument: it is what makes a gradient possible later,
and it is deliberately exempt from the standing test that a measurement must name
the decision it changes.

Distinct from the [kill log](#kill-log), which is the ledger's compact projection
— *that* a run was killed and roughly why. A retained kill is what the projection
was taken from, and only it can reconstruct the judgement.

## Blind re-adjudication

Re-reviewing a [retained kill](#retained-kill) with the reason withheld: a reader
sees the diff and the task, and rules on it without knowing what the fleet
objected to. The comparison against the original ruling is the only thing that
could ever establish a false-kill rate.

Not a [cold](#primed-vs-cold) run, which is the knowledge-experiment sense of the
word — a run that explores its target from nothing. Both are concealments with
different subjects, so the vocabulary keeps them apart: **cold** is what the
*agent* was denied, **blind** is what the *reviewer* is.

The blinding is a property of where the files sit, not of a reader's restraint,
and it is only meaningful because the withheld reason is retained rather than
discarded. A blinded review with no unblinding key cannot be scored, and an
unscoreable review is a ritual rather than an instrument.

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

What `passed` does **not** mean is that every language in the diff was checked.
Detection is path-shaped — it asks whether a `package.json` or a `Package.swift`
is present, never which files a check governs — so a change in a language no
detector recognises is green on the strength of the checks that did run. Closing
that for a given target is a [registered verifier](#registered-verifier), not a
property of the term; closing it in general is unspecified on #115
([ADR-0016](docs/adr/0016-the-tree-blocks-and-an-install-is-not-a-check.md)).

Orthogonal to [run status](#run-status-vs-verification-state). Every surface
reads the state from its field — `VerifyResult.state`, or the ledger line's
`verifyState` — and none may infer it by string-matching summary prose. A
missing field means *not known*, which is not the same as green and must never
render as green.

Absence is ordinary in the record and rare in a readout, and the two are worth
keeping apart. A line omits the field whenever the run reached no verification of
its own — every empty diff, every scope violation, an engine failure that threw
before the agent produced anything — as well as on any line written before the
tri-state existed. But a run that never reached verify is answered by its [run
status](#run-status-vs-verification-state) instead, so the only absence a reader
is ever *shown* as *not known* is the historical one. "Nothing was recorded" and
"there was nothing to record" are different claims, and only the first is a gap.

## Mandated gate

A verifier check name a task's `gates:` frontmatter declares must have run for
its verification to count. A gate is an **assertion, not an instruction**: it
names a check the fleet could already run and demands evidence that it did. It
never supplies a new one — supplying is the [registered verifier](#registered-verifier)'s
job, kept deliberately separate ([ADR-0009](docs/adr/0009-registered-verifiers-live-in-the-control-repo.md)).

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

An unmet gate is an **absence** — a check the task demanded and nothing ran. Do
not reason about it together with an [amendment](#amendment), which governs a
check that *did* run against a base the diff tried to move. The two look alike
because both concern a gate the diff did not honour, and they resolve opposite
ways: an absence is annotated and ships, a gate held at the base is verified for
real and can kill. Nothing about that second answer disturbs this one.

A run that declared no gates and a run whose gates were all met both record
none, and no surface shows an unmet-gate affordance for either. A ledger line
with no `unmetGates` field at all means *not recorded* — never an assertion that
nothing was outstanding.

## Registered verifier

A named check declared **per target** in the fleet registry (`fleet/repos.yaml`,
or the git-ignored `repos.local.yaml`), for a check no detector can infer from
repo shape — a bespoke build script, a live contract probe, a house linter. It
carries the same fields as a detected check and is composed with them by the
runner, so a [mandated gate](#mandated-gate) resolves against it identically and
no task frontmatter changes.

It is declared in the control repo and never in the target, because the agent can
edit the target's files and would otherwise be able to author the gate that
judges it. A missing prerequisite (`requiresEnv`) makes a verifier **ineligible**
— an [unmet gate](#unmet-gate), not a failure — and a `cost: billed` verifier
runs only when a task mandates it.

Decided 2026-07-28 ([ADR-0009](docs/adr/0009-registered-verifiers-live-in-the-control-repo.md),
#64) and **built** — the runner resolves a target's eligible verifiers per run
and hands them to verification as ordinary checks. Registering one is a change to
the registry, not an engineering effort, which is what makes a language the
detector cannot see a config-sized hole rather than a build-sized one.

## Gate input

Anything a check reads **when it runs** — not merely what the detector reads to
decide the check exists. Test files and fixtures, the helpers and conftest-shaped
files a suite loads, runner and lint configuration, `tsconfig.json` contents,
`package.json` scripts, `Package.swift`, the injected harness config, and the
installed dependencies the checks actually execute.

The execution-time reading is the load-bearing half of the definition. A file
that only the *detector* consults is a narrower set, and a term scoped that way
would silently exclude the fixtures and helpers where the shortest path to a
false green runs.

Gate inputs are not all visible. Some appear in a run's diff; the harness config
and the installed dependencies never can — one is reset out of the index, the
other is ignored by git. So "the diff touched a gate input" is not a question the
record can always answer, which is why verification is built to be indifferent to
it ([ADR-0013](docs/adr/0013-verification-runs-on-the-shipped-artefact.md)) rather
than to detect it.

The set the [amendment](#amendment) rule acts on is narrower still, and narrower
**by construction rather than by shortcut**: it is the paths in a run's diff that
match a convention held in the runner — the files detection already reads, plus
one universal test-and-fixture list
([ADR-0020](docs/adr/0020-the-gate-input-set-is-a-convention.md)). Since the
definition above is about execution-time reading, and since some gate inputs are
never in a diff at all, no path convention could be complete. The invisible tiers
are not left to it: ADR-0013 leaves them behind by building the tree from git
objects. What licenses an approximate list is that it cannot be wrong in a costly
direction — a path it claims wrongly is a loud kill and one `amends:` line, and a
gate input it misses is carried, which is what every run did before the rule
existed.

## Amendment

A task's `amends:` frontmatter — a mapping of path glob to reason — declaring
that this task's diff may change the named [gate inputs](#gate-input), and that
verification will carry them rather than taking them from the base.

A **licence, not a mandate** — the exact mirror of a [mandated
gate](#mandated-gate), which asserts that evidence exists and never grants
anything. Absent an amendment, an edit to a gate input stays in the diff and is
simply not part of what proves itself — the verification tree holds that file at
the base while carrying the rest of the change.

"Stays in the diff" is a claim about the *diff*, never a promise about the run.
Holding a gate at the base means verification asks whether the **shipped source
satisfies the gate the agent inherited**, and a change that legitimately moved
source and gate together fails that question: the base gate goes red against the
new source and the run is killed as an ordinary `verify-failed`. That kill is the
rule working, and it is also the whole cost of forgetting an amendment — which is
why the reason string buys a second thing besides friction, an operator who has
been made to think about the licence before the kill teaches them.

Trustworthy because it lives in the control repo, which the agent cannot write —
the same property that keeps [`scope`](#scope-contract), `gates`, and a
[registered verifier](#registered-verifier) honest. The reason string is required
and is not decoration: the failure this design cannot mechanically prevent is an
operator declaring amendments reflexively, and a justification is the friction
that a bare glob would not carry. An amendment is loud by construction — named
with its reason in the PR header, on the ledger line, and in what the judge reads.

## Moving the scoreboard

Editing the things that judge you — weakening a test, deleting the script that
names a check, loosening a compiler or lint setting, retiring the in-session gate.
The defect map #115 calls
tier 1, and the one closed by
[ADR-0013](docs/adr/0013-verification-runs-on-the-shipped-artefact.md) and
[ADR-0014](docs/adr/0014-gate-inputs-are-carried-only-under-an-amendment.md).

Distinct from [playing to the scoreboard](#playing-to-the-scoreboard), and the
distinction is what stops a path list from reading as coverage.

## Playing to the scoreboard

Writing source that satisfies the check without doing the work — a stubbed
dependency the test framework imports, an early exit before the assertion, an
equality override that defeats the comparison, reading the expected answer
instead of computing it.

**Named here, not addressed.** It is unreachable by any path-shaped mechanism in
principle, because the changes live in ordinary source code — the thing the agent
is employed to write, and indistinguishable by path from legitimate work. The
mechanisms that could reach it are a check the agent cannot enumerate, mutation
testing, the judge, and the human. Carried on #115 as unspecified; it must pass
that map's standing instrument test before it graduates.

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
