import XCTest
@testable import Merrymen

/// Posting on X copy and answers the screen builds from the server's words.
final class XPostingTests: XCTestCase {
    func testReplyConsentNamesTheAccountAndPromisesSelectiveReplies() {
        let identity = XPostingAccount.Identity(handle: "robin_trades", xUserId: "2244994945")
        XCTAssertEqual(XPostingAccount.replyFields(identity, enabled: true), ["action": .string("enable-replies"), "xUserId": .string("2244994945")])
        XCTAssertEqual(XPostingAccount.replyFields(identity, enabled: false)["action"], .string("disable-replies"))
        let warning = XPostingAccount.replyWarning(identity.handle, active: false)
        XCTAssertTrue(warning.contains("reply as @robin_trades to selected comments on its coin posts."))
        XCTAssertTrue(warning.contains("same daily limit as posts"))
        XCTAssertTrue(warning.contains("at least ten minutes"))
        XCTAssertFalse(warning.contains("tag it"))
        XCTAssertFalse(warning.contains("market figures"))
    }

    /// An agent the operator made active answers tags right away, so its warning
    /// says so, promises no review window, and says its answers may carry market
    /// figures from public data — word for word as the web's.
    func testActiveAgentReplyWarningDisclosesImmediateTagAnswers() throws {
        XCTAssertEqual(XPostingAccount.replyWarning("robin_trades", active: true), [
            "Your Merryman will reply as @robin_trades to selected posts that tag it, reply to it or quote it.",
            "It chooses which posts to answer; it won’t answer every one. Answers go out right away: they don’t wait under Coming up, so you can’t skip one first.",
            "It answers questions about the market, coins, how it trades and what it can do, and a hello, a thanks or a bit of chat in a short line of its own, from people who tag it, reply to it or quote it, a few times a day each: up to 60 answers a day on top of its posts, and at most six to one person a day. Answers carry no opt-out line, and it never answers someone who asked it to stop. Turn replies off at any time to stop answering.",
            "Answers may include market figures from public data (CoinGecko, GeckoTerminal, Fomo and Bitquery), such as a coin’s price, market cap, volume or recent change. Merrymen adds them as the data showed them; they are never advice."
        ].joined(separator: "\n\n"))
        XCTAssertTrue(XPostingAccount.replyHint("robin_trades", active: true).contains("right away"))
        XCTAssertTrue(XPostingAccount.replyHint("robin_trades", active: true).contains("reply to it or quote it"))
        // No promise to anyone that they can reply stop: replying or quoting is asking (2026-10-12).
        XCTAssertFalse(XPostingAccount.replyWarning("robin_trades", active: true).contains("can reply stop"))
        XCTAssertTrue(XPostingAccount.replyHint("robin_trades", active: false).contains("ten-minute review window"))
        let active = try JSONDecoder().decode(J.self, from: Data(#"{"available":true,"connected":true,"postingEnabled":true,"repliesAvailable":true,"repliesActive":true,"username":"robin_trades","xUserId":"123","upcoming":[],"recent":[]}"#.utf8))
        XCTAssertTrue(try XCTUnwrap(XPostingAccount(active)).repliesActive)
    }

    func testOlderAccountRepliesDefaultOffAndCommentLinksAreValidated() throws {
        let old = try JSONDecoder().decode(J.self, from: Data(#"{"available":true,"connected":true,"postingEnabled":true,"username":"robin_trades","xUserId":"123","upcoming":[],"recent":[]}"#.utf8))
        let account = try XCTUnwrap(XPostingAccount(old))
        XCTAssertFalse(account.replyEnabled)
        XCTAssertFalse(account.repliesAvailable)
        XCTAssertFalse(account.repliesActive)
        let current = try JSONDecoder().decode(J.self, from: Data(#"{"available":true,"connected":true,"postingEnabled":true,"replyEnabled":true,"repliesAvailable":true,"username":"robin_trades","xUserId":"123","upcoming":[{"id":1,"kind":"reply","body":"An answer","dueAt":1800000000000,"replyToTweetId":"456"},{"id":2,"kind":"reply","body":"Another answer","dueAt":1800000000000,"replyToTweetId":"javascript:alert(1)"}],"recent":[]}"#.utf8))
        let updated = try XCTUnwrap(XPostingAccount(current))
        XCTAssertTrue(updated.replyEnabled)
        XCTAssertTrue(updated.upcoming[0].isReply)
        XCTAssertEqual(updated.upcoming[0].commentLink?.absoluteString, "https://x.com/i/status/456")
        XCTAssertNil(updated.upcoming[1].commentLink)
    }

    /// The warning the owner confirms, word for word as the web shows it
    /// (web/src/terminal/XPosting.tsx). Paragraph three promises only the
    /// review window the planner keeps: at least ten minutes under Coming up.
    func testWarningNamesTheAccountAndPromisesOnlyTheTenMinuteWindow() {
        XCTAssertEqual(XPostingAccount.warning("robin_trades", active: false), [
            "Your Merryman will post from whichever X account is connected — right now that's @robin_trades.",
            "It writes its own posts: a hello first, then the odd casual thought and now and then a coin it bought and why. It never posts trade alerts, error messages, prices or amounts.",
            "Posts go out on their own, a few a day at most. Each one waits under Coming up for at least ten minutes first, and you can skip it there. Turn this off or disconnect X at any time.",
            "X may label accounts that post automatically, and may ask an account to verify itself the first time it posts about crypto."
        ].joined(separator: "\n\n"))
    }

    /// An agent the operator made active posts on the active cadence, so its
    /// warning says how much — word for word as the web's — and never "a few a
    /// day at most".
    func testActiveAgentPostingWarningSaysHowMuchItPosts() {
        XCTAssertEqual(XPostingAccount.warning("robin_trades", active: true), [
            "Your Merryman will post from whichever X account is connected — right now that's @robin_trades.",
            "It writes its own posts: a hello first, then a few reads on the market a day and a post for most coins it buys, and why. It never posts trade alerts or error messages, and its market reads and answers may carry market figures built from public data.",
            "Posts go out on their own, up to 12 a day and at least an hour apart. Each one waits under Coming up for at least ten minutes first, and you can skip it there. Turn this off or disconnect X at any time.",
            "X may label accounts that post automatically, and may ask an account to verify itself the first time it posts about crypto."
        ].joined(separator: "\n\n"))
        XCTAssertFalse(XPostingAccount.warning("robin_trades", active: true).contains("a few a day at most"))
        XCTAssertFalse(XPostingAccount.warning("robin_trades", active: true).contains("prices or amounts"))
        XCTAssertTrue(XPostingAccount.warning("robin_trades", active: false).contains("It never posts trade alerts, error messages, prices or amounts."))
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
