import Foundation

/// Options for `Formatter.format(_:options:)`.
public enum FormatOption: Hashable {
    case uppercased
    case trimmed
}

/// The supported string formatter for this package.
public enum Formatter {
    /// Format `input` by applying the given options. Trimming is applied
    /// before uppercasing.
    public static func format(_ input: String, options: Set<FormatOption> = []) -> String {
        var result = input
        if options.contains(.trimmed) {
            result = result.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if options.contains(.uppercased) {
            result = result.uppercased()
        }
        return result
    }
}
