# Gate 1 computed: the merge wait is minutes, not hours — 2026-08-05

Gate 1 asks one question: is anything upstream of the PR worth optimising?
Its metric is the median wall-clock time from PR-open to co-signed merge.
`fleet cosign` is the only merge path, so GitHub's `mergedAt` is the co-sign
time. PR-open comes from GitHub's `createdAt`; the ledger's `ts` agrees with
it to the second on every row.

## Population

Eight PRs merged to the two private fleet targets (named here as A and B —
this repo does not carry their names). Excluded: three merges to the public
demo target (two under a minute, one a 9.8-day cloud-probe PR left open by
hand), and one probe PR closed unmerged. Demo merges measure nothing about
the operator's review; the probe outlier measures neglect, not process.

## Data

| PR | Open → co-signed merge |
|---|---|
| A #94 | 13 min 55 s |
| A #95 | 9 min 06 s |
| B #92 | 19 min 35 s |
| A #96 | 5 min 49 s |
| A #97 | 23 min 32 s |
| B #93 | 18 min 32 s |
| B #94 | 14 min 06 s |
| A #98 | 3 min 16 s |

**Median 14 min 00 s** (min 3 min 16 s, max 23 min 32 s, n = 8).

## What the number decides

The gate's own framing: "if the median wait is hours, the front door is
decoration." The wait is fourteen minutes. The PR-to-merge segment is not the
bottleneck, so upstream of the PR — drafting, the run itself, the verify
loop — is where the wall-clock lives, and optimising it is not decoration.

One caveat the number carries: every merge so far happened in a same-evening
sitting, with the operator already at the keyboard. The median measures the
review itself, not the wait for a reviewer to arrive. If runs ever ship while
the operator is away, recompute before trusting fourteen minutes.

This is a dated measurement. Do not revise it to agree with later data —
recompute in a new dated doc.
