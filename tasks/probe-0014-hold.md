---
id: probe-0014-hold
title: Add a regression test for parseArgs values that begin with a dash
targets: [demo-feed-service]
scope: [tests/base-probe.test.js]
risk: drudgery
why: parseArgs must keep a value like -7d rather than read it as the next flag, and nothing covers that today.
---

## End state

A new file `tests/base-probe.test.js` covers one behaviour of `parseArgs` from
`src/lib/args.js`: a value that merely begins with a dash is kept as the value,
not treated as the next flag.

`parseArgs(["--since", "-7d"])` must yield `{ since: "-7d" }`.

## Constraints

- Add the test file only. Do not change `src/lib/args.js`.
- Use `node:test` and `node:assert/strict`, matching the other files in `tests/`.

## Why this task exists

This is a **probe of the runner**, not of the target. Its diff is a single new
test file, so every path in it is a
[gate input](../CONTEXT.md#gate-input) and the task declares no `amends:`.
The verification tree therefore holds the whole diff at the base
([ADR-0014](../docs/adr/0014-gate-inputs-are-carried-only-under-an-amendment.md)),
and the run is expected to report a green that says nothing about the change.

Observing what the judge and the PR header do with that is the point. The PR is
closed, not merged.
