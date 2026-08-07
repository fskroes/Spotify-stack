# Strict parse of the archived ledger: what tolerance actually buys

**Measured 2026-08-07.** Against `fleet/ledger.jsonl` at 50 rows, spanning
2026-07-06T12:02:24Z to 2026-08-07T09:17:54Z.

## The question

[ADR-0026](../adr/0026-the-desktop-operator-is-deleted.md) deleted the desktop
operator, which killed the stated premise of
[ADR-0001](../adr/0001-tolerant-reader-wire-contract.md) — two machines at
different commits. The record then kept `@fleet/contract` on a *new* premise:
the ledger is append-only, so today's reader must parse rows written by older
runners.

Nobody had tested that. This is the test.

## Method

A strict variant of `LedgerEntrySchema` was built by hand: every object
`.strict()` (unknown keys rejected) and every `.optional()` removed. All 50
archived rows were parsed through it, and the failures bucketed by field.

Three axes were measured separately, because "tolerant reader" names three
different mechanisms and they do not stand or fall together.

`InflightRecordSchema` was **not** measurable: `fleet/inflight/` is empty and
holds no archive. A record there is written and unlinked inside one run, by one
process, from one checkout.

## Result

| Axis | Rows that need it |
|---|---|
| Unknown-key tolerance — a row carries a key the schema does not declare | **0 / 50** |
| Open vocabulary — a row carries a value this build does not know | **0 / 50** |
| Optional degradation, for a **time** reason | **7 / 50** |
| Optional degradation, for a **domain** reason | the remaining rows |

### Axis 1 — unknown keys: zero

Every key present in the archive is declared in the schema. The archive holds 21
distinct keys; the schema declares all 21.

Fields whose producer is dead survive by being **declared**, not by being
tolerated: `actionsRunId` / `actionsArtifact` (2 rows, both cloud runs before
ADR-0024), `mode: "cloud"` (2 rows), `vetoes` (50 rows, zero on every one),
`timings.judgeMs` (30 rows non-zero), `modelUsage.judge` (32 rows).

### Axis 2 — open vocabularies: zero

No archived row carries a `status`, `mode`, `verifyState`, usage `availability`
or `billingSources` value outside the current build's known list. Status
histogram: `approved` 40, `verify-failed` 5, `no-changes` 4, `engine-failed` 1.
`vetoed` never occurs — in 50 runs the judge never killed one, which is the same
finding [ADR-0025](../adr/0025-the-judge-is-deleted-and-verify-is-the-last-gate.md)
deleted it on.

### Axis 3 — optional fields: seven rows, and only the oldest

Seven rows fail a no-optionals parse for a reason that is about *when they were
written* rather than *what happened in the run*:

| Row | Date | Fields absent |
|---|---|---|
| 0 | 2026-07-06 | `runId`, `elapsedMs`, `timings`, `modelUsage`, `verifyState` |
| 1 | 2026-07-06 | above, plus `title` |
| 2 | 2026-07-06 | above, plus `title` |
| 3–5 | 2026-07-08 | `runId`, `modelUsage`, `verifyState` |
| 6 | 2026-07-21 | `verifyState` |

Each of these fields is absent on a **contiguous prefix** of the oldest rows and
present on every row after — the signature of a field added later, not of a fact
that varies per run.

Every other absence is domain-conditional and always was: `prUrl` on the 30 rows
that opened no PR, `reason` on the 44 non-kills, `sha` on the 31 that committed
nothing, `amendments` on the 41 that exercised none, `evidence` and `verifyState`
on the 4 `no-changes` runs where nothing verified.

## What this shows

**The tolerant reader has never been exercised, and cannot be.** With the
operator deleted there is one reader, always at HEAD of the same repo as every
past writer. A newer-writer/older-reader pair is no longer a state this
architecture can reach. Unknown-key tolerance and open vocabularies guard
against version skew that has produced zero events in 50 rows and has no
remaining mechanism to produce one.

**Optional fields are load-bearing, and are not tolerance.** Seven rows genuinely
need them. That is ordinary schema design — a field added in July does not exist
in a row written in July — and it survives on its own merits, without ADR-0001.

**ADR-0026's rescue was half right, and the wrong half.** The archive does hold
rows older than the schema. What carries them is `.optional()`, which no
argument was needed to keep. The mechanism ADR-0001 is named for carries none
of them.

## Where tolerance is still justified

One wire in this repo has a producer that is not this repo: Anthropic's Claude
CLI `--output-format json` envelope, read in
`packages/runner/src/cli-envelope.ts`. That producer can change shape without a
commit here. It has a name, and its reader stays forgiving.

That is the whole surviving case, and it is the test any future claim of
tolerance has to pass: **name the producer this repo does not control.**

## What was done with the result

[ADR-0027](../adr/0027-the-wire-contract-package-is-deleted.md) — the package is
deleted, the shapes moved next to their writer, and ADR-0001 is superseded.
