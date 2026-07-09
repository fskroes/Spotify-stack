---
id: 001-scope-gate
title: Scope-gated migration (e2e fixture)
targets: [demo-ts-service]
# Deliberately excludes src/** — the good fixture patch touches src/, so a
# run with this task must die with scope-violation before verify/judge/PR.
scope: [test/**]
risk: drudgery
why: Fixture exercising the mechanical scope gate.
---

## End state

Fixture body — the mock engine ignores the prompt and applies its patch.

## Preconditions

None; this file only exists for the hermetic e2e suite.
