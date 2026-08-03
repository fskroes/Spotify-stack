# A run that opens a PR is based on what it opens the PR against

A run's base is decided by what the run intends to do with it. A run that will
open a pull request is built from the upstream branch that PR targets — cloned,
whether or not it is `--local`. A dry run answers to no upstream, so `--local`
keeps [ADR-0018](0018-the-local-workspace-is-a-checkout.md)'s checkout of the
source at its own `HEAD`.

The rule in one line: **a shipping run has one base.** Not a base that is
checked against another, and not two bases that are expected to agree — one.

## Status

**Accepted** (2026-08-03). **Implemented** (2026-08-03) in `prepareWorkspace`,
with the re-parent it makes dead deleted from `openPullRequest`.

**Supersedes two bullets of ADR-0018**, which is otherwise intact and still
governs how a dry run builds its workspace:

- *"`openPr`'s `reset --soft FETCH_HEAD` narrows to what it was written for …
  The line stays; what changes is that its precondition now holds."* The
  precondition — that the source's `HEAD` is pushed — does not hold, and the
  line is gone.
- *"Residual, recorded rather than chased: a source whose `HEAD` is ahead of
  upstream still widens the PR."* Closed, along with the direction that record
  did not name.

## The residual was not the small half

ADR-0018 recorded the *ahead* direction — a source with unpushed commits widens
its PR by them — and bounded it as "work that is at least named by a commit and
pushable." The *behind* direction was not recorded, and it is worse in every
respect: a file that exists upstream and not locally is **deleted** by the PR,
and nothing in the diff the agent produced explains the deletion.

It is also not an edge case. It is the state every successful `fleet cosign`
creates. The merge lands upstream; the control repo's copy of a `demo-repos/*`
target is not told; the next `--local --pr` run on that target starts from a
base that is one commit behind. The gap re-opens once per shipped run, by
construction.

## What it cost, measured rather than reasoned

On 2026-08-03 three runs shipped against one demo target in fourteen minutes.
The third one reverted the second.

That target's PR #4 shipped two files: the one its task asked for
(`tests/config.test.js`, +37 −0) and `tests/upstream.test.js`, +1 −163 — an
unauthored revert of the eleven failure-mode tests PR #2 had merged eight
minutes earlier.

**Every surface was locally truthful, and the composition was false.**

- **Verification passed honestly.** It ran on the reconstituted tree, which was
  internally consistent, and that tree is what shipped. ADR-0013's rule held.
- **The judge approved correctly.** It reviews the agent's *staged diff*, which
  genuinely touched one file. It never saw the deletion.
- **The PR header was accurate about the agent and wrong about the change.** It
  said "1 file, +37 −0" and asserted the diff was *mechanically confined* to
  that file, because `diffStats` reads the same staged diff the judge does.

This is the shape worth naming: **the judge and the header describe the agent's
staged diff, while the PR ships the workspace-versus-`FETCH_HEAD` diff, and the
two differ by exactly the divergence.** No individual component was wrong. There
was no reading of any screen that would have caught it — the operator did read
two of the three PRs' file lists, and the one they skipped was the one that
broke. [ADR-0012](0012-a-pass-reports-only-what-it-observed.md) governs what a
pass may claim; here every claim was true of the thing that made it and false of
the artefact.

## What replaces it

`prepareWorkspace` takes the run's intent:

```ts
prepareWorkspace({ …, local: true, pr: true })   // clone upstream; symlink the source's deps
prepareWorkspace({ …, local: true })             // ADR-0018's checkout at the source's HEAD
```

A `--local --pr` run clones the target at `--depth 1` exactly as cloud mode
does, then symlinks the local source's `node_modules` on top. `--local` still
earns its flag on a `--pr` run: the base comes from upstream, the dependencies
come from disk instead of an install.

`openPullRequest` loses its `fetch` + `reset --soft FETCH_HEAD` and its `local`
parameter. Every workspace that reaches it now descends from the default branch
already, so there is no unrelated history to re-parent — and no second base.

**This costs no network round trip that was not already made.** The fetch it
replaces ran on every `--local --pr` run; it simply ran after the agent and
after verification, which is precisely why it could introduce a base nothing had
been checked against. The hermetic e2e suite stays off the network because it
dry-runs: fourteen e2e tests, unchanged runtime.

## Rejected alternatives

**Refuse the run when the source's `HEAD` tree and `FETCH_HEAD`'s tree
disagree** — the guard, shaped like `cosign` having no `--force`. This was the
recommendation the incident was supposed to justify, and the incident argues
against it. It would have *blocked* a run that had nothing wrong with it: the
agent's change was correct, the target was correct, and the only defect was a
base the runner was free to choose correctly and did not. A guard converts a
fixable condition into an operator chore performed after every cosign, forever,
and the chore is the thing that was already being got wrong by hand. Adding a
check to defend a choice you can simply make correctly is the wrong layer.

**Do both — base on upstream, and assert at PR time that the commit's diff
equals the agent's staged diff.** Belt and braces, and the braces are
unreachable: with one base the two diffs are the same object, so the assertion
can only fire if the base change is broken, which its own test already covers.
A check that can only fail when a tested invariant fails is a second copy of the
test, living in production.

**Apply the staged diff onto `FETCH_HEAD` instead of re-parenting the tree.**
ADR-0018 rejected this and the rejection still stands, for the reason it gave:
it corrects the artefact and not the verdict. The tree would be verified against
one base and shipped against another — the *evidence* of the mismatch removed
while the mismatch remains. That is the more dangerous state, not the safer one.

**Sync the control repo's `demo-repos/*` copies from upstream after each
cosign**, by hook or by hand. This is what was being done, and it is what
failed. It also entrenches a vendored copy as a second source of truth for a
target that already has one. `demo-repos/*` should be what it is — a fixture set
for the hermetic suite — and not a base anything ships from.

**Drop `--local` entirely.** ADR-0018 rejected this on the hermetic suite's
runtime and that measurement is unchanged: the suite dry-runs, so it never takes
the cloning path. Dry-run `--local` is also the mode an operator iterates in,
where basing on their own committed work is the correct answer and no PR is at
stake.

## Consequences

- **A `--local --pr` run no longer sees the operator's local-but-unpushed
  commits.** The behaviour change, and deliberate. It is ADR-0018's own rule
  followed one step further: if a run's base must be a commit, a run that ships
  must be based on the commit it ships against. Work the agent must build on has
  to be pushed, not merely committed. The failure mode stays legible — the agent
  reports a file it cannot find.
- **Dry run and `--pr` can now disagree**, and this is the honest reading rather
  than a wart: they answer different questions. A dry run says *does this work
  against what I have*; a `--pr` run says *does this work against what everyone
  has*. Previously the second question was asked of the first question's tree.
- **The control repo's copy of a demo target may drift from upstream without
  consequence.** Nothing ships from it any more. It is a fixture.
- **`fleet cosign` no longer leaves the fleet in a state that needs repair.**
  The post-merge sync ritual is not automated; it is unnecessary.
- **A `--local --pr` run costs one shallow clone it did not previously make at
  that point** — the same fetch, moved earlier. Dry runs are untouched, so the
  9.2 GB-per-run copy ADR-0018 closed stays closed and its 59 MB measurement
  still describes the mode it was taken in.
- No wire shape changes ([ADR-0001](0001-tolerant-reader-wire-contract.md)), and
  the agent's capabilities do not move
  ([ADR-0003](0003-the-runner-owns-git.md)). This is a runner change.
