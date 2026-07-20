---
id: 001-gates-met
title: Gate-mandating migration, gates satisfied (e2e fixture)
targets: [demo-ts-service]
# Names checks demo-ts-service really does emit, so every mandate is met and
# the run keeps the plain green it has earned. The control case for the unmet
# fixture: declaring gates must cost a run nothing when they actually run.
gates: [tsc, test]
risk: drudgery
why: Fixture exercising a satisfied gate mandate.
---

## End state

Fixture body — the mock engine ignores the prompt and applies its patch.

## Preconditions

None; this file only exists for the hermetic e2e suite.
