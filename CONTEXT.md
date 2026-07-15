# Domain glossary

Canonical terms for this codebase. When code, docs, or conversation drift from
these definitions, either fix the drift or sharpen the term here.

## Wire contract

Everything the runner tells the operator, regardless of transport. Today that
is the ledger-server HTTP responses (ledger entries, in-flight runs, catalog,
artifact metadata, sync state) and the co-sign result emitted as a JSON line
over SSH stdout. The contract is defined by the seam — runner speech — not by
which pipe carried it.

## Tolerant reader

The wire contract's stance toward version skew. The operator app and the
runner checkout can be at different commits at any time; that is the normal
state, not an edge case. A tolerant reader ignores unknown fields, degrades
gracefully on missing optional fields, and fails **loudly, naming the field**
only when a required field is absent or mistyped. Silence is the failure mode
being designed out; strictness that rejects skew would be a different one.

A consequence: a run's `status` stays a plain string on the wire (a newer
runner may speak statuses an older operator doesn't know), with known-status
narrowing provided alongside rather than enforced by parsing.

## Co-sign

The human decision on a shipped run — merging or closing its pull request,
executed through the gate (`fleet cosign`). Distinct from [PR live
state](#pr-live-state): the co-sign is the act; the PR's live state is the
evidence of it.

## PR live state

GitHub's current answer about a shipped run's pull request — open, merged, or
closed, and by whom. Fetched live at render time and never recorded in the
ledger (the merge happens after the run, so GitHub stays the source of truth).
Formerly also called "Cosign" in code, which collided with the co-sign
*result*; the canonical name is now PR live state (`PrLiveState`).
