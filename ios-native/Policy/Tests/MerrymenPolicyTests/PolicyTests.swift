import XCTest
@testable import MerrymenPolicy

final class PolicyTests: XCTestCase {
    let owner = "0x1111111111111111111111111111111111111111"
    func testFinancialInputNeverGuessesOrSilentlyRounds() {
        for amount in ["", "-1", "0", "1,000", "1e3", "NaN", "Infinity", "0.001", "1.001", "1000000001"] {
            XCTAssertNil(TradeInput.body(side: "buy", symbol: "NVDA", amount: amount, owner: owner), amount)
        }
        let value = TradeInput.body(side: "sell", symbol: " nvda ", amount: "5.25", owner: owner)
        XCTAssertEqual(value?["symbol"].string, "NVDA")
        XCTAssertEqual(value?["usdgAmount"].number, 5.25)
        XCTAssertEqual(value?["owner"].string, owner)
        XCTAssertEqual(value?["usdg"], .null)
        XCTAssertEqual(TradeInput.body(side: "buy", symbol: "NVDA", amount: "5,25", owner: owner)?["usdgAmount"].number, 5.25)
        XCTAssertNil(TradeInput.body(side: "transfer", symbol: "NVDA", amount: "5", owner: owner))
        XCTAssertNil(TradeInput.body(side: "buy", symbol: "ABC/DEF", amount: "5", owner: owner))
        XCTAssertEqual(TradeInput.body(side: "buy", symbol: "a.b-c_d", amount: "5", owner: owner)?["symbol"].string, "A.B-C_D")
        XCTAssertNil(TradeInput.body(side: "buy", symbol: String(repeating: "A", count: 17), amount: "5", owner: owner))
        XCTAssertNil(TradeInput.body(side: "buy", symbol: "NVDA", amount: "5", owner: "someone else"))
    }
    func testNullBalancesAndBooleanValuesAreNotCoerced() throws {
        let input = Data(#"{"balance":null,"zero":0,"read":false,"raw":"123456789012345678901234567890","defaults":{"live":false},"values":{"live":true}}"#.utf8)
        let v = try JSONDecoder().decode(JSONValue.self, from: input)
        XCTAssertNil(v["balance"].number)
        XCTAssertEqual(v["zero"].number, 0)
        XCTAssertNil(v["read"].number)
        XCTAssertEqual(v["read"].bool, false)
        XCTAssertNil(v["raw"].number)
        XCTAssertEqual(v["raw"].string, "123456789012345678901234567890")
        XCTAssertEqual(v.setting("live").bool, true)
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(v)), v)
    }
    func testDeepLinksCannotPerformActionsOrCarryCredentials() {
        let policy = NavigationPolicy()
        for raw in ["https://evil.example/home", "http://app.merrymen.dev/home", "https://app.merrymen.dev:444/home", "https://user@app.merrymen.dev/home", "merrymen://app/api/auth/logout", "merrymen://evil/home", "merrymen://app/a/a/b", "javascript:alert(1)", "merrymen://app/t/%252e%252e"] {
            XCTAssertNil(URL(string: raw).flatMap(policy.deepLink), raw)
        }
        XCTAssertEqual(policy.deepLink(URL(string: "merrymen://app/groupchat?token=secret#code")!)?.absoluteString, "https://app.merrymen.dev/groupchat")
        XCTAssertEqual(policy.deepLink(URL(string: "https://app.merrymen.dev/a/shogun")!)?.path, "/a/shogun")
    }
}
