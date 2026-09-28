import XCTest
@testable import Merrymen

/// Posting on X copy and answers the screen builds from the server's words.
final class XPostingTests: XCTestCase {
    /// The warning the owner confirms, word for word as the web shows it
    /// (web/src/terminal/XPosting.tsx). Paragraph three promises only the
    /// review window the planner keeps: at least ten minutes under Coming up.
    func testWarningNamesTheAccountAndPromisesOnlyTheTenMinuteWindow() {
        XCTAssertEqual(XPostingAccount.warning("robin_trades"), [
            "Your Merryman will post from whichever X account is connected — right now that's @robin_trades.",
            "It writes its own posts: a hello first, then the odd casual thought and now and then a coin it bought and why. It never posts trade alerts, error messages, prices or amounts.",
            "Posts go out on their own, a few a day at most. Each one waits under Coming up for at least ten minutes first, and you can skip it there. Turn this off or disconnect X at any time.",
            "X may label accounts that post automatically, and may ask an account to verify itself the first time it posts about crypto."
        ].joined(separator: "\n\n"))
    }

    /// Consent carries the X user id the warning named and the device's zone
    /// by its IANA name — nothing else (the write adds the owner).
    func testEnableCarriesTheNamedAccountAndTheDeviceZone() throws {
        let identity = XPostingAccount.Identity(handle: "robin_trades", xUserId: "2244994945")
        let zone = try XCTUnwrap(TimeZone(identifier: "America/New_York"))
        XCTAssertEqual(XPostingAccount.enableFields(identity, zone: zone), ["action": .string("enable"), "xUserId": .string("2244994945"), "tz": .string("America/New_York")])
        let tokyo = try XCTUnwrap(TimeZone(identifier: "Asia/Tokyo"))
        XCTAssertEqual(XPostingAccount.enableFields(identity, zone: tokyo)["tz"], .string("Asia/Tokyo"))
    }

    /// Finishing a connect answers {ok, username, postingEnabled}. A reconnect
    /// of the same account keeps the consent, so posting is on again at once:
    /// the owner is told, naming the account. Anything short of a real `true`
    /// says nothing (the screen then shows the switch as the server reads it).
    func testFinishingAReconnectThatTurnsPostingBackOnSaysSo() throws {
        let answer = { (json: String) in try JSONDecoder().decode(J.self, from: Data(json.utf8)) }
        XCTAssertEqual(XPostingAccount.postingBackOn(try answer(#"{"ok":true,"username":"robin_trades","postingEnabled":true}"#)),
                       "Posting is back on — your Merryman posts from @robin_trades again. You can see what's coming up, skip it, or turn posting off here.")
        XCTAssertEqual(XPostingAccount.postingBackOn(try answer(#"{"ok":true,"username":"not a handle!","postingEnabled":true}"#)),
                       "Posting is back on — your Merryman posts from the X account you just connected again. You can see what's coming up, skip it, or turn posting off here.")
        for json in [#"{"ok":true,"username":"robin_trades","postingEnabled":false}"#, #"{"ok":true,"username":"robin_trades"}"#,
                     #"{"ok":true,"username":"robin_trades","postingEnabled":"true"}"#, #"{"ok":true,"username":"robin_trades","postingEnabled":1}"#,
                     #"{"ok":true,"username":"robin_trades","postingEnabled":null}"#] {
            XCTAssertNil(XPostingAccount.postingBackOn(try answer(json)), json)
        }
    }
}
