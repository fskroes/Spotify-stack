# One status → facts table, not a switch per surface

A run's status carries domain facts — what coarse fate it rolls up to
(`shipped` / `killed` / `infra` / `neutral`) and which gate a kill died at
(`agent` / `scope` / `verify` / `judge`, or `null`). Those facts are declared
**once**, in `RUN_FACTS` in `@fleet/contract`, typed
`satisfies Record<RunStatus, RunFacts>`.

Every surface — funnel math, trend bars, the ledger HTML, the operator, the kill
log — reads that table. None re-derives the mapping.

## Considered options

**A `switch` on status per surface.** The default shape, and the reason this ADR
exists. It fails in a specific, quiet way: adding an eighth status compiles fine
everywhere, and each surface's forgotten `default:` branch renders it as
whatever that branch happens to say. A new kill silently counts as a ship on one
tab and as nothing on another. Nobody sees a type error; somebody eventually
sees a wrong number.

The `satisfies` constraint converts that into a **compile error at the table**:
adding or renaming a status is a build failure until its facts are stated. The
cost is one indirection; the purchase is that no status can slip through.

**Deriving the kill set by hand** (`["agent-failed", "verify-failed", "vetoed",
"scope-violation"]` written out). Rejected — that list would drift from the
table the first time a status changed fate. `KILL_STATUSES` is *computed* from
`kind === "killed"`, at both the type level and the value level, so the kill set
cannot disagree with the facts.

**Making `status` a hard enum on the wire.** Rejected, per
[ADR-0001](0001-tolerant-reader-wire-contract.md). A newer runner may end a run
in a way this reader has never heard of, and that must degrade, not reject. So
`status` travels as a plain string and `runFacts(status)` returns `undefined`
for an unknown one — the tolerant lookup. Known-value narrowing exists alongside
parsing, never inside it.

**Merging the in-flight `stage` with the terminal one.** Rejected: they answer
different questions in different tenses. `TERMINAL_STAGES` is past-tense and
exists only for kills, which is why `shipping` is not a member — a run only
reaches shipping once it has already passed every gate, so nothing can die
there. Collapsing them would create a state that cannot occur.

## Consequences

- **Adding a run status is a deliberate act**, not an incremental one. You will
  be stopped at the table and made to state the new status's fate and death
  gate. That is the feature.
- A surface encountering an unknown status must render it **neutrally** — not as
  a ship, not as a kill, not as an error. `runFacts` returning `undefined` is the
  normal skew case, not a bug.
- The table is domain truth, not presentation: it says what a status *means*, not
  what colour to draw it. Surfaces still own their own rendering.
