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
        for raw in ["https://evil.example/home", "http://app.merrymen.dev/home", "https://app.merrymen.dev:444/home", "https://user@app.merrymen.dev/home", "merrymen://app/api/auth/logout", "merrymen://evil/home", "merrymen://app/a/a/b", "javascript:alert(1)", "merrymen://app/t/%252e%252e", "merrymen://app/connect/approve/prp_123", "merrymen://app/connect/approve/prp_0123456789abcdef0123456789abcdef/x", "merrymen://app/connect/app"] {
            XCTAssertNil(URL(string: raw).flatMap(policy.deepLink), raw)
        }
        XCTAssertEqual(policy.deepLink(URL(string: "merrymen://app/groupchat?token=secret#code")!)?.absoluteString, "https://app.merrymen.dev/groupchat")
        XCTAssertEqual(policy.deepLink(URL(string: "https://app.merrymen.dev/a/shogun")!)?.path, "/a/shogun")
        XCTAssertEqual(policy.deepLink(URL(string: "https://app.merrymen.dev/connect/approve/prp_0123456789abcdef0123456789abcdef?decision=approve")!)?.absoluteString, "https://app.merrymen.dev/connect/approve/prp_0123456789abcdef0123456789abcdef")
    }

    let xState = "i." + String(repeating: "Ab_-", count: 8)
    var xAuthorize: String { "https://x.com/i/oauth2/authorize?response_type=code&client_id=abc&redirect_uri=https%3A%2F%2Fapp.merrymen.dev%2Fconnect%2Fx&scope=tweet.read%20tweet.write%20users.read%20offline.access&state=\(xState)&code_challenge=xyz&code_challenge_method=S256" }

    func testXConnectOpensOnlyXsOwnAuthorizePage() {
        let policy = NavigationPolicy()
        XCTAssertTrue(policy.isXAuthorize(URL(string: xAuthorize)!))
        XCTAssertTrue(policy.isXAuthorize(URL(string: "https://twitter.com/i/oauth2/authorize?state=\(xState)")!))
        XCTAssertTrue(policy.isXAuthorize(URL(string: "https://X.com:443/i/oauth2/authorize")!))
        for raw in ["http://x.com/i/oauth2/authorize", "https://x.com.evil.test/i/oauth2/authorize", "https://evilx.com/i/oauth2/authorize",
                    "https://api.x.com/i/oauth2/authorize", "https://x.com./i/oauth2/authorize", "https://x.com@evil.test/i/oauth2/authorize",
                    "https://evil.test@x.com/i/oauth2/authorize", "https://user:pw@x.com/i/oauth2/authorize", "https://evil.test#@x.com/i/oauth2/authorize",
                    "https://evil.test?@x.com/i/oauth2/authorize", "https://x.com:8443/i/oauth2/authorize", "https://x.com/i/oauth2/authorize/../../evil",
                    "https://x.com/i/oauth2/authorizeX", "https://x.com/i/oauth2/authorize/", "https://x.com/oauth2/authorize",
                    "https://x.com/i/oauth2/authorize#state", "https://x.com%2Eevil.test/i/oauth2/authorize", "merrymen://x.com/i/oauth2/authorize",
                    "javascript://x.com/i/oauth2/authorize", "https://app.merrymen.dev/i/oauth2/authorize"] {
            XCTAssertFalse(URL(string: raw).map(policy.isXAuthorize) ?? false, raw)
        }
    }

    func testXConnectStateIsThisAppsOwnAndAppearsOnce() {
        let policy = NavigationPolicy()
        XCTAssertEqual(policy.xConnectState(URL(string: xAuthorize)!), xState)
        let web = xAuthorize.replacingOccurrences(of: "state=i.", with: "state=w.")
        for raw in [web, xAuthorize + "&state=\(xState)", "https://x.com/i/oauth2/authorize?client_id=abc",
                    "https://x.com/i/oauth2/authorize?state=i.short", "https://x.com/i/oauth2/authorize?state=i.\(String(repeating: "A", count: 31))%20",
                    xAuthorize.replacingOccurrences(of: "https://x.com", with: "https://x.com.evil.test")] {
            XCTAssertNil(policy.xConnectState(URL(string: raw)!), raw)
        }
    }

    func testXConnectCallbackIsOnlyTheAnswerToThisConnectAndNeverADeepLink() {
        let policy = NavigationPolicy()
        XCTAssertEqual(policy.xConnectAnswer(URL(string: "merrymen://x-connect?code=VGNibzFW_SWR-EZm01bjN1N3.dicWl:NUG1&state=\(xState)")!, state: xState), .approved(code: "VGNibzFW_SWR-EZm01bjN1N3.dicWl:NUG1"))
        XCTAssertEqual(policy.xConnectAnswer(URL(string: "merrymen://x-connect/?state=\(xState)&code=abc")!, state: xState), .approved(code: "abc"))
        XCTAssertEqual(policy.xConnectAnswer(URL(string: "merrymen://x-connect?error=access_denied&state=\(xState)")!, state: xState), .declined)
        for raw in ["merrymen://x-connect?code=abc&state=i.\(String(repeating: "Z", count: 32))", "merrymen://x-connect?code=abc",
                    "merrymen://x-connect?error=access_denied", "merrymen://x-connect?code=abc&code=def&state=\(xState)",
                    "merrymen://x-connect?code=abc&state=\(xState)&state=\(xState)", "merrymen://x-connect?state=\(xState)",
                    "merrymen://x-connect?code=&state=\(xState)", "merrymen://x-connect?code=a%20b&state=\(xState)",
                    "merrymen://x-connect?code=a%0Ab&state=\(xState)", "merrymen://app/x-connect?code=abc&state=\(xState)",
                    "merrymen://x-connect/evil?code=abc&state=\(xState)", "merrymen://evil@x-connect?code=abc&state=\(xState)",
                    "merrymen://x-connect:1?code=abc&state=\(xState)", "merrymen://x-connect?code=abc&state=\(xState)#frag",
                    "https://app.merrymen.dev/connect/x?code=abc&state=\(xState)", "walletconnect://x-connect?code=abc&state=\(xState)"] {
            XCTAssertNil(URL(string: raw).flatMap { policy.xConnectAnswer($0, state: xState) }, raw)
        }
        XCTAssertNil(policy.xConnectAnswer(URL(string: "merrymen://x-connect?code=abc&state=")!, state: ""))
        // The callback never routes anywhere through the deep-link path.
        for raw in ["merrymen://x-connect?code=abc&state=\(xState)", "merrymen://app/connect/x?code=abc&state=\(xState)",
                    "https://app.merrymen.dev/connect/x?code=abc&state=\(xState)", "merrymen://app/x-connect?code=abc&state=\(xState)"] {
            XCTAssertNil(policy.deepLink(URL(string: raw)!), raw)
        }
    }

    func testPostedLinksOpenOnlyOnePostOnX() {
        let policy = NavigationPolicy()
        XCTAssertTrue(policy.isXPostLink(URL(string: "https://x.com/robin_trades/status/1790000000000000001")!))
        for raw in ["http://x.com/robin_trades/status/1", "https://twitter.com/robin_trades/status/1", "https://x.com.evil.test/robin_trades/status/1",
                    "https://evil.test@x.com/robin_trades/status/1", "https://x.com/robin_trades/status/1?ref=evil", "https://x.com/robin_trades/status/1#x",
                    "https://x.com/robin_trades/status/abc", "https://x.com/robin_trades", "https://x.com/i/oauth2/authorize",
                    "https://x.com/a_handle_that_is_too_long/status/1", "https://x.com/robin_trades/status/1/photo/1", "javascript:alert(1)"] {
            XCTAssertFalse(URL(string: raw).map(policy.isXPostLink) ?? false, raw)
        }
    }
}
