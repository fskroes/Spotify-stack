# A generated project file is tree construction, not a gate input

The Swift target checks in `<Target>.xcodeproj/project.pbxproj`, which XcodeGen
generates from `project.yml`. Because it is checked in, every change that adds
or renames a `.swift` file must edit it, and
[ADR-0014](0014-gate-inputs-are-carried-only-under-an-amendment.md) holds it at
the base unless the task declares an `amends:` for it.

**The decision: stop checking the generated project in, and generate it during
verification-tree construction instead.** The file stops appearing in diffs, so
it stops being a gate input, so the amendment stops being needed — not by a new
rule, but by the file joining the class ADR-0020 already describes as *"never in
a diff at all"*, beside `node_modules`.

## Why now: ADR-0014 stated its own falsification condition and it has been met

ADR-0014 says that if amendments stop being rare, the decision is wrong, and
names reflexive amendment-declaring as the failure mode it cannot prevent.
Counted from `fleet/ledger.jsonl` on 2026-08-05, the generated project has
forced the machinery **four times**:

| Run | What happened |
|---|---|
| `bm-5-extract-task-priority` | **held** — `verify-failed`, two gates unmet |
| `bm-6-extract-task-priority-amended` | amended, to fix the above |
| `smooth-view-transitions` | amended |
| `gmail-fixture-adapter-seam-probe` | amended |

Three of four are amendments, and every reason is the same sentence rewritten:
*a new file only compiles if the project lists it.* Nothing is judged. An
earlier survey of the target's own history (2026-08-04, shipped as `70dfe32`)
put the exposure at **34 of 88 commits — 38.6%** that add or rename a `.swift`
and edit the generated project together.

That is not a rare licence. It is a toll, and an operator paying a toll by
reflex is how a real amendment eventually rides in unread.

## Why the file, and not the rule

The alternative that lost: extend
[ADR-0021](0021-a-gate-input-the-base-never-had-is-carried.md) with a rule for
*a gate input whose only change registers files the base never had*, so the
amendment becomes unnecessary while the file stays checked in.

It was rejected because it services a requirement that should not exist.
`project.pbxproj` is **build output**. It is in git for the same reason a
compiled binary sometimes is — nobody deleted it — and every problem it causes
downstream is a problem of tracking a generated artefact. The rule-extension
answer keeps the artefact, adds a predicate to the convention ADR-0020 says must
stay approximate and untuned, and would then need its own paragraph explaining
why the carve-out is not a hole. Needing that paragraph is the argument against
it, the same way it was in [ADR-0016 §2](0016-the-tree-blocks-and-an-install-is-not-a-check.md).

Deleting the file removes the amendment, the toll, the carve-out, *and* the
"agent forgot the project entry" false-green class, in one move.

## Why this does not need a registered verifier — the earlier reading was wrong

The 2026-08-04 survey recorded this change as blocked, on the reasoning that
detection finds the Xcode checks by listing the tree for a `*.xcodeproj`, so
untracking the project removes both detected checks and the replacement must be
a **registered verifier** that runs `xcodegen generate` first — which
`validateVerifiers` forbids from reusing the names `xcodebuild-build` and
`xcodebuild-test`, forcing every task's `gates:` line to be rewritten and every
run in between to record `inconclusive`.

That reasoning assumed generation must live in a *check*. It does not, and
ADR-0016 §2 already decided the category: **installing dependencies is tree
construction, not a check** — `git checkout` is not modelled as a check and
`npm ci` has no better claim. `xcodegen generate` is the same thing: a
deterministic materialisation of a declared spec, needed to make the tree
runnable at all.

Placed there, the sequence answers the objection by itself
(`packages/runner/src/run.ts`):

```
constructVerificationTree()   ← generate here, beside install()
        ↓
runVerify(tree.path)          ← detect() lists the tree and finds the project
```

`detect()` is path-shaped and runs *after* construction, so it finds a generated
project exactly as it finds a checked-in one. **`xcodebuild-build` and
`xcodebuild-test` keep their names and their meanings, no verifier is
registered, no `gates:` line changes, and there is no `inconclusive` window.**
The constraint was real; it was a constraint on the wrong placement.

## Attribution comes for free

ADR-0016 §3 made the tree's build order the attribution, with no machinery
beyond the sequence. Generation inherits it unchanged:

| | Meaning | Outcome |
|---|---|---|
| Generate fails at the base | The target's own `project.yml` is broken | infrastructure → `engine-failed` |
| Generate succeeds at base, fails after the diff | The change broke its own project spec | `verify-failed`, `diedAt: "verify"` |

The second row is new coverage, not a cost: today a diff that corrupts
`project.yml` is caught only if someone happens to regenerate.

## Consequences

**`project.yml` becomes the single source of target membership, and it is
already a gate input.** It is listed in `DETECTOR_READS`
(`packages/runner/src/gate-inputs.ts`) and stays there. A task that edits it is
holding the file that decides what compiles, and *that* is an amendment worth
writing — it is a judgement, not a toll. Adding a `.swift` file does not edit it,
because targets glob by directory path.

**The `project-membership` registered verifier is deleted.** It asserts that
every `.swift` file is in a Sources build phase. Against a project generated
from directory globs that is true by construction, so the check becomes
tautological — and a check that cannot fail is worse than no check, because it
reports green as if it had looked. It is declared in the target's private
registry entry, so the edit is git-ignored.

**The agent's own workspace needs the same step.** The in-session `verify`
([ADR-0017](0017-the-in-session-verify-is-the-retry-loop.md)) runs in the
workspace, not the tree, so `ensureDependencies` gains a generation sibling
there. It stays the runner's job either way: generating is a filesystem-mutating
side effect, and the runner owns every side effect
([ADR-0003](0003-the-runner-owns-git.md)). An agent that could regenerate its
own project could redefine what its gate compiles.

**`**/*.xcodeproj/**` stays in the gate-input convention.** It costs nothing to
leave: ADR-0020 licenses the list to be approximate, and a glob matching nothing
is the harmless direction. Deleting it would be tuning the convention for one
target, which ADR-0020 forbids.

**XcodeGen becomes a host requirement on darwin.** It is already installed
wherever these runs happen, and off-darwin the Xcode checks are already skipped,
so nothing new is required on the Linux cloud runners. A missing `xcodegen` with
a `project.yml` present must fail loudly as infrastructure, never skip quietly —
a silently skipped generation is a build against a stale project, which is the
false green this record exists to remove.

## Order of work, and why this order

1. **Control repo first.** The generate step is harmless while the project is
   still checked in — XcodeGen re-emits what is already there.
2. **Target repo second**, through the front door: delete the tracked project,
   add it to `.gitignore`.

Reversed, the target has no detected checks in between and every run in the gap
records `inconclusive`. This order has no gap.

## Status

**Accepted, unbuilt** (2026-08-05). No code in this record exists yet. The four
ledger rows, the 38.6% survey, and the `run.ts` call order were all verified
before writing; the registered-verifier objection was verified *false* against
`packages/runner/src/verification-tree.ts` and `packages/mcp-verify/src/verify.js`
on the same date.

Supersedes nothing. It leaves ADR-0014's rule intact and removes one target's
file from its reach — which is the outcome ADR-0014 asked for when it wrote down
the condition under which it would be wrong.
