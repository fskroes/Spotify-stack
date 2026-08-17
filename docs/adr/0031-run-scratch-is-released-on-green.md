# Run scratch is released on green and kept on red

**Date of decision: 2026-08-17.** Bounds the retention
[ADR-0013](0013-verification-runs-on-the-shipped-artefact.md) introduced without
one, and does it by measuring rather than by policy.

## The decision

**`releaseWorkspace` drops a finished run's workspace and the `.verify` tree
beside it when the composed verify state is `passed`, or when the run is a
hermetic test** — the latter recognised by the caller-supplied `ledgerPath`, the
same seam that already keeps test evidence out of `fleet/evidence/`.

Every other verdict is kept: `failed`, `inconclusive`, and died-before-verify
alike. A kept tree is named in the run log, because a retained directory nobody
can find is only disk.

It runs at the single point where a run finishes — after the kill retention copy
and after the pull request, which pushes from the workspace. That is the last
moment at which either directory is anything but bytes.

## Why the old policy was unbounded, not wrong

ADR-0013 built the verification tree from git objects and kept it, for a reason
that still holds:

> it is the tree the verdict was actually produced on, and a red verify is
> re-runnable there.

Nothing bounded *how many*. Measured on 2026-08-17, `.tmp/runs` held **94.4 GB
across 2545 directories** in a checkout whose every other directory summed to
under 250 MB.

The cost was entirely on one side of the pair:

| | `node_modules` | Measured |
|---|---|---|
| Workspace (`--local`) | symlink into the target's checkout | **KB** — 1324 dirs, ~0.5 GB |
| `.verify` tree | its own install, mandatory | **68 MB** — 1157 dirs, 77 GB |

The asymmetry is ADR-0013 working as designed. A `--local` workspace may share
the target's installed dependencies; the tree may not, because a symlink into a
directory the agent can write is the tier-3 contamination that ADR forbids. So
the tree installs, and 1157 of them installed the same 68 MB.

**Every one of those 1157 trees carried a test-fixture task id.** Not one real
task:

| Task id | Trees |
|---|---|
| `001-ts-migrate-http-client` | 486 |
| `001-judge-read` | 369 |
| `001-gates-unmet` / `001-gates-met` | 65 / 64 |
| `001-unamended` / `001-amends` | 60 / 60 |
| `001-added-gate-input` | 53 |

`packages/runner/test/e2e.test.ts` sets its control repo to the repository root,
and its `afterEach` unstubbed environment variables and nothing else. Thirteen
`run()` calls per execution, so **one `pnpm test` deposited ~0.9 GB permanently**;
1157 ÷ 13 ≈ 89 suite runs. The 369 `001-judge-read` trees verified a judge
[ADR-0025](0025-the-judge-is-deleted-and-verify-is-the-last-gate.md) deleted — a
retained tree outliving the mechanism it tested.

The remaining 17 GB came from real runs: 12 directories for one target whose
compiled build output is ~1.2 GB per tree, against 52 ledger rows over five days.
That rate refills 94 GB in roughly ten weeks unaided, so this is not a one-off to
sweep by hand.

Nothing read any of it. Exactly one line in the codebase named `.tmp` — the line
that created the path.

## Why a green tree may be dropped

The retention reason is re-runnability, and a green run has nothing to re-open.
That is an argument from purpose, and on its own it would not be enough: a false
green is the one output this system may not produce
([ADR-0004](0004-verification-tri-state-and-mandated-gates.md)), so the bytes
behind a green verdict are exactly the bytes an investigation would want.

What makes it safe is a property, measured before the cut:

**`constructVerificationTree` is a pure function of `(base commit, diff)`, and a
run retains both** — the diff in its artifacts, the base in `result.json`. A tree
deleted and rebuilt from those two inputs reproduces the base and every check
status identically. That makes a green tree a **cache**, not a record.

The inversion matters more than the disk. If a rebuild ever *fails* to reproduce
a recorded verdict, this harness has a determinism defect — and archiving the
bytes hides that defect, while rebuilding surfaces it. Deleting is the stronger
test of the property the product depends on.

An absent verdict is still not a green one. A run that died before verify knows
nothing, and nothing is not a licence to delete.

## The alternatives that lost

**Keep-N pruning on `.tmp/runs`**, mirroring the per-run archive's keep-20 prune.
This was the first recommendation and it is the wrong shape: it bounds a
directory that should be empty. Keeping the twenty most recent green trees keeps
twenty caches of verdicts already recorded elsewhere, and it would still have
retained the 369 trees for a deleted judge.

**One build-output directory shared across trees**, via whatever environment
variable the toolchain reads for it. It would save ~1.2 GB and most of the compile
time on every affected run. It is also shared mutable state between verification
trees, where a stale artifact from one tree can carry another to green. That is a
false-green channel, and ADR-0004 forbids precisely it. Per-tree build output
stays per-tree, and the cost is the point of ADR-0013.

**Convert the demo targets to pnpm**, so a store's hardlinks replace 68 MB of
copies. `demo-ts-service` commits `package-lock.json`, and `INSTALLERS` reads the
committed lockfile as the target's own statement about its package manager
([ADR-0020](0020-the-gate-input-set-is-a-convention.md)'s convention-not-config
shape). Converting it deletes the npm path this target exists to exercise.

**A `fleet gc` command.** It only reclaims when someone remembers to run it,
which is the failure mode that produced 94 GB.

**Delete the retention entirely, reds included.** This is the cut the measurement
would support on hit-rate alone — nothing read any tree, red ones included. It
loses the one thing retention is for, and unlike a green tree, a red tree is what
somebody reaches for while the failure is still live.

## The thing this cut created, and the 10% put back

Three tests in `e2e.test.ts` assert on the post-run workspace itself: the applied
patch, the injected agent config, the compiled knowledge file, and — in the stop
hook test — a re-verify of that workspace in place. That last one exercises the
agent's cage ([ADR-0003](0003-the-runner-owns-git.md)), so the requirement
survives questioning and the tests stay.

They opt out through **`keepWorkspace`**, and release in `afterEach` rather than
at the end of each test, so an assertion that throws part-way still leaves
nothing behind. The default is off **including for test runs**: a test written
later cannot leak a workspace by saying nothing, which is how 77 GB arrived.

The load-bearing property is locked as a test, not recorded as a claim — *"a
verification tree is a cache, not a record"* in
`packages/runner/test/release-workspace.test.ts` builds a tree, records its
verdict, deletes it, rebuilds from the same `(base, diff)`, and asserts an
identical verdict. **If that test fails, stop releasing greens.** It is the
add-back trigger, and it fires by itself.

That file also covers the real-run branch, which no other suite reached: every
other hermetic test passes a `ledgerPath`, which is exactly the seam that marks a
run as a test. It runs against a throwaway control repo so a run with no
`ledgerPath` writes its ledger, evidence, and artifacts into a temp directory
instead of the checkout.

One further hazard is locked in `workspace.test.ts`: a `--local` workspace holds a
`node_modules` **symlink** into the target's own checkout, so a delete that
descended through it would destroy the source's installed dependencies — every
other local run's, not just its own.

## Consequences

- **`RunResult.workspace` may name a directory that no longer exists.** It has no
  production reader — only tests, which now say so explicitly.
- A red or inconclusive run still parks **both** directories, and each carries its
  own build output — measured at ~1.4 GB apiece for the target above, so ~2.8 GB
  for one kept run. That is the retention working, and it is now the only thing
  `.tmp/runs` holds.
- `pnpm test` leaves **0 directories and 0 B**, measured, down from ~0.9 GB.
- Investigating a suspected false green means rebuilding the tree rather than
  opening it. The rebuild is proven equivalent, and it re-tests determinism on the
  way.
- Nothing about how a tree is *built* changed. ADR-0013's construction from git
  objects, the two-point install, and the attribution order are untouched.

## Status

Accepted. Reversing the green half means the cache property stopped holding,
which the test above already watches for — that is a determinism defect to
diagnose, not a policy to revisit.
Owner: **Fernando Silva Kroes**.
