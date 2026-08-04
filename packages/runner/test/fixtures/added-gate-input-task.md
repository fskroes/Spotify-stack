---
id: 001-added-gate-input
title: New test file, no amendment (e2e fixture)
targets: [demo-ts-service]
# Deliberately declares no `amends:`, and deliberately needs none. The fixture
# patch adds a test file the base does not have, and a gate that never existed
# cannot have been weakened — so there is nothing to license and nothing to hold
# (ADR-0021). The new test is carried into the verification tree and runs.
risk: drudgery
why: Fixture exercising a gate input the base never had.
---

## End state

Fixture body — the mock engine ignores the prompt and applies its patch.

## Preconditions

None; this file only exists for the hermetic e2e suite.
