# Tree construction on the two live targets

**Status:** measured 2026-08-03, **no spend** (no agent, judge, or model calls —
a probe harness only). Runs the reconstitution
[ADR-0013](../adr/0013-verification-runs-on-the-shipped-artefact.md) now ships
against both live fleet targets. The harness was throwaway and has been deleted;
this file is the result it existed to produce.

Target-neutral by construction, like the
[cost measurement](2026-08-02-reconstituted-verification-tree-cost.md) it follows:
targets appear as **A** and **B**, characterised only by the dependency machinery
they carry.

## The question this answers

Everything green when the tree was built was demo repos and hand-written
fixtures. The one real defect the build found — the `--local` `node_modules`
symlink reaching the baseline commit, so a tree built from that commit would
verify against dependencies the agent writes through — was invisible to design
review and to 649 passing tests, and surfaced only when the suite ran against
something real. So: **does `constructVerificationTree` work outside fixtures, and
what does it cost there?**

Three things it could plausibly get wrong, none of which any test covered:

1. A target with **no package manager at all** — the unconditional two-point
   install must be a clean no-op rather than a throw.
2. A **nested** workspace's real lockfile. `install()` walks `nestedWorkspaces`
   and had only ever met a synthetic one.
3. A target that **commits a `.claude/` of its own**, where ADR-0013's claim that
   the harness cage does not reach the tree stops being free.

## Method

- **Host:** darwin 25.5.0, Apple M5, 10 CPU, 16 GB. Warm host npm cache.
- The workspace is a **shallow clone** of the target — the shape a cloud run
  gets (`prepareWorkspace` without `--local`), and the shape with no test
  coverage until this probe prompted one.
- `injectAgentConfig` runs, so the cage exists in the workspace exactly as a real
  run leaves it.
- The diff is one edited tracked source file, staged through `stagedDiff`.
- One repetition per target. These are pass/fail properties with second-scale
  timings; nothing here is a median worth quoting to two digits.

## Result

| | A | B |
|---|---|---|
| Shape | Xcode app project, **no package manager** | Cargo workspace + one nested JS workspace |
| Construct (worktree + 2 installs + apply) | **0.1 s** | **1.7 s** |
| Tree on disk | 2 MB | 129 MB |
| Diff carried into the tree | yes | yes |
| Nested lockfiles installed | *(none to install)* | `web/node_modules` present |
| Dependencies real, not a symlink | yes | yes |
| Target commits its own `.claude/` | no | **yes** |
| Harness Stop hook in the tree | no | no |
| Any file in the tree carrying the control-repo path | none | none |

**Construction works on both targets, and the second install costs what the
2026-08-02 measurement predicted** — about a second where a package manager
exists, nothing where one does not.

## The finding that was not the question

**Target B commits a `.claude/` directory, and the tree holds the base version of
it.** This is the one live instance of a case the code anticipated in a comment
and nothing had exercised: `injectAgentConfig` overwrites the target's committed
`settings.json` in the workspace, and `stagedDiff` resets `.claude` out of the
index, so the harness's version is never staged and never reaches a tree built
from git objects. Verified from the other side too — no file anywhere in either
tree carries the substituted absolute control-repo path, which is the containment
concern ADR-0013's last bullet leaves open rather than a false-green one.

So tier 2 is left behind on the one target where it could have been carried in.

## A defect this probe walked around

`prepareWorkspace`'s `--local` copy filter excludes `node_modules`, `.build`,
`.git` and `.DS_Store`. It does not exclude **`target/`**, and target B's is
**9.2 GB of its 10.4 GB**. A local-mode run on that target copies all of it, per
run, into `.tmp/runs`.

This probe used the cloud shape and so never paid it, which is why it is recorded
here rather than fixed here — the copy is unrelated to reconstitution, and the
obvious patch (add `target` to the list) is another instance of the path list
ADR-0013 rejects reconstitution's alternative for. The shape of a real fix is
that the local workspace, like the verification tree, could come from git objects
rather than from a filesystem copy — which would also decide what happens to a
target's uncommitted local work, and that is a decision, not a patch.
