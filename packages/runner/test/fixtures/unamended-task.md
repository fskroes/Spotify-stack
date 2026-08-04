---
id: 001-unamended
title: Gate-input change with no amendment (e2e fixture)
targets: [demo-ts-service]
# Deliberately declares no `amends:`. The fixture patch weakens the assertion
# that would have caught its own source change, so the tree holds that test at
# the base and the run dies as an ordinary verify-failed (ADR-0014).
risk: drudgery
why: Fixture exercising an un-amended gate input held at the base.
---

## End state

Fixture body — the mock engine ignores the prompt and applies its patch.

## Preconditions

None; this file only exists for the hermetic e2e suite.
