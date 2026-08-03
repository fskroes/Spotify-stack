# The in-session verify is the retry loop, and the runner installs

[ADR-0013](0013-verification-runs-on-the-shipped-artefact.md) calls the
in-session Stop hook "unambiguously defence in depth". That sentence is wrong in
a way that invites a destructive deletion, and this record replaces it.

The Stop hook is not a redundant copy of the runner's gate. **It is the only
retry a verification failure gets.** `run.ts` retries a judge veto and nothing
else; `verify-failed` ends the run outright. Delete the hook and every fixable
red — a typo, a missed import — stops being something the agent fixes in-session
and becomes a dead run.

Two things follow, and the second one is what unblocks the ADR-0013 build.

## Status

**Accepted** (2026-08-03). §2 and §3 are **implemented**; §1 is a correction to
an accepted record and needs no code.

Supersedes one bullet of ADR-0013's *Consequences* — the one beginning "The
in-session Stop hook is now unambiguously defence in depth". The rest of
ADR-0013 stands. It implements [ADR-0016](0016-the-tree-blocks-and-an-install-is-not-a-check.md) §2,
which was blocked on having somewhere for the install to go.

## 1. What the Stop hook is for

ADR-0013's reasoning is sound and its label is not. It argues that the verdict of
record moves to the reconstituted tree, so nothing in the agent's workspace
decides whether a change ships. True — and it concludes the hook is therefore
redundant, which does not follow. The hook was never producing a verdict. It
produces a **second attempt**, which the runner has no other way to offer.

| | Retried? |
|---|---|
| Judge veto | yes — resume with guidance, bounded by `maxJudgeRetries` |
| Verification failure | **only by the Stop hook**, bounded by `MAX_BLOCKS` |

Neither ADR-0013 nor the hook's own comments say this, which is how a record came
to describe the mechanism by the one property it does not have. "Defence in
depth" describes a redundant gate; a retry loop that is deleted for redundancy
takes the retries with it.

### Why not delete it anyway

The strongest version of the case for deletion is that it takes three other parts
with it: `cli.js` (whose "standalone CI gate" role is aspirational — no workflow
invokes it), and the doubly-encoded `__REGISTERED_VERIFIERS__` substitution in
`injectAgentConfig`, which exists only because one literal has to be valid in
both `mcp.json` and the hook. Four parts for one.

Rejected because the cost is paid in the currency this system cares about. A
fixable verification failure that kills the run is a target that gets no change
at all, and the ledger records it as a kill the agent earned. That is not a false
green, but it is a false *red* — the failure mode #61 was protecting against when
it refused to let an absent gate block.

## 2. The in-session verify runs the same checks as the runner's

The open question ADR-0013 left — what the operator sees when the two
verifications disagree — has a prior question, and it is this one: are they
*meant* to agree?

**They are.** The hook's job is to tell the agent whether the change it is about
to finish will survive the gate. A signal deliberately weaker than the gate it
predicts trains the agent to ignore it, and a retry loop nobody trusts is worse
than none. So the agent's workspace carries real dependencies and runs the real
check list.

### Why not keep it deliberately weaker

The considered alternative, and it is not silly: ADR-0013 predicts that runs will
pass in-session and fail at the runner, and calls that "the mechanism working".
If the disagreement is the signal, converging the two trees hides it, and the
effort should go into making the disagreement legible to the operator instead.

Rejected on sequencing rather than on merit. Making a disagreement legible is
operator-facing wire work ([ADR-0001](0001-tolerant-reader-wire-contract.md)) for
a phenomenon with zero recorded instances — the instrument test on map #115 bars
specifying it before anyone can say what a reading changes. Converging the trees
is free (it is the same install either way) and it makes the disagreements that
do occur mean something: after this, a run that passes in-session and fails at
the runner is a genuine finding about the workspace, not an artefact of two
different check lists.

**Revisit trigger, written down rather than left to be noticed: if the hook's red
is more often wrong than right, retire it.** That is now countable, because both
verifications run the same checks.

## 3. The runner installs dependencies; the detector does not

ADR-0016 §2 decided that an install is not a check and deleted `npm-install` from
the detector. It also said none of it could ship ahead of the reconstituted tree,
because "deleting it before the tree exists would break verification outright".

That constraint was real and its cause was misdiagnosed. The install did not need
a *tree*; it needed an **owner**. The runner already owns every side effect
([ADR-0003](0003-the-runner-owns-git.md)), and an install is a network-touching,
filesystem-mutating side effect that the agent could trigger by calling `verify`.
So it moves to `prepareWorkspace`, and ADR-0016 §2 ships now rather than waiting.

What the detector loses is not just a check. It loses a branch on
`existsSync(node_modules)` — the module's check list used to depend on the
filesystem state of the caller's environment, which is exactly the caller-shaped
knowledge a shared module read by three callers must not carry. The detector is
caller-blind now in a way it was not before, and a test asserts it: the same repo
yields the same checks cold or warm.

### What the archived evidence could not show

ADR-0016 recorded that `npm-install` appears in none of the 26 archived
`verify.log` files, and read that as the case staying rare. All 26 runs are
`--local`, where `prepareWorkspace` symlinks the source's `node_modules`. The
cloud path (`.github/workflows/agent-task.yml`) passes no `--local`, shallow-clones,
and installs nothing for the target — so there `npm-install` was not rare, it was
the first check on every run, and the agent's allowlist has no `npm install` with
which to do it another way.

The decision is unchanged; the blast radius was understated. **Deleting the check
without giving the install an owner would have broken every cloud run, not merely
made verification noisier.** Recorded because the measurement is still in the
record and still reads as reassuring.

### Why not one install path

The tidier-looking option: delete the `--local` symlink so both modes install
from the lockfile, one code path for one job.

Rejected on measurement. The demo target's closure is 119 packages, and the
hermetic e2e suite builds a workspace per run — so a shared "one path" would put
`pnpm test` on the network and multiply its runtime, to save a symlink on a
developer loop. The two trees are not one job done twice: the agent's workspace
needs dependencies *present and cheap* and is explicitly no longer the verdict of
record, while the reconstituted tree needs them *from the lockfile and
uncontaminated* — a symlink there would be precisely the tier-3 contamination
ADR-0013 exists to kill.

`ensureDependencies` is therefore idempotent — "ensure", not "install" — and the
symlink is one legitimate way for the condition to already hold.

### Why the reconstituted tree will not share this function

It needs an unconditional two-point install with failure attribution
(ADR-0016 §3), and one function cannot be both idempotent and two-point. The
seam between them is hypothetical until the tree exists; it stays unbuilt.

## Consequences

- `DETECTED_CHECK_NAMES` loses `npm-install`, so a target may now register a
  verifier by that name ([ADR-0009](0009-registered-verifiers-live-in-the-control-repo.md)'s
  shadowing rule). Internal to the runner↔verify boundary; no wire changes.
- The nested-workspace lockfile predicate keeps only its double-run
  justification; the "installed unsoundly" half moved to the installer with the
  install.
- A repo with a `package.json` and no lint, typecheck, or test script now records
  `inconclusive` where it used to pass on the install alone (ADR-0016 §2's false
  green). The inconclusive summary no longer claims such a repo has no
  `package.json` — it named a cause it could not know, which is the defect class
  #59 found in seven other surfaces.
- A cloud run pays its install in `prepareWorkspace` instead of on first
  `verify`. Same install, earlier, and the agent's allowlisted `npm test` now
  works from its first tool call rather than only after something else has
  populated `node_modules`.
