# Architecture decision records

One file per decision that closed off an alternative. The value of an ADR is
the **rejected option** — the code already shows what was chosen, and only this
record shows what was considered instead and why it lost.

| # | Decision | Seam |
|---|---|---|
| [0001](0001-tolerant-reader-wire-contract.md) | Tolerant reader on the runner↔operator wire | contract |
| [0002](0002-model-usage-evidence-contract.md) | Model-usage evidence: canonical document + compact ledger projection | evidence |
| [0003](0003-the-runner-owns-git.md) | The agent proposes; the runner owns git and the network | agent↔runner |
| [0004](0004-verification-tri-state-and-mandated-gates.md) | Verification is a tri-state, and a gate asserts rather than instructs | verify↔run |
| [0005](0005-operator-drives-the-cli-over-ssh.md) | The desktop operator drives the existing CLI over SSH | operator |
| [0006](0006-pre-compiled-knowledge-layer.md) | Pre-compiled knowledge is grounded, checked, and non-blocking | knowledge |
| [0007](0007-per-run-artifact-archive.md) | Evidence is archived per run, not per task | evidence |
| [0008](0008-one-status-facts-table.md) | One status → facts table, not a switch per surface | contract |
| [0009](0009-registered-verifiers-live-in-the-control-repo.md) | A bespoke check is registered per target in the control repo, never in the target | verify↔run |
| [0010](0010-the-scrub-denylist-is-the-leak.md) | The scrub check asserts that a scrub ran; it does not carry the private list | scrub |
| [0011](0011-the-runner-owns-the-judges-reads.md) | The judge reads the source through a tool the runner roots at the workspace | judge |
| [0012](0012-a-pass-reports-only-what-it-observed.md) | A pass reports only what it observed | run loop |
| [0013](0013-verification-runs-on-the-shipped-artefact.md) | Verification runs on the shipped artefact, not the workspace | verify↔run |
| [0014](0014-gate-inputs-are-carried-only-under-an-amendment.md) | Gate inputs are carried into verification only under an amendment | verify↔run |
| [0015](0015-a-kill-is-retained-forever-and-blinded.md) | A kill is retained forever, blinded, with a slot for its verdict | evidence |
| [0016](0016-the-tree-blocks-and-an-install-is-not-a-check.md) | The reconstituted tree blocks, and an install is not a check | verify↔run |
| [0017](0017-the-in-session-verify-is-the-retry-loop.md) | The in-session verify is the retry loop, and the runner installs | verify↔run |
| [0018](0018-the-local-workspace-is-a-checkout.md) | The local workspace is a checkout, not a copy | workspace |

**0003–0008 were written retroactively** (2026-07-26), reconstructing the
reasoning behind decisions already in the code. They are sound arguments, not
contemporaneous minutes — do not read their option lists as a record of what was
discussed on the day. 0001 and 0002 were written with their decisions.

## When to write one

Write an ADR when **a reasonable engineer would have chosen differently**, and
the code alone cannot tell them why you didn't. Concretely:

- A constraint was accepted deliberately (the agent can't call git).
- A simpler shape was available and rejected (a boolean instead of a tri-state).
- Evidence changed the plan, including evidence *against* it.

Do **not** write one for a decision the types already enforce, or for something
that will be re-decided next week.

## Shape

No template ceremony. A title stating the decision as a fact, then whatever
subset of these the decision needs:

1. **The decision** — stated as present-tense fact, not history.
2. **Considered options** / **Rejected alternatives** — the load-bearing
   section. Name each one and the specific failure mode it carries.
3. **Consequences** — what this makes easy, and what it makes a breaking change.
4. **Status** — only when the decision is partly unbuilt or partly unvalidated.
   Say so plainly and date it, as [0002](0002-model-usage-evidence-contract.md)
   and [0006](0006-pre-compiled-knowledge-layer.md) do.

Number sequentially. Never rewrite an ADR to agree with later code — supersede
it with a new one and link back.
