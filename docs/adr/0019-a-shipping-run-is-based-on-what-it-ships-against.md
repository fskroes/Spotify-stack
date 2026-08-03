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

**Corrected before publication** (2026-08-03), and stated here rather than in a
superseding record because this one had never been pushed and so was not yet
something anyone could have read. The decision is unchanged; a factual claim
inside it was wrong when written, and correcting a draft's false statement is
not [the retconning](README.md) the supersede rule exists to prevent. What
changed: the first draft kept the source's `node_modules` symlink on the `--pr`
path and asserted a benefit for it. Measurement found the benefit to be zero on
every target in the fleet and the mechanism to be a latent false green. The
symlink is gone from that path, *What replaces it* carries the measurement, and
*Rejected alternatives* carries the option that lost.

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

A `--pr` run clones the target at `--depth 1` and takes nothing from the
operator's disk, so `--local` has no meaning alongside it. The flag is read as
`local && !pr`, and there is one branch, not two.

That second sentence is the correction recorded in *Status* below. The first
draft kept the source's `node_modules` symlink on the PR path and claimed
`--local` still earned its flag by supplying dependencies without an install.
The claim was false on arrival, in two independent ways.

**It is unreachable.** The symlink fires only where the source has a
`node_modules` on disk. Surveyed across the whole registry on 2026-08-03,
public and private:

| language | `package.json` | `node_modules` on disk | reachable by `--pr` |
|---|---|---|---|
| typescript (fixture) | yes | **yes** | **no upstream — 404** |
| javascript (fixture) | yes | no (zero dependencies) | yes |
| swift (fixture) | no | no | no upstream — 404 |
| swift | no | no | yes |
| rust | no | no | yes |

The one target holding dependencies has no GitHub repository, so it can never
open a pull request. On every target that can, `ensureDependencies` returns
without doing anything — it skips any directory with no `package.json` — and
there is nothing to link. The saving was zero on the entire fleet.

**And if it were reachable it would be a defect.** The dependencies would be
resolved from the *source's* lockfile and mounted over a tree built from
*upstream's*. Those are two different commits, and `ensureDependencies` skips
the install that would settle the disagreement precisely because the symlink
made `node_modules` present. Verification would then run, honestly and
reproducibly, against dependencies the shipped base does not have — the false
green of [ADR-0013](0013-verification-runs-on-the-shipped-artefact.md) and
ADR-0018 reaching the tree through the base rather than through a check. The
deletion is not a tidy-up; it closes a hole this record opened.

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

**Keep the `node_modules` symlink on the `--pr` path, for the Node target with
dependencies that the fleet will have one day.** The speculative case, and the
one the first draft took without noticing it was speculative. Rejected on the
measurement above — zero targets today — but it would lose even at a saving,
because the thing being reused is resolved from a different commit than the
base. A dependency set and the tree it is checked against have to come from the
same place, and "install it properly" is the cheap half of that sentence. When
a Node target with real dependencies does arrive, the answer is a cache keyed
on the *upstream* lockfile, which is a different mechanism with a different
name, not this symlink with its precondition quietly widened.

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
- **`--local` is inert on a `--pr` run, and the CLI says so** rather than
  leaving an operator to believe a flag is doing something. It is not an error:
  `fleet run … --local` then `--pr` is how a task graduates from dry run to
  shipping, and refusing the pair would tax the one workflow this is for.
- **A `--pr` run reaches the agent without ever reading `local_path`.** It also
  no longer fails when that directory is missing, which it used to do for a
  source it was not going to use.
- No wire shape changes ([ADR-0001](0001-tolerant-reader-wire-contract.md)), and
  the agent's capabilities do not move
  ([ADR-0003](0003-the-runner-owns-git.md)). This is a runner change.
