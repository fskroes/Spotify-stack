# Model-usage evidence contract

Wayfinder ticket #73 defines what Fleet may say about model usage without
turning client estimates or missing evidence into billing claims. It is the
contract handoff for #74; as authored, this ADR deliberately did not add runtime
collection, artifact writes, cloud upload changes, or a usage UI — those landed
in #74 (see the rollout status below).

> **Rollout status (2026-07-21):** #73 and #74 are both closed. #74 implemented
> this contract in PR #76, merged to `main` at `d8777d7`. It is validated by two
> real local runs — a no-change run (proving availability semantics with no diff)
> and an approved-diff run (proving agent, verification, and judge evidence
> through to the ledger projection). Cloud/Actions validation remains open; see
> [implementation status](#74-implementation-status-and-remaining-validation).

## Decision

A Fleet run has one canonical, sanitized model-usage evidence document:

```text
fleet/evidence/<runId>/model-usage.json
```

It is append-only and durable with the ledger, rather than relying on
`artifacts/runs/<runId>/`, which is gitignored and pruned. Its wire schema is
`ModelUsageEvidenceSchema` in `@fleet/contract`.

The document contains an ordered `attempts` array. An attempt is a single agent
CLI invocation (initial or resume), or a single logical judge call. Agent and
judge ordinals are independently 1-based: a recorded sequence begins with agent
`initial` attempt 1, later agent attempts are consecutive `resume` records, and
judge attempts are consecutive `review` records. Every attempt records its rail,
role, actual returned model vectors, producer metadata, coarse billing
source/evidence, reported estimate where the producer emitted one, and retry
availability. Its schema rejects unknown object keys rather than silently
stripping them before persistence. It never contains task or repository
identifiers beyond `runId`, prompts, transcripts, responses, reasoning, paths,
session/request/organization IDs, credential details, or local tool inventories.

Each model vector has exactly four observed counters:

- `inputTokens` — uncached input;
- `cacheCreationInputTokens` — input written to cache;
- `cacheReadInputTokens` — input served from cache;
- `outputTokens` — generated output.

A producer-emitted `0` is observed evidence and is preserved. An unavailable
fact is represented by `{ availability: "unavailable", reason }`. Omission of
`LedgerEntry.modelUsage` is a separate historical state: **not recorded**.

`LedgerEntry.modelUsage` is an optional, compact projection. It contains an
artifact version/digest plus separate agent and judge rail summaries: attempt
count, availability, actual models when known, tokens only when complete,
compatible reported estimates only, and coarse billing sources. It excludes
attempt rows, per-model vectors, producer versions, retry details, and all
content-bearing data. The committed ledger remains readable by itself but is
not the canonical accounting source.

## Composition

1. For a successful Claude CLI invocation, use the final result envelope's
   `modelUsage` map once. It is cumulative for that invocation on the proven
   Claude CLI version. Do not add assistant-event usage or `usage.iterations`.
2. A `--resume` starts a new invocation. Sum all initial and resume vectors
   category-by-category for the agent rail.
3. Every logical judge call is a new attempt. Sum the separately returned
   attempt vectors for the judge rail; never multiply a vector by attempt count.
4. A reader may derive a run display total as agent plus judge category-by-
   category. The persisted contract never replaces the two rails with a scalar
   total.
5. A rail is `observed` only when all its attempts have observed token evidence;
   it is `partial` when some do, and `unavailable` when none do. Partial and
   unavailable rails show availability and attempt count, not a misleading
   token subtotal.
6. Sum dollars only when every component is an observed compatible reported
   estimate (currently `claude-cli-estimate`). Call the result a **reported
   estimate**, not a billed charge. API response dollars and incremental
   subscription charges are unavailable; no token-price calculation is allowed.

Billing source is independent of `mode`: a workflow-provided API key may prove
`api`; local inherited credentials without observed provenance are `unknown`,
not `subscription`. Current JSON-only CLI and SDK paths do not observe provider
retry counts. Claude Code background-work attribution is also unavailable.

`agent-plan.yml` is outside a per-repository Fleet run and is excluded from both
agent and judge totals.

## Rejected alternatives

- **One `totalTokens` or `costUsd` ledger field:** loses cache categories,
  actual models, rail attribution, and retry/resume provenance; it also invites
  invented billing precision.
- **One run-level usage object without attempts:** cannot establish correct
  composition across resumes and fresh judge retries.
- **Summing CLI assistant events:** the #72 controlled CLI capture shows their
  output counters do not reconstruct final-result output; adding them to final
  usage double-counts.
- **Inferring model, billing source, or retries from Fleet mode/configuration:**
  resumed invocations can resolve differently, local runs can inherit API
  credentials, and configured retry maximums are not observed retries.
- **Using zero, null, or omission for every missing fact:** collapses observed
  zero, current unavailability, and historical absence.
- **Keeping canonical evidence only under `artifacts/runs`:** that location is
  pruned and is not a durable audit record.
- **Putting detailed attempts or raw evidence in the public ledger:** expands
  the privacy boundary and makes readers process material they do not need.

## Compatibility and migration

`LedgerEntry.modelUsage` is optional and all non-structural vocabularies remain
open strings, following [ADR-0001](0001-tolerant-reader-wire-contract.md).
Existing JSONL entries parse unchanged; no historical transcript reparsing or
backfill is permitted. Readers render an omitted field as “not recorded,” a
present unavailable rail as “unavailable,” and an observed numeric zero as zero.

The canonical artifact uses a strict `v: 1` discriminant: a later shape fork
must fail loudly until its migration is explicitly understood. Ledger readers
remain tolerant of future optional fields and vocabulary.

## #74 implementation status and remaining validation

Delivered in PR #76 (merged to `main` at `d8777d7`) and validated by the two
real local runs noted above:

1. **Agent and judge capture.** The agent CLI and judge seams retain sanitized
   final-envelope / SDK-response evidence alongside their existing result and
   verdict data.
2. **Ordered attempts.** `run.ts` collects ordered agent invocations and judge
   attempts, including unavailable attempts that produced no usable envelope.
3. **Canonical write/hash then ledger projection.** The canonical evidence
   document is written and hashed before its compact projection is appended to
   the ledger; a digest is never written for an artifact that was not written.
4. **Retrieval and presentation.** The sanitized artifact is part of review-safe
   retrieval, and the compact projection renders in HTML and Operator: “not
   recorded” for historical absence, availability for current gaps, separate
   agent/judge summaries, and explicitly labeled estimates rather than a cost
   dashboard.
5. **End-to-end fixture.** Composition is proven by a sanitized initial-agent →
   veto → resumed-agent → fresh-judge fixture, including a measured zero and
   partial evidence.

The cloud path is implemented in code — `cloud-sync` places the canonical
`fleet/evidence/<runId>/` document into the control repo on retrieval, and the
cloud artifact policy avoids shipping raw transcripts by default — but it is
**not yet validated by a real cloud/Actions dispatch.**

### Remaining validation (open)

One real cloud/Actions dispatch must prove, end to end: the canonical evidence
artifact uploads from the cloud run; a cloud review retrieves it **without a
transcript**; and its ledger and Operator/HTML projection render from that
retrieved artifact. This is the only remaining operational gate for Wayfinder
map #71, which stays open until it passes.

The local runs above support the delivered claims but their evidence is
machine-local (`fleet/evidence/` is gitignored) and is deliberately not added to
this committed public prose.
