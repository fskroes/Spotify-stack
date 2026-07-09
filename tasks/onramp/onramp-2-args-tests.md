---
id: onramp-2-args-tests
title: Add unit tests for the CLI argument parser
targets: [demo-feed-service]
scope: [tests/args.test.js]
risk: drudgery
why: parseArgs backs every CLI entry point (feed generation, publishing) and has zero tests — a parsing regression would break all of them at once.
---

## End state

A new file `tests/args.test.js` covers `parseArgs` and `asArray` from
`src/lib/args.js`. After this task, each of the following behaviors has at
least one test:

1. **Key/value pairs**: `parseArgs(["--name", "daily"])` yields
   `{ name: "daily" }`.
2. **Boolean flags**: a `--flag` followed by another `--option` (or by
   nothing) yields `true` for that flag, e.g.
   `parseArgs(["--dry-run", "--name", "daily"])` yields
   `{ "dry-run": true, name: "daily" }`.
3. **Repeated keys collect into an array**:
   `parseArgs(["--tag", "a", "--tag", "b", "--tag", "c"])` yields
   `{ tag: ["a", "b", "c"] }`.
4. **Non-flag tokens are skipped**: tokens that do not start with `--` and are
   not the value of a preceding flag are ignored, e.g.
   `parseArgs(["stray", "--name", "daily"])` yields `{ name: "daily" }`.
5. **asArray**: `asArray(undefined)` is `[]`, `asArray("x")` is `["x"]`, and
   `asArray(["x", "y"])` is returned as-is.

Existing tests are unchanged and still pass. No production code is modified —
this task is tests-only.

## Preconditions

- If `tests/args.test.js` already exists, make no changes and end your reply
  with exactly: `NO_CHANGES_NEEDED`

## Examples

Follow the conventions of the existing test files (`node:test` +
`node:assert/strict`, ESM imports):

```js
import test from "node:test";
import assert from "node:assert/strict";
import { asArray, parseArgs } from "../src/lib/args.js";

test("parseArgs collects repeated keys into an array", () => {
  const args = parseArgs(["--tag", "a", "--tag", "b"]);
  assert.deepEqual(args, { tag: ["a", "b"] });
});
```

Tests are hermetic: `parseArgs` and `asArray` are pure functions — no
network, no filesystem, no timers.

## Verification

Call the `verify` tool after making your changes. The task is only complete
when `verify` reports success. Do not modify or delete existing tests to make
verification pass.

## Scope

Only create `tests/args.test.js`. Do not modify production code, other test
files, dependencies, or configuration. In particular, never touch
`package.json` or `package-lock.json`, and do not create helper files.
