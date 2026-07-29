---
id: 001-judge-read
title: Migration judged over the CLI transport (e2e fixture)
targets: [demo-ts-service]
risk: drudgery
why: Fixture exercising the judge's read-capability launch checks (ADR-0011).
---

## End state

Fixture body — the mock engine ignores the prompt and applies its patch. Its own
task id is the point: a run of this fixture must not share a workspace or an
artifact directory with the suite's other end-to-end runs, which execute
concurrently.

## Preconditions

None; this file only exists for the hermetic e2e suite.
