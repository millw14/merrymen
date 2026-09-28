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
}
