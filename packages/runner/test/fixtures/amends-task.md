---
id: 001-amends
title: Gate-input change under an amendment (e2e fixture)
targets: [demo-ts-service]
# The licence, with the reason ADR-0014 requires. The fixture patch edits
# test/http.test.ts along with the source it asserts on; naming it here carries
# it into the verification tree instead of holding it at the base, so the change
# is verified as a whole and ships.
amends:
  "test/**": the assertion pinned a behaviour this task deliberately removes
risk: drudgery
why: Fixture exercising an amended gate input.
---

## End state

Fixture body — the mock engine ignores the prompt and applies its patch.

## Preconditions

None; this file only exists for the hermetic e2e suite.
