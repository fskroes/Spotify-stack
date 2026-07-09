import XCTest
@testable import DemoKit

final class FormatterTests: XCTestCase {
    func testFormatWithNoOptionsReturnsInput() {
        XCTAssertEqual(Formatter.format("  Ada "), "  Ada ")
    }

    func testFormatUppercased() {
        XCTAssertEqual(Formatter.format("Ada", options: [.uppercased]), "ADA")
    }

    func testFormatTrimmedAndUppercased() {
        XCTAssertEqual(
            Formatter.format("  Ada \n", options: [.trimmed, .uppercased]),
            "ADA"
        )
    }
}

final class GreetingTests: XCTestCase {
    func testBannerTrimsAndUppercases() {
        XCTAssertEqual(Greeting.banner(for: "  Ada "), "HELLO, ADA!")
    }

    func testBannerWithCleanInput() {
        XCTAssertEqual(Greeting.banner(for: "Grace"), "HELLO, GRACE!")
    }
}
