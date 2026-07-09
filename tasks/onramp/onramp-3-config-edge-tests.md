---
id: onramp-3-config-edge-tests
title: Add edge-case tests for server config parsing
targets: [demo-feed-service]
scope: [tests/config.test.js]
risk: drudgery
why: getServerConfig silently falls back to defaults on malformed env values; those fallbacks guard production boot but are untested.
---

## End state

`tests/config.test.js` additionally covers the fallback behavior of
`getServerConfig` from `src/lib/config.js` for malformed environment values.
After this task, each of the following behaviors has at least one test:

1. **Invalid log level falls back**: `LOG_LEVEL: "verbose"` yields the
   environment default (`"debug"` in development, `"info"` when
   `NODE_ENV: "production"`).
2. **Invalid log format falls back**: `LOG_FORMAT: "xml"` yields `"pretty"`
   in development.
3. **Non-numeric integers fall back**: `PORT: "not-a-port"` yields `3001`,
   and `RATE_LIMIT_MAX: "lots"` yields `0` in development and `200` when
   `NODE_ENV: "production"`.
4. **Production defaults without overrides**: with only
   `NODE_ENV: "production"` set, `trustProxy` is `1`, `rateLimitMax` is
   `200`, and `logFormat` is `"json"`.

This task only **adds** tests to the existing file. Existing tests are
unchanged and still pass. No production code is modified — this task is
tests-only.

## Preconditions

- Only add a test for a behavior that is not already covered in
  `tests/config.test.js`. If every behavior listed above is already tested,
  make no changes and end your reply with exactly: `NO_CHANGES_NEEDED`

## Examples

Follow the existing pattern in the file — plain objects passed as the `env`
argument, never mutations of `process.env`:

```js
test("getServerConfig falls back on an invalid LOG_LEVEL", () => {
  const config = getServerConfig({ LOG_LEVEL: "verbose" });
  assert.equal(config.logLevel, "debug");
});
```

Tests are hermetic: pass env objects to `getServerConfig`; no network and no
real environment mutation.

## Verification

Call the `verify` tool after making your changes. The task is only complete
when `verify` reports success. Do not modify or delete existing tests to make
verification pass.

## Scope

Only add tests to `tests/config.test.js`. Do not modify production code,
other test files, dependencies, or configuration. In particular, never touch
`package.json` or `package-lock.json`, and do not create helper files. Do not
refactor or reformat existing tests.
