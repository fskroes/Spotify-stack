# demo-ts-service

A small demo TypeScript service used as a target repository for the
background coding agent fleet. It intentionally contains a deprecated module
(`src/legacy/httpClient.ts`) alongside its replacement (`src/http.ts`) so
migration tasks have real work to do.

## Checks

```sh
npm run lint
npm run typecheck
npm run test
```
