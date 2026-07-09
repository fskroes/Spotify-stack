import Foundation

public enum Greeting {
    /// Build a banner greeting for `name`.
    public static func banner(for name: String) -> String {
        var formatter = LegacyFormatter()
        formatter.uppercased = true
        formatter.trimmed = true
        let formatted = formatter.format(name)
        return "HELLO, \(formatted)!"
    }
}
