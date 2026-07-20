---
# Unique task id — also used for the branch name (agent/<id>) and PR title prefix.
id: NNN-short-slug
title: One-line human-readable title
# Repo names from fleet/repos.yaml this task applies to. Use [all] for every repo.
targets: [demo-ts-service]
# Path globs the diff may touch. The runner mechanically kills any run whose
# diff falls outside these globs (status: scope-violation) before verify,
# judge, or PR. Omit for unrestricted (the judge still polices scope).
scope: [test/**]
# Verifier check names that MUST have run for this task's verification to count.
# Names are the checks verification detects — npm-install, eslint, tsc, test,
# swift-build, swift-test, xcodebuild-build, xcodebuild-test. Flat and applied
# to every target, like scope. A gate asserts a check ran; it never supplies one
# the fleet couldn't already run, so naming a check this repo or host can't
# produce (or misspelling one) reports it unmet rather than erroring — the run
# still ships, with verification state `inconclusive` and the gate named on
# every surface. Omit when whatever verification detects is good enough.
gates: [test]
# Blast radius shown in the PR header: drudgery | low | medium. Default: low.
risk: low
# One human sentence for the PR's "Why" section. Falls back to the title.
why: One sentence on why this change is worth a reviewer's co-sign.
---

<!--
Task prompts are version-controlled and follow the practices from Spotify's
"Context engineering for background coding agents" (part 2):

  1. Describe the END STATE, not step-by-step instructions.
  2. State PRECONDITIONS — when the agent should NOT act.
  3. Include CONCRETE EXAMPLES — they heavily influence the outcome.
  4. Define a VERIFIABLE GOAL — the verify tool must pass.
  5. Keep it ATOMIC — one change per task.
  6. Iterate using agent feedback — ask the agent what was unclear.
-->

## End state

Describe what the repository looks like when this task is done. Not the steps —
the destination.

## Preconditions

State exactly when the agent must NOT act. Always include the sentinel:

> If the precondition is not met (e.g. the file to migrate does not exist, or
> the migration has already been done), make no changes and end your reply with
> exactly: `NO_CHANGES_NEEDED`

## Examples

Concrete before/after code samples. These matter more than prose.

```diff
- old code
+ new code
```

## Verification

Call the `verify` tool after making your changes. The task is only complete
when `verify` reports success. Do not modify or delete existing tests to make
verification pass.

## Scope

Only make the change described above. Do not refactor unrelated code, rename
unrelated symbols, reformat untouched files, or "improve" anything beyond the
end state.
