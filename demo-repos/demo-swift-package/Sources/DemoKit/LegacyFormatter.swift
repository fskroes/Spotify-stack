import Foundation

/// Deprecated configure-then-format string formatter.
///
/// Use `Formatter.format(_:options:)` instead. Trimming is applied before
/// uppercasing, matching `Formatter`.
public struct LegacyFormatter {
    public var uppercased = false
    public var trimmed = false

    public init() {}

    public func format(_ input: String) -> String {
        var result = input
        if trimmed {
            result = result.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if uppercased {
            result = result.uppercased()
        }
        return result
    }
}
