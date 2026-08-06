# On-ramp: from "I don't trust this" to co-signing a fleet PR

This is the designed first encounter with the fleet, written for the
skeptical engineer — the one with the cursor over the merge button who hasn't
pressed it yet. Nothing here asks for trust up front. Each step lets you
watch the system work before the next one asks slightly more of you.

The graded tasks live in [`tasks/onramp/`](tasks/onramp) — all three are
`risk: drudgery` (tests-only, mechanically scoped to a single file) against
`demo-feed-service`.

## 1. Watch, don't merge

Run the first task as a dry run. Nothing leaves your machine — no branch, no
PR, no network side effects:

```sh
pnpm fleet run tasks/onramp/onramp-1-feed-tests.md --repo demo-feed-service
```

Then read what a reviewer would have been given:

```sh
cat artifacts/onramp-1-feed-tests/demo-feed-service/pr-preview.md
cat artifacts/onramp-1-feed-tests/demo-feed-service/diff.patch
```

`pr-preview.md` is the *exact* PR body a real run would open, built from this
run's real verify results. Check it against the diff: can you answer **what
changed / why / what was deliberately not touched / what was proven / how
you'd undo it** without reading the diff? That's the contract every fleet PR
has to meet.

## 2. First co-sign

Run the second task for real:

```sh
pnpm fleet run tasks/onramp/onramp-2-args-tests.md --repo demo-feed-service --pr
```

Read the PR as it's presented. Note what you are being asked to do: co-sign a
change that was mechanically scoped and deterministically verified. Nothing
reviewed it for *intent* — that part is yours, and the body says so. If it
answers your questions and the diff is right, merge it.

**Then do the revert drill.** Press the **Revert** button on the merged PR —
once, for real. The point is to *feel* that undo is one step, not to believe
a README that says so. Re-merge the revert PR or discard it afterwards;
either way you now know the worst case is one click.

## 3. Read the kill log

```sh
pnpm fleet report
```

This is the other half of the record: what the fleet stopped *before anyone
reviewed it* — verify failures and scope violations, each with the
reason it died. A system that only showed you its successes would be
advertising; the kill log is why the successes mean something.

## 4. Graduate

Run a real task — a 004-class change on a real repo:

```sh
pnpm fleet run tasks/004-upstream-failure-mode-tests.md --repo demo-feed-service --pr
```

From here on you're using the fleet, not auditing it. If a wrong change ever
does get through, that is a fleet defect, not a reviewer failure — the PR
body carries the link for reporting it.
