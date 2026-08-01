# Verification runs on the shipped artefact, not the workspace

The runner's deterministic verification no longer executes in the workspace the
agent wrote in. It executes against a tree reconstituted from the staged diff:
a clean checkout of the base, the diff applied, dependencies installed from the
lockfile.

The rule in one line: **verify the thing you are going to ship.** What ships is
the diff. Everything else in that workspace is, by definition, not shipped.

Decided against the audit on #116, resolving #118 under map #115. Definitions are
in [`CONTEXT.md`](../../CONTEXT.md#gate-input); this record holds the
alternatives.

## Status

**Accepted** (2026-08-01). **Not implemented.** The runner still verifies in the
agent's workspace; nothing in this record describes behaviour you can observe
today. Implementation is a separate effort, per the #59 → #62/#63 precedent.

One number is deliberately missing and should be measured before the build: the
per-run dependency install cost on a real target. If it is large enough to change
what the fleet can do in a night, the defensible retreat is restoring only the
installed dependencies in place — strictly weaker, and only as good as the paths
it names.

## Why the workspace was the wrong tree

A [gate input](../../CONTEXT.md#gate-input) is anything a check reads when it
runs. The audit established that these fall in three tiers, and that **only one
of them has a diff**:

1. **Visible** — test files, `package.json` scripts, `tsconfig.json`, lint and
   runner config, `Package.swift`, `project.yml`. In the staged diff.
2. **Invisible, harness** — `.claude/settings.json`, `.claude/hooks/stop-verify.mjs`,
   `.claude/mcp-config.json`. `stagedDiff()` resets `.claude` out of the index and
   `.claude/.gitignore` is written as `*`, so a write here cannot trip `scope`,
   cannot appear in the diff or the PR, and never reaches the judge.
3. **Invisible, ignored** — `node_modules/**`, where the binaries the checks
   actually execute live. `git add -A` respects `.gitignore`, so these never
   enter the index at all.

Tier 3 was a live false-green path, not a theoretical one. `npm run lint`,
`npx tsc --noEmit` and `npm run test` all resolve their executables out of
workspace `node_modules`; the runner's re-verify shared the agent's copy; and
`npm-install` was suppressed *because* the in-session verify had already
populated it. **The toolchain executing the check the runner trusted was never
rebuilt.**

The decisive argument is not that these tiers are reachable. It is that a
verification run in that workspace was answering a question nobody asked. The
claim the fleet needs to make is about the change it proposes to merge, and a
tree contaminated by files that will never leave it is the wrong subject.

## Why not restore the tampered paths in place

The cheaper option — re-inject `.claude/**` from `agent-config/` and rebuild
`node_modules` before verifying, leaving everything else alone — is shipped prior
art. SWE-bench's harness does exactly this, as does Aider's benchmark and
ImpossibleBench's read-only setting.

Rejected because it inherits the deny list's flaw in miniature: **it is only as
good as the paths it names.** Every future gate input that nobody thought to add
to the restore set is a hole, and the audit's central finding was precisely that
the surface was wider than anyone had charted. Reconstituting the whole tree
needs no such list — it is correct by construction, and it stays correct when a
target introduces a gate input this repo has never seen.

## Why not detect the writes instead

Hashing the harness files at injection and re-checking them, plus watching for
writes into `node_modules`, was considered and rejected on two grounds.

It produces a signal without a consequence, which map #115's standing instrument
test already disqualifies: *name the decision the number changes, in advance.*
And it is strictly more machinery than reconstitution for strictly less coverage
— detection tells you something happened, where reconstitution means it did not
matter.

## What this costs, stated rather than buried

- **One dependency install per run.** This is exactly the cost the `node_modules`
  symlink and the `npm-install` suppression existed to avoid. It is a real
  latency regression and it is a property of each target, not of this repo.
- **The in-session verify and the runner's verify stop being the same
  verification.** Runs will appear that pass inside the session and fail at the
  runner — an agent that leaned on an untracked file, an uncommitted fixture, or
  a mutated dependency. That is the mechanism working, and it will look like
  noise the first time it happens.

## Consequences

- **Tiers 2 and 3 stop being a category.** They are not policed, restored or
  detected; they are left behind. The verification tree needs no `.claude/` at
  all — `runVerify` is called in-process by the runner, never through MCP.
- The `--local` symlink escape closes as a side effect. Writes through a
  symlinked `node_modules` could previously land in a persistent checkout on the
  operator's disk and outlive the workspace; nothing verified now reads it.
- A run that goes green on a file which never entered the index is no longer
  possible. Untracked and ignored work does not ship, so it does not count.
- The in-session Stop hook is now unambiguously defence in depth. Neutering
  `stop-verify.mjs` retires an early warning and changes nothing about the
  verdict of record.
- This does not touch [ADR-0003](0003-the-runner-owns-git.md). The agent's
  capabilities are unchanged; what changed is which tree the runner believes.
- Tier 2's remaining danger is *containment*, not a false green: those files
  carry the substituted absolute path to the control repo, which is reachable by
  an allowlisted command. That is a separate defect and is not addressed here.
