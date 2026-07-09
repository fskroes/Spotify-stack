---
id: onramp-1-feed-tests
title: Add unit tests for the feed builder
targets: [demo-feed-service]
scope: [tests/feed.test.js]
risk: drudgery
why: buildFeed generates every Atom feed the service publishes and has zero tests — XML-escaping or entry regressions would ship silently.
---

## End state

A new file `tests/feed.test.js` covers `buildFeed` from `src/lib/feed.js`. After
this task, each of the following behaviors has at least one test:

1. **Entries**: given two items, the output contains exactly one
   `<entry>` element per item, with `<id>` and `<link>` values matching the
   input `id` / `url` values.
2. **XML escaping**: a feed title containing `&`, `<`, and `"` appears in the
   output escaped (`&amp;`, `&lt;`, `&quot;`) inside both the feed `<title>`
   and each entry `<title>` — the raw characters must not appear in the
   output.
3. **Document shape**: the output starts with the `<?xml` declaration,
   declares the `http://www.w3.org/2005/Atom` namespace, and contains an
   `<updated>` element.
4. **Empty feed**: `buildFeed({ title: "Empty", items: [] })` still produces a
   document with a `<feed>` element and no `<entry>` elements.

Existing tests are unchanged and still pass. No production code is modified —
this task is tests-only.

## Preconditions

- If `tests/feed.test.js` already exists, make no changes and end your reply
  with exactly: `NO_CHANGES_NEEDED`

## Examples

Follow the conventions of the existing test files (`node:test` +
`node:assert/strict`, ESM imports):

```js
import test from "node:test";
import assert from "node:assert/strict";
import { buildFeed } from "../src/lib/feed.js";

test("buildFeed escapes XML special characters in the feed title", () => {
  const feed = buildFeed({
    title: 'News & <Updates> "daily"',
    items: [{ id: "1", url: "https://example.com/1", title: "First" }],
  });

  assert.ok(feed.includes("News &amp; &lt;Updates&gt; &quot;daily&quot;"));
  assert.ok(!feed.includes('<title>News & <Updates>'));
});
```

Tests are hermetic: `buildFeed` is a pure string builder — no network, no
filesystem, no timers.

## Verification

Call the `verify` tool after making your changes. The task is only complete
when `verify` reports success. Do not modify or delete existing tests to make
verification pass.

## Scope

Only create `tests/feed.test.js`. Do not modify production code, other test
files, dependencies, or configuration. In particular, never touch
`package.json` or `package-lock.json`, and do not create helper files.
