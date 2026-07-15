# Tolerant reader on the runner↔operator wire contract

The operator desktop app (built on a Mac) and the runner (a git checkout on
an SSH target) are routinely at different commits, so `@fleet/contract` reads
runner speech as a tolerant reader: unknown fields are ignored, optional
fields degrade, and parsing fails — loudly, naming the endpoint and field
path — only on a missing or mistyped required field. Open vocabularies
(`status`, `mode`, `stage`, refusal `code`, PR state) are plain strings on
the wire with known-value narrowing exported alongside, never hard enums;
only structural discriminants that select which sibling fields exist
(`RunDetailResponse.state`, `SyncState.kind`, the in-flight record's `v`)
are strict.

## Considered options

Strict lockstep — versioned schemas that refuse any mismatch — was rejected
because skew is the normal operating state, not an edge case: it would turn
every runner-side iteration into a mandatory app rebuild. The failure mode
being designed out is *silent* drift (hand-copied interfaces plus `JSON as T`
casts rendering `undefined` as data), not skew itself.

## Consequences

- A newer runner can add fields, statuses, stages, or refusal codes without
  breaking an older operator; the operator renders unknown vocabulary
  neutrally rather than rejecting it.
- Adding a *variant* to a structural discriminant (e.g. a third
  `RunDetailResponse.state`) is a deliberate breaking wire change and should
  be treated as one.
- Readers validate at ingestion (the operator's fetches, the runner's
  `parseLedger`) and skip-and-warn per record on historical data — one
  corrupt ledger line must never brick a report.
