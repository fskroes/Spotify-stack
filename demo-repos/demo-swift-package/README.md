# demo-swift-package

A small demo SwiftPM package used as a target repository for the background
coding agent fleet. It intentionally contains a deprecated type
(`LegacyFormatter`) alongside its replacement (`Formatter`) so migration tasks
have real work to do.

## Checks

```sh
swift build
swift test
```
