---
id: 001-ts-migrate-http-client
title: Migrate off the deprecated legacy HTTP client and delete it
targets: [demo-ts-service]
scope: [src/**]
risk: low
why: The deprecated callback-based HTTP client is scheduled for removal; every lingering call site blocks deleting it.
---

## End state

- No source file imports anything from `src/legacy/httpClient.ts`.
- Every call site that used the legacy client uses `fetchJson` from
  `src/http.ts` instead.
- The file `src/legacy/httpClient.ts` is deleted. If the `src/legacy/`
  directory is empty afterwards, it is removed too.
- All existing tests still pass unchanged.

## Preconditions

- Only act if `src/legacy/httpClient.ts` exists. If it does not exist, or no
  file imports it, make no changes and end your reply with exactly:
  `NO_CHANGES_NEEDED`

## Examples

The legacy client uses a callback style:

```ts
// before
import { getJson } from "./legacy/httpClient.js";

getJson(`${baseUrl}/users/${id}`, (err, data) => {
  if (err) throw err;
  return data;
});
```

The replacement is promise-based:

```ts
// after
import { fetchJson } from "./http.js";

const data = await fetchJson(`${baseUrl}/users/${id}`);
```

Callers that wrapped the callback in a Promise can call `fetchJson` directly.
Preserve each call site's error-handling behavior: errors must still propagate
as rejected promises / thrown errors.

## Verification

Call the `verify` tool after making your changes. The task is only complete
when `verify` reports success (lint, typecheck, and tests). Do not modify or
delete existing tests to make verification pass.

## Scope

Only perform this migration. Do not refactor unrelated code, change formatting
of untouched files, or alter test files.
