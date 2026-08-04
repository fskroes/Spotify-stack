# The gate-input set is a convention in the runner, not per-target configuration

[ADR-0014](0014-gate-inputs-are-carried-only-under-an-amendment.md) decided what
the verification tree does with a [gate input](../../CONTEXT.md#gate-input) the
diff touches. It did not decide which files those are. This does.

**The set is a constant in the runner, drawn from two sources that already
exist**, and no target may add to it:

1. the files verification already reads to decide a check exists — `package.json`
   and its scripts, a nested `package-lock.json`, `tsconfig.json`,
   `Package.swift`, `project.yml`, the Xcode project; and
2. one universal test-and-fixture convention — `*.test.*` / `*.spec.*`,
   `test/` `tests/` `spec/` `*Tests/` `__tests__/` `__mocks__/` `__fixtures__/`
   `fixtures/`, and `conftest.py`.

Neither costs anything to maintain: the first is a restatement of what `detect()`
opens, and the second is the same list for every target and every language.

Decided 2026-08-04, on building ADR-0014 under map #115.

## Why not a field in the fleet registry

Per-target configuration is the obvious shape, and
[ADR-0009](0009-registered-verifiers-live-in-the-control-repo.md) already built
the place to put it: a `gateInputs:` list beside a target's registered verifiers,
in the control repo, outside the agent's write scope. The trust property would
hold.

Rejected, and ADR-0014 rejected it first without naming it: *"there is no trigger
condition, because there is no detection step. The rule is a property of how the
verification tree is built, applied on every run."* A per-target list is a
detection step wearing configuration's clothes — someone has to decide, per
target, what the checks read, and the tree's behaviour then depends on how
recently they were right.

It also re-opens the flaw
[ADR-0013](0013-verification-runs-on-the-shipped-artefact.md) closed. The
restore-the-tampered-paths option lost because *"it is only as good as the paths
it names"*, and the audit's central finding was that the surface was wider than
anyone had charted. A registry field is that same list, per target, maintained by
the same people, with the same failure: the gate input nobody thought to add is
silently carried, and nothing anywhere says so.

And the cost lands in the wrong place. A registry entry is read at run time by
machinery that cannot tell a deliberate omission from a stale one, so the field
would have to be treated as authoritative — which makes forgetting it a soundness
event rather than a paperwork one. The convention has no such state: it is wrong
the same way on every target, visibly, in one file.

## Why a convention is allowed to be wrong, and configuration would not be

This is the argument the whole decision rests on. **The two directions of error
are not symmetric, and neither produces a false green.**

| The convention… | Costs |
|---|---|
| **claims a file no check reads** (false positive) | Nothing, when the check really was indifferent: the tree holds a file whose contents no gate consults, verification is unchanged, and the PR still names the hold. When the check *was* reading it, the base version disagrees with the shipped source, the run dies as an ordinary `verify-failed`, and one `amends:` line with a reason fixes it. Loud, attributable, one line. |
| **misses a real gate input** (false negative) | The file is carried into the tree — which is exactly what every run did before ADR-0014 was built. No regression, and no new way to be wrong. |

A false positive is therefore paid in friction by the person who can see the
failure, in the moment they can see it — and the friction it costs is the same
`amends:` reason ADR-0014 wanted them to write anyway. A false negative costs
nothing that was not already being paid. That asymmetry is what licenses an
approximate list; it is *not* available to a mechanism where being wrong means
claiming a check ran, which is why the same reasoning would not license, say, an
approximate gate vocabulary.

Configuration cannot inherit that licence. The moment the set is per target, a
false negative stops being "the old behaviour" and becomes "this target's owner
said this file does not judge anything" — an assertion, recorded, that a reader
would be right to trust.

## The set is partial by construction, not by shortcut

`CONTEXT.md` defines a gate input by what a check reads **when it runs**, and
says plainly that some never appear in a diff at all: the harness config is reset
out of the index, and `node_modules` is ignored by git. A convention matched
against a diff's paths therefore *cannot* be complete, in principle rather than
in this version.

That is not a hole this decision leaves open. Those tiers are not policed here
because ADR-0013 already left them behind — the tree is built from git objects,
so a file that never entered the index cannot reach it, and nothing in the
convention has to name `.claude/` or `node_modules/` at all. The visible tier is
the only one where "hold it at the base" is even a meaningful instruction, and it
is the tier this list covers.

One omission inside the visible tier is known and recorded rather than fixed:
**lint and runner configuration** (`eslint.config.js`, `vitest.config.ts`, and
their kin) is a gate input by the definition and is in neither source above — it
is not what detection reads to decide a check exists, and it is not test-shaped.
It is carried, as it was before. It is the first candidate if a real run proves
the convention insufficient, and it should arrive as a third convention rather
than as a target's opinion.

## Consequences

- **A target cannot tune this, and that is the point.** If a real target proves
  the convention insufficient, an override is a separate change with the run that
  demonstrated it attached — not a field standing ready to be filled in by
  someone guessing.
- **An unamended manifest edit can no longer break the tree's install.**
  `package.json` and `package-lock.json` are gate inputs, so the closure the
  checks execute is resolved from the manifest the agent inherited.
  [ADR-0016](0016-the-tree-blocks-and-an-install-is-not-a-check.md) §3's second
  cell — the change that broke its own dependency resolution — is now reached
  only through a licence, which is the honest reading of the two records
  together.
- **The copy of what detection reads can drift from the detector**, and the drift
  lands on the harmless side: a detector taught to read a new file yields a false
  negative, which is the pre-ADR-0014 behaviour. That is the asymmetry above
  doing its job, and it is why the list is not wired to `detect()` through an
  export that would make `mcp-verify` answer a task-facing question
  (ADR-0009's seam, unchanged).
- **Nothing here changes [run status](../../CONTEXT.md#run-status-vs-verification-state)**
  or what verification returns. A held file changes which bytes a check reads,
  and nothing else.
