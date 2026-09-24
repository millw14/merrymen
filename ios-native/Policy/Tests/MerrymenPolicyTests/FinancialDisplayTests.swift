import XCTest
@testable import MerrymenPolicy

final class FinancialDisplayTests: XCTestCase {
    func testSmallNonzeroPricesStayDistinctFromZeroAndUnknown() {
        let locale = Locale(identifier: "en_US_POSIX")
        XCTAssertEqual(FinancialDisplay.tokenPrice(nil, locale: locale), "—")
        XCTAssertEqual(FinancialDisplay.tokenPrice(.nan, locale: locale), "—")
        XCTAssertEqual(FinancialDisplay.tokenPrice(-1, locale: locale), "—")
        XCTAssertEqual(FinancialDisplay.tokenPrice(0.00042, locale: locale), "$0.00042")
        XCTAssertTrue(FinancialDisplay.tokenPrice(1e-12, locale: locale).contains("e"))
        XCTAssertNotEqual(FinancialDisplay.tokenPrice(1e-12, locale: locale), FinancialDisplay.tokenPrice(0, locale: locale))
    }
}
