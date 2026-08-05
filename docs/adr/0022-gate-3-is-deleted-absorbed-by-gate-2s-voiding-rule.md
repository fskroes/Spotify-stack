# Gate 3 is deleted, absorbed by gate 2's voiding rule

The panel's road to phase two (the thread adapter) was priced at three
numbered gates. These are **panel gates** — decision thresholds — not the
[mandated gates](../../CONTEXT.md#mandated-gate) of the verifier; the two
concepts share a word and nothing else. This record deletes panel gate 3.

**The decision.** Gate 3 asked "is the instrument telling the truth at all?"
and voided gate 2 when the `unreviewed` rate was high and rising. It is
deleted because it is subsumed, provably: the threshold addendum in
[the signed requirements doc](../2026-08-05-step-1-requirements-named.md)
rules that **one** `unreviewed` row voids gate 2's zero-failure form
immediately. A trend needs at least two points to exist, so gate 3 could
never fire before gate 2's own voiding rule. A gate that can never fire
first flips no decision, and a requirement that flips no decision does not
survive.

**Phase two's price is restated.** The lock was "all three gates". It is now:
gate 1 answered ([it is — 14 minutes median](../2026-08-05-gate-1-computed.md)),
and gate 2 decidable *and decided*. The instrument-truth check rides inside
gate 2's voiding rule.

**What gate 2 now alone carries, re-owned.** Gate 2 flips at
`GATE_2_DECIDABLE_AT` (= 30) rows with zero `unreviewed`, held in
`packages/intake/src/correction-log.ts`. The reconvene number at one failure,
≈47, is **derived** — the rule of three generalised to one observed failure —
not hand-set; recompute it, never restate it from memory. With gate 3 gone,
gate 2's voiding rule is also the system's only instrument-truth check.
Owner of that enlarged scope, re-chosen with this record: **Fernando Silva
Kroes**.

**The alternative that lost.** Recording this as a dated-doc addendum, under
the standing rule "no new ADR before the next shipped merge". The rule's
owner reconciled it with this case and chose the ADR: deleting a numbered
gate from the process that governs when phase two ships is a structural
change to the panel's own contract, and supersede-with-link-back — this
repo's only revision path for decisions — lives inside the ADR mechanism.
The standing rule stands for what it was written against: decision records
outrunning shipped work. It does not bar recording the deletion of a piece
of the decision process itself.

**What is superseded.** The sentence "Gate 3 inherits the same discipline: no
row count for it exists until it is written here with a decision it flips"
in the signed doc. Read strictly, that sentence already forbade gate 3 from
existing as a requirement — no number and no decision were ever written.
This record makes the consequence explicit and permanent.
