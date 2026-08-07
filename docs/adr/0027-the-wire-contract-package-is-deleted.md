# The wire-contract package is deleted, and tolerance needs a named producer

**Date of decision: 2026-08-07.** Supersedes
[ADR-0001](0001-tolerant-reader-wire-contract.md) in full. Narrows
[ADR-0026](0026-the-desktop-operator-is-deleted.md), whose "what stays"
paragraph kept `@fleet/contract` on a premise this decision tested and rejected.

## The decision

**`@fleet/contract` does not exist.** The shapes live next to the code that
writes them: `packages/runner/src/wire.ts` for the ledger, the in-flight record
and the usage artifact; `packages/runner/src/cli-envelope.ts` for the one wire
this repo reads but does not write.

**A reader is forgiving only where the producer is named and is not this repo.**
Today that is exactly one: Anthropic's Claude CLI JSON envelope. Everything else
is parsed as an ordinary schema — required where a field is always written,
optional where a run may not produce it or a past runner did not have it.

## The measurement it rests on

[The strict parse of all 50 archived rows,
2026-08-07](../experiments/2026-08-07-strict-parse-of-the-archived-ledger.md):

| Axis | Rows needing it |
|---|---|
| Unknown-key tolerance | **0 / 50** |
| Open vocabulary — an unknown value | **0 / 50** |
| Optional fields, for a time reason | **7 / 50** |

ADR-0001 was written for skew between an operator app and a runner at different
commits. ADR-0026 deleted the app and rescued the package with a new reason —
skew across time — without testing it. The test says the archive does hold rows
older than the schema, and that plain `.optional()` carries all seven of them.
The mechanism ADR-0001 is named for carries none.

There is a structural reason behind the zero, and it outlives the count: with
one surface there is one reader, always at HEAD of the same repo as every past
writer. A newer-writer/older-reader pair is not a state this system can reach.

## The alternative that lost

**Narrow the package to plain schemas and keep it.** This is the safe move and
it was rejected on the evidence of the cut that produced this sweep: the
operator deletion removed 11,760 lines and had to add back 154, about 1.3%. A
cut that needs nothing rebuilt did not reach anything load-bearing. Narrowing
would have deleted roughly 120 lines of helpers and left the boundary — a
package, a dependency edge in two `package.json` files, an `index.ts` re-export
barrel, and a name that keeps asserting a seam that is gone.

**Delete the shapes too, and type the ledger inline where it is read.**
Rejected: the ledger is genuinely parsed back off disk, and it is the one record
this system may not read wrongly ([ADR-0004](0004-verification-tri-state-and-mandated-gates.md)
— a false green is the forbidden output). One declaration, parsed at one seam,
is what stops a hand-copied interface and a `JSON as T` cast from rendering
`undefined` as data. That was ADR-0001's real contribution and it survives here;
only the tolerance did not.

**Keep the judge and cloud fields out of the new file.** Rejected on the same
measurement that removed the tolerance: 32 archived rows carry a `judge` usage
rail, 30 carry a non-zero `judgeMs`, 2 carry `mode: "cloud"` and the Actions
provenance pair. A row is a record of what happened, and a reader that drops
those fields would silently rewrite runs that really did pay for a judge. They
stay declared, each commented with the ADR that killed its producer.

The judge's *artifact* schemas went the other way. `VerdictEvidenceSchema`,
`JudgeIdentitySchema` and `JUDGE_CAPABILITIES` described `verdict.json`, and
**no archived ledger row carries any of them** — ADR-0025 kept them "for the
archived rows" they are not in. Nothing produces them, nothing parses them, and
their last reference was a test that imported one and never called it.

## What this cost, measured

| | |
|---|---|
| Deleted | `packages/contract` — **1,374 lines** (857 source, 517 test) |
| Added back | **1,074 lines** (652 across `wire.ts` and `cli-envelope.ts`, 422 of test) |
| Net | **−300 lines, and one fewer package** |
| Exported names | **87 → 43.** 44 removed, every one with zero references anywhere in the repo, tests included |
| Tests removed with the code they covered | 11 (485 → 474) |

What went was 6 `knownX` narrowing helpers, 8 open-vocabulary arrays, the judge
artifact schemas, `parseCosignStdout`, and the whole `parseWire` /
`safeParseWire` / `WireParseError` layer — an error type nothing outside the
package ever caught.

The add-back looks large at 78% because the comments moved with the shapes, and
those comments are why an absent field is readable as *not recorded* rather than
as a zero. The exports row is the honest measure of the cut: **half the
package's surface had no caller.**

`parseCosignStdout` deserves its own line. It read `fleet cosign --json` back
off SSH stdout, which was the operator's job; ADR-0026 ended that transport and
left the parser behind. The co-sign result is still emitted — it is now a plain
TypeScript type, because nothing in this repo reads it back.

## Consequences

- `packages/cli` imports the shapes from `@fleet/runner/wire`, and the envelope
  reader from `@fleet/runner/cli-envelope`. It already depended on the runner,
  so no new edge was created.
- The seam "runner ↔ its own past" is no longer a package boundary. It is a
  file, and the rule that guards it is in this ADR.
- Adding tolerance anywhere now requires naming the producer this repo does not
  control. "A future reader might" is not a name.

## Status

Reversible, and the reversal is named: **if a second surface is ever built that
reads this ledger from its own checkout, the skew premise returns and the
tolerant reader comes back with it** — as a package, if the boundary earns
itself twice. Until then there is one reader.
Owner: **Fernando Silva Kroes**.
