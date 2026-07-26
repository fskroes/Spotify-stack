# Evidence is archived per run, not per task

Artifacts are written twice. The flat `artifacts/<task>/<repo>/` set is
**latest-run-wins** — every run replaces it. Each run *also* archives its
reviewable artifacts under `artifacts/runs/<runId>/`, which nothing overwrites.

The flat set is right for the question "what is the current state of this task?"
It is wrong for the question a reviewer actually holds: "what did *this run*
produce?" A same-task rerun silently replaces the diff, verdict, and verify log
of a run **still awaiting review** — the reviewer opens the PR, reads the
evidence, and is reading a different run's evidence with no indication that
happened.

## Considered options

**Flat set only, disambiguated by ledger order.** Rejected: it makes attribution
a guess. The operator API would have to infer which run a file belongs to from
timestamps and ledger position, and be wrong exactly when two runs of the same
task are in flight. The archive lets the API attribute files to a run *exactly*.

**Archive everything, prune nothing.** Rejected on disk: transcripts and patches
accumulate per run forever on a machine that is also somebody's laptop. The
archive keeps the newest 20.

**Archive everything including transcripts.** Rejected. The archive is scoped to
the same `REVIEW_ARTIFACTS` allowlist the operator API serves — `diff.patch`,
`verify.log`, `verdict.json`, `result.json`, `pr-preview.md`, `model-usage.json`.
Transcripts are large and are not part of the review contract. One allowlist,
shared by the archive writer, the operator API, and cloud sync, so the three can
never drift into disagreeing about what a reviewer may see.

**Make the archive the record.** Rejected, and this is the load-bearing
distinction: the archive is **evidence, not the record**. The record is the
ledger plus GitHub. That is precisely why pruning is best-effort and a prune
failure must never fail a run — losing an archive costs a convenience, losing a
ledger line costs the truth.

## Consequences

- Pruning matches run ids against a UUID pattern before deleting, so a task that
  happens to be named `runs` can never be caught by it. Deletion paths get
  narrowed on purpose, not trusted.
- Old runs whose flat set was replaced and whose archive was pruned answer
  `artifactsSuperseded: true` from `/api/runs/:runId` — an explicit "this
  evidence is gone" rather than an empty list, which would read as "this run
  recorded nothing". Absence and loss are different facts and must render
  differently, the same principle as *not recorded* vs. *unavailable* in
  [ADR-0002](0002-model-usage-evidence-contract.md).
- 20 is a disk-pressure guess, not a derived number. If reviewers routinely lose
  evidence to it, raise it — nothing depends on the value.
