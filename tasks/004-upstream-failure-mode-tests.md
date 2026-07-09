---
id: 004-upstream-failure-mode-tests
title: Add backend tests for the upstream client failure modes
targets: [demo-feed-service]
# Encodes the lesson from this task's first live run: an attempt was vetoed
# for touching package-lock.json. Now the runner kills that mechanically.
scope: [tests/upstream.test.js]
risk: low
why: The upstream client's timeout/retry/error classification is load-bearing for every feed refresh but currently untested — regressions would ship silently.
---

## End state

`tests/upstream.test.js` covers the failure-mode behaviors of
`src/lib/upstream.js` that are currently untested. After this task,
each of the following behaviors has at least one test:

1. **Timeout classification**: when `fetch` rejects with an abort
   (`error.name === "AbortError"`) on every attempt, the public functions
   reject with an `UpstreamError` whose `code` is `"UPSTREAM_TIMEOUT"` and
   `statusCode` is `504`.
2. **Timeout retry**: an abort on the first attempt followed by a successful
   response on the second attempt succeeds (exactly 2 fetch calls).
3. **5xx retry then success**: a `500` response on the first attempt followed
   by a successful response on the second attempt succeeds (exactly 2 fetch
   calls).
4. **4xx is not retried**: a `422` response fails immediately with
   `code: "UPSTREAM_4XX"`, `upstreamStatus: 422`, and exactly 1 fetch
   call. (Note: `fetchFeed` retries 400/404 once with a fallback source by
   design — use a status like 422 to test the no-retry path, or test via
   `fetchItems`.)
5. **Empty result**: a `200` response whose body has no `results` causes
   `fetchItems` / `searchItems` to reject with
   `code: "UPSTREAM_NO_RESULT"` and `statusCode: 404`.
6. **No items in response**: a `200` response with an empty `results` array
   causes `fetchFeed` to reject with `code: "UPSTREAM_EMPTY"`.
7. **Degraded enrichment**: `resolveItems` returns the original item for any
   entry whose row in `body.results` is missing or lacks an `enriched` object,
   while still using enriched data for items that have one.

Existing tests are unchanged and still pass. No production code
(`src/`, `server.js`) is modified — this task is tests-only. If a test
reveals that the production code does not actually behave as described above,
do not "fix" the production code; skip that test and note the discrepancy in
your final reply instead.

## Preconditions

- Only add a test for a behavior that is not already covered in
  `tests/upstream.test.js`. If every behavior listed above is already
  tested, make no changes and end your reply with exactly:
  `NO_CHANGES_NEEDED`

## Examples

Tests are hermetic: mock `globalThis.fetch` and restore it in
`test.afterEach`, following the existing pattern in the file. Never perform
real network calls, and never rely on real timers for timeouts — simulate a
timeout by rejecting with an abort-shaped error:

```js
test("fetchItems classifies repeated aborts as UPSTREAM_TIMEOUT", async () => {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  };

  await assert.rejects(fetchItems("test-key", "topic"), (error) => {
    assert.ok(error instanceof UpstreamError);
    assert.equal(error.code, "UPSTREAM_TIMEOUT");
    assert.equal(error.statusCode, 504);
    return true;
  });
  assert.equal(attempts, 2); // one retry
});
```

Successful mock responses follow the existing shape:

```js
globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({ results: [{ id: "1", url: "https://example.com/1", title: "First" }] }),
});
```

## Verification

Call the `verify` tool after making your changes. The task is only complete
when `verify` reports success. Do not modify or delete existing tests to make
verification pass.

## Scope

Only add tests to `tests/upstream.test.js`. Do not modify production
code, other test files, dependencies, or configuration. In particular, never
touch `package.json` or `package-lock.json`, and do not create helper files —
everything belongs in the one test file. Do not refactor or reformat existing
tests.
