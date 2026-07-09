---
id: 002-swift-migrate-formatter
title: Migrate off LegacyFormatter and delete it
targets: [demo-swift-package]
scope: [Sources/**]
risk: low
why: LegacyFormatter is deprecated and scheduled for removal; every lingering call site blocks deleting it.
---

## End state

- No source file references `LegacyFormatter`.
- Every call site that used `LegacyFormatter` uses `Formatter` from
  `Sources/DemoKit/Formatter.swift` instead.
- The file `Sources/DemoKit/LegacyFormatter.swift` is deleted.
- All existing tests still pass unchanged.

## Preconditions

- Only act if `Sources/DemoKit/LegacyFormatter.swift` exists. If it does not
  exist, or nothing references `LegacyFormatter`, make no changes and end your
  reply with exactly: `NO_CHANGES_NEEDED`

## Examples

The legacy formatter uses a mutable configure-then-format pattern:

```swift
// before
var formatter = LegacyFormatter()
formatter.uppercased = true
let text = formatter.format(name)
```

The replacement takes options at the call:

```swift
// after
let text = Formatter.format(name, options: [.uppercased])
```

`LegacyFormatter` with no flags set corresponds to `Formatter.format(name)`
with no options. Preserve the exact output of each call site.

## Verification

Call the `verify` tool after making your changes. The task is only complete
when `verify` reports success (`swift build` and `swift test`). Do not modify
or delete existing tests to make verification pass.

## Scope

Only perform this migration. Do not refactor unrelated code, rename other
symbols, or alter test files.
