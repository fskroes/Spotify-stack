---
id: 001-gates-unmet
title: Gate-mandating migration, gate unrunnable (e2e fixture)
targets: [demo-ts-service]
# Deliberately names a check no verifier can produce for this workspace. The
# run must still ship — a mandate is cheap to declare and must never be
# dangerous to declare — but its verification must report `inconclusive` with
# this name attached, rather than the green its passing checks would imply.
gates: [live-contract-check]
risk: drudgery
why: Fixture exercising an unmet gate mandate.
---

## End state

Fixture body — the mock engine ignores the prompt and applies its patch.

## Preconditions

None; this file only exists for the hermetic e2e suite.
