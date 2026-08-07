# The in-flight store is deleted; a run is visible in its own terminal

**Date of decision: 2026-08-07.** Takes the decision
[ADR-0028](0028-the-browser-dashboard-is-deleted.md) deliberately left standing
under "The part this leaves stranded".

## The decision

**A run publishes nothing about itself while it is running.** `fleet/inflight/`,
`inflight.ts`, `InflightRecordSchema`, the `STAGES` vocabulary and the
`InflightHandle` passed down through every pass are deleted. The runner no
longer sweeps the store at startup, stakes a claim before cloning, writes a
record on each stage transition, or installs the `SIGINT`/`SIGTERM` handlers
that existed to unlink that record.

To see whether a run is alive, look at the terminal it is running in.

## Why

The store had **no reader**. Its only one was the live render inside
`ledger-html.ts`, deleted the same day in ADR-0028. `fleet status` reads the
ledger and per-repo result files; `fleet report` reads the ledger. Nothing else
opened the directory. The module's own header named the consumer it had lost:

> …so `fleet report --serve` (a separate process) can render the funnel while
> tasks are still moving through it.

A writer with no reader is not a feature with low usage — it is a cost with no
benefit at all. There is nothing to measure and no threshold to wait for.

## The alternative that lost

**Build the reader back: `fleet status --live`, over the store that already
exists.** This is the tempting one, because the write path is finished, tested
and free — the only missing piece is ~30 lines that print the records.

Rejected, because the requirement does not survive being stated plainly: *the
operator needs to know whether a run is alive, from a different terminal than
the one running it.* One operator runs this fleet, from a machine they are
sitting at, one run at a time. The run prints `▶ task … on …`, then a line per
stage, into a terminal that is already open. `ls fleet/inflight/` — the whole
alleged capability — is answered by looking at that window.

Under ADR-0024's freeze this would also be new construction, and none of the
three named triggers has fired. But the freeze is not the reason. The reason is
that the store answers a question nobody is in a position to ask.

**Keep the writer, delete only the schema and the tests.** Rejected as the same
error ADR-0028 named: removing the caller and none of the weight. The 225-line
module *is* the weight.

## What this cost, measured

| | |
|---|---|
| Deleted | `inflight.ts` (225), `inflight.test.ts` (282), `InflightRecordSchema` + `STAGES` in `wire.ts` (~35), the wiring in `run.ts` |
| Added back | the `runId` half of one e2e test (~28 lines) |
| Tests | 433 → 418 |

`run.ts` loses its outer `try`/`finally` entirely: the block existed only to
clear the in-flight claim on the throw path, so 201 lines de-indent by two.

## What was kept, and why it is not part of this

**`runId` stays on the ledger line.** Its doc comment called it a reconcile key
— "so a reader can drop a live row the ledger has already superseded" — which
was only ever half true and is now the wrong half. Its real reader is
`cosign.ts`'s `findRun`: `fleet cosign <runId>` matches on this field, so it is
the one value a human copies out of the ledger by hand. Deleting it on the
strength of its own stale comment would have made every shipped run
un-co-signable, and no test outside the deleted one would have failed.

The e2e test that proved a run publishes its stage is replaced, not dropped,
by one that proves the appended row carries the runId the run reports. That was
the surviving half of the same test, and it was the only lock on the co-sign
path's key.

## What this gives up, plainly

1. **A crashed run leaves no trace of where it died** beyond its terminal
   scrollback and the ledger line it never wrote. Previously a stale
   `fleet/inflight/<pid>.json` would have said which stage.
2. **`Ctrl-C` no longer runs a cleanup handler.** Nothing needs cleaning: the
   handlers existed solely to unlink the record. Node's default disposition
   applies again, which is what the handler was re-simulating with
   `process.exit(128 + signo)`.
3. **Concurrent runs are invisible to one another.** They already were — the
   store was never a lock, and nothing consulted it before starting.

None of the three is a verification capability, and none can produce a false
green ([ADR-0004](0004-verification-tri-state-and-mandated-gates.md)).

## Status

Reversible; the code is in history. The trigger to reverse it is a real one:
**if runs ever become concurrent or move off the operator's own machine**, live
state stops being answerable by looking at a window, and a store comes back —
with a reader written in the same commit.
Owner: **Fernando Silva Kroes**.
