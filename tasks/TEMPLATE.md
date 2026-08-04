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
# swift-build, swift-test, xcodebuild-build, xcodebuild-test. A check in an
# independent nested workspace carries that workspace's directory as a suffix
# (`test:packages/api`, `tsc:apps/web`); the root workspace's checks are
# unsuffixed. Matching is exact, so `test` mandates the ROOT suite only and does
# not stand in for a nested one — mandate a nested check by its full suffixed
# name. Flat and applied to every target, like scope. A gate asserts a check
# ran; it never supplies one the fleet couldn't already run, so naming a check
# this repo or host can't produce (or misspelling one) reports it unmet rather
# than erroring — the run still ships, with verification state `inconclusive`
# and the gate named on every surface. Omit when whatever verification detects
# is good enough.
# A target may also register extra checks in the fleet registry (ADR-0009) — a
# contract probe, a house linter. You mandate one by name exactly as above and
# do not need to know which kind it is; the registry supplies the capability,
# `gates:` still only demands the evidence.
gates: [test]
# Gate inputs this task's diff may change — a mapping of path glob to the REASON
# it may. A gate input is anything a check reads when it runs: test files and
# fixtures, the helpers a suite loads, package.json scripts, tsconfig.json,
# Package.swift, the Xcode project. Omit this key unless your task's job is to
# change one; omitting it is the ordinary case.
#
# What it does: an amended file is carried into the verification tree with the
# rest of the diff, so the change is verified as a whole. A gate input you do
# NOT amend is held at the BASE version — your edit to it still ships in the PR,
# it is simply not part of what proves the change. If source and gate
# legitimately moved together and you forgot to amend, the base gate goes red
# against the new source and the run is killed as an ordinary verify-failed.
# That kill is the rule working, and it is the whole cost of forgetting.
#
# This is a LICENCE, the mirror of `gates:` above — that one asserts evidence
# exists and grants nothing; this one grants and asserts nothing. The reason is
# required and may not be empty: a glob can be added without thought, and a
# justification cannot. It travels to the PR header, to the judge, and to the
# ledger line, so write it for the human who will co-sign.
#
# Left commented out on purpose: every other key here is a constraint you should
# start from, and this is the only one that hands something out. Uncomment it
# when your task genuinely needs it, never as part of copying the template.
#
# amends:
#   "test/rate-limit.test.ts": the asserted bound is off by one
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
