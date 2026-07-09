# demo-feed-service

A small demo Node service used as a target repository for the background
coding agent fleet. It serves Atom feeds built from an upstream content API.
Several load-bearing modules intentionally have thin or missing test
coverage, so tests-only fleet tasks (the `onramp-*` tasks and
`004-upstream-failure-mode-tests`) have real work to do:

- `src/lib/feed.js` — Atom XML builder (untested)
- `src/lib/args.js` — CLI argument parser (untested)
- `src/lib/config.js` — env config with silent fallbacks (edge cases untested)
- `src/lib/upstream.js` — upstream client retry/timeout/error classification
  (failure modes untested)

## Checks

```sh
npm test
```
