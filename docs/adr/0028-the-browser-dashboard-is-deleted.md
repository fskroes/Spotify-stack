# The browser dashboard is deleted, and the terminal is the report

**Date of decision: 2026-08-07.** Completes
[ADR-0026](0026-the-desktop-operator-is-deleted.md), which kept
`fleet report --serve` without asking it the question it asked the operator app.

## The decision

**`fleet report` prints to a terminal, and that is the whole report surface.**
The HTML renderer, the live server, the SSE reload path and the in-flight render
are deleted, along with the `--html`, `--serve`, `--open`, `--out`, `--port` and
`--cosign` flags. A run no longer regenerates `artifacts/ledger.html` on
completion.

## Why, when ADR-0026 kept it

ADR-0026 deleted the operator app on the evidence that it was used "a couple of
times" and never in a shipping run. `--serve` is the same class of part — a
viewing surface, unmeasured — and it was kept in the same document without being
put to the same test.

Asking the owner "do you use this?" is not that test. It substitutes recollection
for evidence, from the least reliable witness available: the person who built it.
And a usage counter is worse — [ADR-0025](0025-the-judge-is-deleted-and-verify-is-the-last-gate.md)
established that instrumenting a part you are unsure about is a schedule for not
deciding.

So the deciding argument is the asymmetry, not a measurement:

- Wrong to delete → one `git revert`. The code is in history.
- Wrong to keep → 2,026 lines of viewing surface carried indefinitely, over a
  ledger that is **50 rows long**.

The ledger is a JSONL file. Fifty rows do not need 1,536 lines of renderer.

## The alternative that lost

**Delete `--serve` but keep `--html`.** Rejected as the same move ADR-0026
already rejected for the JSON API: it removes the caller and none of the weight.
`ledger-serve.ts` is 206 lines; `ledger-html.ts` is 1,536, and both flags sit on
it. Deleting the wrapper would have saved 350 lines and left the part.

**Keep it as the README's proof.** The repo's hero image was a screenshot of
this dashboard. That is a real cost and it is paid here: the screenshot is
deleted with the surface, and the README now shows the terminal output it
actually has. A picture of a deleted feature is a claim the code cannot support.

**Add verification state to the terminal report so the absence lock survives.**
Rejected — that is building a feature to preserve a test. See below.

## What went with it, and one lock that did not survive

`test/verify-absence.test.ts` is deleted. It was the oracle for
[ADR-0004](0004-verification-tri-state-and-mandated-gates.md)'s hardest case:
that a ledger line carrying **no** `verifyState` is never rendered as a gap for
a status that never reached verify, and never as green. It was written entirely
against `renderLedgerHtml`.

That lock is retired rather than re-pointed, because the risk it guarded is
gone with the renderer:

- The terminal report does not render verification state at all — it prints the
  tally and the kill log. There is no readout that can be wrong.
- The surface that *does* reach a human is the pull-request body, and
  `buildPrBody` takes `verifyState: VerifyState` as a **required** field. An
  absent state cannot reach it; the type forbids it. `pr.test.ts` already locks
  the inconclusive banner and the dropped "verified" claim.

This is the near-side retirement the sweep rules call for, done deliberately and
recorded here rather than discovered as a red build. **If a report surface ever
renders `verifyState` again, this lock comes back with it.**

`dedupeInflight` and `PrLiveState` are deleted too — both had exactly one
consumer, and it was `ledger-html.ts`.

## What this cost, measured

| | |
|---|---|
| Deleted | `ledger-html.ts` (1,536), `ledger-serve.ts` (206), their tests (284) |
| Also deleted | `test/verify-absence.test.ts` (128), the `renderLedgerHtml` block in `ledger.test.ts` (~225), `docs/fleet-ledger.png` |
| Added back | **nothing** |
| Tests | 474 → 433 |

Nothing was added back. By Musk's rule that means this cut could have gone
further, and the next place to look is named below.

## What this gives up, plainly

1. **No live view of a running job.** A run in progress is visible in its own
   terminal output and nowhere else.
2. **No co-sign state at a glance.** `--cosign` polled GitHub for merge state
   across every shipped PR. That state lives on the PRs themselves.
3. **No shareable HTML artifact of the record.** `fleet/ledger.jsonl` is the
   record, and it is a text file.

None of the three is a verification capability, and none can produce a false
green ([ADR-0004](0004-verification-tri-state-and-mandated-gates.md)).

## The part this leaves stranded

**The in-flight store now has no reader.** `fleet/inflight/<pid>.json` is
written by `run.ts` on every stage transition and swept on exit, and the only
code that ever read it back was the live render. `fleet status` does not read
it. `InflightRecordSchema`, `inflight.ts` and the `runId` reconcile field on the
ledger line all exist to serve a view that no longer exists.

Left standing here deliberately: it is a separate decision with its own
alternative (a human running `ls fleet/inflight/` to see whether a run is
alive), and it should be taken on its own, not folded into this one.

## Status

Reversible, and the reversal is named: **if reading the record in a terminal
turns out to be why a shipped run goes un-co-signed, a view comes back** — as a
renderer over the ledger, not as a server. Until then the record is a file and
the report is a command.
Owner: **Fernando Silva Kroes**.
