# The gate-input convention, measured against history

**Status:** measured 2026-08-04, **no spend** — no agent, judge, or model calls,
no runs, and no PRs. The probe read `git log` and nothing else. It imported the
runner's real `isGateInput` rather than a copy of the globs, so what follows is
the shipped convention
([ADR-0020](../adr/0020-the-gate-input-set-is-a-convention.md)) and not a
paraphrase of it. The harness was throwaway and has been deleted.

Target-neutral by construction, like the
[cost measurement](2026-08-02-reconstituted-verification-tree-cost.md) and the
[tree-construction probe](2026-08-03-tree-construction-on-live-targets.md) it
follows: the two live targets are **A** and **B**, characterised only by their
build machinery. The three demo repos are public and named.

## The question this answers

ADR-0020 fixed the gate-input set as a constant in the runner and argued that an
approximate list is safe, because the two directions of error are not symmetric
and neither produces a false green. It did not say how approximate the list
actually is. Nothing had ever run the convention against a real diff.

So: **on the history the fleet actually targets, how often would the convention
have held something, and which globs did the work?**

## Method

- `git log -n 200 --no-merges --name-only`, per target. Every target has fewer
  than 200 non-merge commits, so this is whole history in all five cases.
- Each commit's changed paths go through `isGateInput`, then through each glob
  separately for attribution.
- **`.claude/**` and `.fleet-knowledge.md` are excluded**, because `stagedDiff`
  resets both out of the index — no diff a run can produce contains them. This
  is not a detail. Target B commits a `.claude/` of its own (the finding of the
  2026-08-03 probe), and before the exclusion it accounted for **554 of B's 599
  held files**. A measurement that skipped this step would have been wrong by an
  order of magnitude.
- The demo repos have no git history of their own — they are directories in this
  control repo — so their commits are this repo's, filtered to their path and
  stripped of the prefix.

## Result

| | A | B | demo-ts-service | demo-swift-package | demo-feed-service |
|---|---|---|---|---|---|
| Shape | Xcode app project, no package manager | Cargo workspace + nested JS workspace | npm | SwiftPM | npm |
| Commits | 88 | 59 | 1 | 1 | 4 |
| **Hold ≥1 gate input** | **58 (65.9%)** | **26 (44.1%)** | 1 | 1 | 4 |
| Files held / changed | 149 / 591 | 45 / 508 | 5 / 13 | 2 / 7 | 8 / 16 |
| Held files per holding commit | median 2, max 20 | median 1, max 5 | 5 | 2 | median 2 |

**The demo repos carry no signal.** One, one, and four commits — they are the
fixture-authoring commits of this repo, not a target's working history. They are
reported because the brief asked for every registered target, and they are worth
nothing beyond confirming that the npm and SwiftPM globs match what they were
written to match. Every number below is A and B.

### Which glob did the work

Commits where the glob matched at least one path, as a fraction of that target's
commits. **Sole** counts commits where removing that one glob would have dropped
the commit from "held something" to "held nothing" — the glob's unique
contribution.

| Glob | A | sole | B | sole |
|---|---|---|---|---|
| `**/*Tests/**` | **50 (56.8%)** | 18 | — | — |
| `**/*.xcodeproj/**` | **38 (43.2%)** | 3 | — | — |
| `**/tests/**` | — | — | **23 (39.0%)** | 18 |
| `project.yml` | 10 (11.4%) | 1 | — | — |
| `**/*.test.*` | — | — | 7 (11.9%) | 2 |
| `**/package.json` | — | — | 2 (3.4%) | 0 |
| `**/package-lock.json` | — | — | 2 (3.4%) | 0 |
| `**/tsconfig*.json` | — | — | 1 (1.7%) | 0 |
| `Package.swift` | — | — | — | — |
| `**/test/**` | — | — | — | — |
| `**/*.spec.*` | — | — | — | — |
| `**/spec/**` | — | — | — | — |
| `**/__tests__/**` | — | — | — | — |
| `**/__mocks__/**` | — | — | — | — |
| `**/__fixtures__/**` | — | — | — | — |
| `**/fixtures/**` | — | — | — | — |
| `**/conftest.py` | — | — | — | — |

Three globs carry almost everything. Below them, five fire occasionally and
never uniquely — on every commit where a manifest or lockfile matched, a
test-shaped file matched too.

### No glob matched a file that is not a gate input

The probe collected every distinct path either live target would have held: 56
on A, 13 on B. Reduced to shapes, A held test-target sources, `project.pbxproj`,
`.xcworkspacedata`, a shared `.xcscheme`, the SwiftPM `Package.resolved`, and
`project.yml`. B held its nested workspace's `package.json`, `package-lock.json`
and two `tsconfig*.json`, its `*.test.ts` files, and its crates' `tests/*.rs`.

Every one of those is read by a check when it runs. **Across 147 live commits the
convention produced no false positive at all** — not one path where the ADR's
"claims a file no check reads" cell would apply. The `.xcodeproj/**` glob is the
one that could plausibly have over-matched, sweeping in user-local state; it did
not, because nothing of that kind is committed on that target.

## Is any glob carrying no weight?

Nine of seventeen never fired on a live target. Seven never fired anywhere at
all: `**/*.spec.*`, `**/spec/**`, `**/__tests__/**`, `**/__mocks__/**`,
`**/__fixtures__/**`, `**/fixtures/**`, `**/conftest.py`. Two more fired only in
a demo fixture: `**/test/**` and `Package.swift`.

**None of them should be removed, and the zeros are not evidence that they
should be.** The fleet currently points at one Swift target and one Rust target.
`conftest.py` scored zero because no Python target is registered, not because
`conftest.py` fails to judge a Python suite. A zero here describes the fleet's
language mix on 2026-08-04 and nothing about the glob.

This is ADR-0020's own argument arriving as a measurement rather than a
prediction. The list is one list for every target and every language, so an
unused entry costs nothing to hold; pruning to what today's targets exercise
would convert a free constant into a maintained one, and the next target would
pay for it. The record said a false negative costs nothing new. Nine idle globs
confirm the other half: a *speculative* entry costs nothing either.

## Is any glob carrying too much?

Not by over-matching — the section above rules that out. But one glob is far more
expensive than the ADR's cost table suggests, and the reason is structural.

**On target A, 34 of 88 commits (38.6%) add or rename a `.swift` file and edit
the Xcode project in the same commit.** That target's generated project is
checked in and lists every source individually, and nothing regenerates it inside
the cage — the agent has to write the project entry itself. Under the convention
the project file is held at the base while the new source ships. The tree then
contains a source file the project does not reference, and A's registered
verifier compares exactly that pair. It goes red.

That is a **true positive** in ADR-0020's terms: `xcodebuild` really does read
the project file, holding it at the base is the correct instruction, and the run
dies as an ordinary `verify-failed` with one `amends:` line to fix it. Nothing
here is unsound and nothing here produces a false green. What history changes is
the frequency. ADR-0020's table reads the amendment as the exception a false
positive occasionally forces. On target A, for any task that adds a file, the
amendment is the rule — and the reason is a property of that target's build
system rather than of the task. The friction is real, it is by design, and it was
not costed.

The second-order effect is worth naming too: `**/*Tests/**` and `**/tests/**`
hold **newly added** test files on 25 of A's holding commits and 9 of B's. A test
file held at the base does not exist in the tree at all, so the suite runs without
it and goes green. The new tests ship unverified, and the PR names the hold. That
is the designed behaviour — but "held at the base" reads as "an older version was
used", and for an added file it means "this file was not there".

## The gap the measurement found, which is not in the list

ADR-0020 builds source 1 from "the files verification already reads to decide a
check exists", which is a restatement of `detect()`. The check set is not
`detect()`. It is `detect()` **plus registered verifiers**
([ADR-0009](../adr/0009-registered-verifiers-live-in-the-control-repo.md)) — and
a verifier is registered precisely because repo shape does not imply it. **Its
inputs are outside the detector by construction.** Both live targets carry one.

On target B this is measurable. Its registered check ends in
`cargo test --workspace --locked`, so `Cargo.toml` and `Cargo.lock` are gate
inputs by CONTEXT.md's definition — `--locked` makes the lockfile decide what
compiles. Neither source names them: the detector does not read them, and they
are not test-shaped.

| On target B | Commits |
|---|---|
| Touch a Cargo manifest or lockfile | **14 (23.7%)** |
| …and also touch a `.rs` file | 8 |
| …and hold nothing else, so the diff passes with no hold and no note | 6 |

This is the false-negative direction, so by the ADR's asymmetry it costs nothing
new — it is the pre-ADR-0014 behaviour and it cannot produce a false green on its
own. But it narrows one consequence the record states without qualification:

> **An unamended manifest edit can no longer break the tree's install.**

That holds for npm. It does not hold for the Cargo workspace, where the closure
the check resolves is still the one the agent wrote, and
[ADR-0016](../adr/0016-the-tree-blocks-and-an-install-is-not-a-check.md) §3's
second cell is still reachable without a licence. The guarantee is per package
manager, and it covers the managers the detector happens to read.

The general shape matters more than the Cargo instance: **every verifier
registered from here on widens this gap silently**, because source 1 tracks the
detector and registration is what exists for the checks the detector cannot see.

### The record's named first candidate is the wrong one

ADR-0020 records one known omission — lint and runner configuration — and calls
it "the first candidate if a real run proves the convention insufficient". On
this history that candidate is nearly invisible: **1 commit across 147**, on B,
and none on A. Cargo manifests appear fourteen times.

This is a measurement, not a proposal. ADR-0020 says an override should arrive
with the run that demonstrated it attached, and no run has demonstrated anything
— this probe read history and spent nothing. It says only that if a third
convention is ever written, history points at the dependency manifests of
registered checks and not at lint config.

### Disposition — added later the same day, after four live runs this measurement did not include

**The gap is deliberately not being decided.** Not deferred and not parked behind
a trigger — closed. This line exists so it is not re-opened later as an oversight.

It is the **false-negative** direction, so by ADR-0020's own asymmetry it cannot
produce a false green; it is the pre-ADR-0014 behaviour, unchanged, costing
nothing new. ADR-0020's rule is that an override arrives with the run that
demonstrated it, and none has — a second convention written without one would be
a tenth record about the ninth, which is process rather than correctness.

Run `f88879ba` was built to exercise exactly this shape and confirmed the reading
rather than defeating it: on target B it shipped `approved` over a diff of six
dependency manifests and nothing else, and `cargo test --workspace --locked` then
resolved the closure from the manifests the agent had just written. No hold, no
note, no ledger key, and the PR does not contain the words *gate input* anywhere.
That is this section's finding arriving as an observation instead of as history.
It is what the disposition is about, not a reason to revisit it.

## What this does not measure

- **Human commits are not agent diffs.** A fleet task produces one scoped change;
  this history includes bulk refactors, vendoring, and initial imports. A's
  20-file maximum hold is one such commit. The medians — 2 held files on A, 1 on
  B — are the representative figure, and the hold *rates* are likely upper
  bounds.
- **Merges are excluded**, and renames are counted at their new path, which is
  what `stagedFiles` would report.
- **Two live targets, Swift and Rust.** Nine globs are untested by this data
  rather than shown to be useless, and no target here is JS-primary.
- **No run was performed**, so nothing here shows what a judge does with a hold,
  what an operator makes of the PR's account of it, or whether the forced
  `amends:` on target A is written correctly when it is written under pressure.
