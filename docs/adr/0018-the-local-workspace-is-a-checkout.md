# The local workspace is a checkout, not a copy

Local mode no longer copies a directory out of the operator's disk. It
materialises the workspace from the source repository's git objects, at the
source's `HEAD`, exactly as
[ADR-0013](0013-verification-runs-on-the-shipped-artefact.md) already
materialises the verification tree.

The rule in one line: **a run's base is a commit, or there is no run.** Anything
that is not in that commit — ignored build output, an uncommitted edit, an
untracked file — is not in the workspace, is not in the baseline, is not in the
diff, and is not in the PR.

## Status

**Accepted** (2026-08-03). **Implemented** (2026-08-03) in `prepareWorkspace`.

This closes the defect recorded in
[`docs/experiments/2026-08-03-tree-construction-on-live-targets.md`](../experiments/2026-08-03-tree-construction-on-live-targets.md)
under *A defect this probe walked around* — a `target/` directory of 9.2 GB
copied per run — without naming `target/`, which is the point. Measured after
the fact against both live targets and recorded in that file's addendum: the
10 GB source materialises a **59 MB** workspace in under a second, and the rule
that achieves it names no path.

## The exclusion list was hiding a second defect

`prepareWorkspace`'s `--local` copy filtered four basenames: `node_modules`,
`.build`, `.git`, `.DS_Store`. The measured cost of the paths it did not name was
9.2 GB per run on one live target. That is the visible half.

The invisible half is what a copy of a working tree *is*. It carries the
operator's uncommitted work, and the runner then commits it as the baseline. Two
consequences follow, and neither was written down anywhere:

**The verified base is a tree that exists on one disk.** ADR-0013's rule is
*verify the thing you are going to ship*. The verification tree is `base + the
staged diff`. If `base` holds an uncommitted edit that will never be pushed, the
tree verifies a combination nobody can reproduce, and a green earned there says
nothing about what the PR does upstream. This is the false-green shape
[ADR-0004](0004-verification-tri-state-and-mandated-gates.md) forbids, reached
through the base rather than through a check.

**The PR ships the operator's work under the agent's name.** Measured, not
reasoned: with a source holding one uncommitted edit to a tracked file and one
untracked file, a `--pr` local run produces a PR commit whose diff against the
upstream default branch contains both, alongside the agent's change. `openPr`'s
`reset --soft FETCH_HEAD` re-parents the whole workspace tree, so every
difference between the operator's disk and upstream becomes part of the change
the fleet claims to have made. [ADR-0012](0012-a-pass-reports-only-what-it-observed.md)
governs what a pass may claim; this is the same claim defect one layer down,
where a run reports authorship it did not earn.

An exclusion list cannot reach either of these. It is a filter over a copy, and
the copy is the mistake.

## What replaces it

Two plumbing calls against the source repository, into a scratch index:

```
GIT_INDEX_FILE=<tmp> git -C <source> read-tree     HEAD:<prefix>
GIT_INDEX_FILE=<tmp> git -C <source> checkout-index --all --prefix=<workspace>/
```

`<prefix>` is `git rev-parse --show-prefix`, which is empty when `local_path` is
a repository root and `demo-repos/<name>/` when it is a tracked directory inside
the control repo. **One code path covers both**, which is the constraint that
disqualified the obvious alternatives: `demo-repos/*` have no `.git` of their
own, and fourteen hermetic e2e tests run local mode against them.

The rest of `prepareWorkspace` is unchanged — `git init`, the baseline commit,
the `node_modules` symlink written *after* that commit and excluded via
`.git/info/exclude` ([ADR-0017](0017-the-in-session-verify-is-the-retry-loop.md) §3
and the fix recorded in ADR-0013's Status).

### Why plumbing and not `git archive | tar`

`git archive` honours `export-ignore` in the target's `.gitattributes`. A target
that uses it to keep tests out of release tarballs would hand the fleet a
workspace with no tests, and verification would go green on a tree missing the
files it was supposed to check. That is a path list again, owned by the target,
applied silently. `read-tree` and `checkout-index` read the object store and
nothing else. It also drops the dependency on an external `tar`.

## Rejected alternatives

**Add `target` to the filter.** The one-line patch, and the one ADR-0013 already
rejected in general form: a restore list *is only as good as the paths it names*.
The next target's build directory is not called `target`. This build has already
been bitten once by the same blind spot from the other side — `.gitignore`'s
`node_modules/` matches directories and not symlinks, so the `--local` symlink
was being committed into the baseline, and the verification tree built from that
commit would have run the checks against dependencies the agent can write
through.

**Copy the working tree, but let git choose the files** —
`git ls-files --cached --others --exclude-standard`, copying working-tree
content. Strictly better than the list: no path is named by the runner, the
target's own `.gitignore` decides, and `target/` disappears. Rejected because it
fixes only the visible half. Working-tree content is still uncommitted content,
so the base is still a tree that exists on one disk and the PR still carries the
operator's edits.

**Keep the copy, and fix `openPr` to apply the staged diff onto `FETCH_HEAD`**
instead of re-parenting the tree. This makes the PR exactly the agent's diff, and
it is appealing because it mirrors the verification tree's own construction.
Rejected because it corrects the artefact and not the verdict: the tree would
still be verified against a base nobody can fetch, so the fleet would ship a
clean-looking PR whose green was earned somewhere else. Fixing the PR while
leaving the base wrong is the more dangerous of the two states, because it
removes the evidence.

**Clone `local_path`.** No source for the demo targets — `git -C
demo-repos/demo-ts-service rev-parse --show-toplevel` returns the control repo,
so a clone would clone this repository. Cloning the control repo per hermetic
e2e run is the cost ADR-0017 already rejected a shared install path over.

**Drop local mode and always clone from the network.** The honest reading of
"the base must be a commit" taken one step further. Rejected on ADR-0017's
measurement: the hermetic e2e suite builds a workspace per run, and putting it on
the network multiplies its runtime for no verdict it does not already produce.
Local mode's remaining job — a source of git objects on disk, and dependencies
that are present and cheap — survives this record intact.

## Consequences

- **`local_path` must be inside a git repository.** Every fleet target is one;
  it opens PRs. Stated as a precondition with its own error rather than left to
  fail inside a plumbing command.
- **An operator's uncommitted work is invisible to the fleet.** This is the
  behaviour change, and it is deliberate. A change the agent must build on has to
  be committed first. The failure mode is legible — the agent reports a file it
  cannot find — where the previous behaviour's failure mode was a green nobody
  could reproduce.
- **The exclusion list is gone, including `.DS_Store`.** A target that commits
  one gets it; that is the target's business, and it is in the baseline rather
  than the diff either way.
- **`openPr`'s `reset --soft FETCH_HEAD` narrows to what it was written for.**
  When the source's `HEAD` is pushed, the baseline and `FETCH_HEAD` hold the same
  tree, so the re-parented commit's diff is exactly the agent's change. The line
  stays; what changes is that its precondition now holds.
- **Residual, recorded rather than chased: a submodule is not materialised.**
  `checkout-index` writes a gitlink as nothing at all, where the filesystem copy
  this replaces carried the submodule's files. Neither live target uses one
  (checked 2026-08-03: no `160000` entries, no `.gitmodules`), and the failure is
  loud rather than silent — the tree fails to build and is attributed as
  infrastructure, so no verdict is produced. A target that adds one needs
  `submodule update` against the source's objects, and this record does not
  design it.
- **Residual, recorded rather than chased: a source whose `HEAD` is ahead of
  upstream still widens the PR** by its unpushed commits. The same class,
  bounded to work that is at least named by a commit and pushable. Basing on the
  source's `origin/<default_branch>` would close it, and needs a fetched remote
  ref that the demo targets do not have.
- **Local and cloud mode now agree on what a workspace contains** — a tree from
  git objects, dependencies installed or symlinked on top. They differ in where
  the objects come from and in nothing else.
- No wire shape changes ([ADR-0001](0001-tolerant-reader-wire-contract.md)), and
  the agent's capabilities do not move
  ([ADR-0003](0003-the-runner-owns-git.md)). This is a runner change.
