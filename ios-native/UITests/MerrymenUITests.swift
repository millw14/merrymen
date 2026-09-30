import XCTest

final class MerrymenUITests: XCTestCase {
    func testLargeTextNavigationAndRecovery() {
        let app = XCUIApplication(); app.launchArguments = ["-ui-testing", "-reset-tour", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]; app.launch()
        if app.buttons["Skip tour"].waitForExistence(timeout: 8) { app.buttons["Skip tour"].tap() }
        app.buttons["Profile"].firstMatch.tap()
        let recover = app.buttons["Recover an existing account"]
        for _ in 0..<6 { if recover.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(recover.isHittable); recover.tap()
        let old = app.buttons["Recover an older owner-key account"]
        for _ in 0..<5 { if old.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(old.isHittable); old.tap()
        XCTAssertTrue(app.secureTextFields["recovery-key"].waitForExistence(timeout: 8))
        XCTAssertFalse(app.buttons["Read recovery account"].isEnabled)
        capture(app, "Recovery available while signed out, with large text")
    }
    func testSpanishNavigationUsesSelectedLanguage() {
        let app = XCUIApplication(); app.launchArguments = ["-ui-testing", "-reset-tour", "-test-language", "es"]; app.launch()
        let skip = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "omitir")).firstMatch
        if skip.waitForExistence(timeout: 8) { skip.tap() }
        let profile = app.buttons["Perfil"].firstMatch
        XCTAssertTrue(profile.waitForExistence(timeout: 8)); profile.tap()
        XCTAssertTrue(app.buttons["Continuar con X"].waitForExistence(timeout: 8))
        capture(app, "Spanish native navigation")
    }
    func testGuestCanNavigateNativeTabsAndReadThesis() {
        let app = XCUIApplication(); app.launchArguments = ["-ui-testing", "-reset-tour"]; app.launch()
        XCTAssertTrue(app.buttons["Skip tour"].waitForExistence(timeout: 8)); app.buttons["Skip tour"].tap()
        XCTAssertTrue(app.staticTexts["A test thesis with a clear investment rationale."].waitForExistence(timeout: 8))
        capture(app, "Native thesis feed")
        app.tabBars.buttons["Home"].tap()
        XCTAssertTrue(app.buttons["Explore markets"].waitForExistence(timeout: 5))
        capture(app, "Native home")
        app.buttons["Explore markets"].tap()
        XCTAssertTrue(app.navigationBars["Markets"].waitForExistence(timeout: 5))
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.tabBars.buttons["Chat"].tap()
        XCTAssertTrue(app.textFields["Message your agent"].waitForExistence(timeout: 5))
        app.tabBars.buttons["Profile"].tap()
        XCTAssertTrue(app.buttons["Continue with X"].waitForExistence(timeout: 5))
        capture(app, "Native profile — guest")
    }
    func testTourDismissalSurvivesRelaunch() {
        let app = XCUIApplication(); app.launchArguments = ["-ui-testing"]; app.launch()
        if app.buttons["Skip tour"].waitForExistence(timeout: 3) { app.buttons["Skip tour"].tap() }
        app.terminate(); app.launch()
        XCTAssertFalse(app.buttons["Skip tour"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.tabBars.buttons["Feed"].exists)
    }
    func testChatProposalPrefillsOnlyAllowedFieldsAndIsNotRestored() {
        let app = XCUIApplication(); app.launchArguments = ["-ui-testing", "-signed-in", "-reset-tour", "-reset-chat"]; app.launch()
        if app.buttons["Skip tour"].waitForExistence(timeout: 8) { app.buttons["Skip tour"].tap() }
        app.tabBars.buttons["Chat"].tap()
        let input = app.textFields["Message your agent"]
        XCTAssertTrue(input.waitForExistence(timeout: 8)); input.tap(); input.typeText("Rename my agent")
        app.buttons["Send message"].tap()
        XCTAssertTrue(app.buttons["Review proposal"].waitForExistence(timeout: 10))
        app.buttons["Review proposal"].tap()
        let name = app.textFields["Agent name"]
        XCTAssertTrue(name.waitForExistence(timeout: 8)); XCTAssertEqual(name.value as? String, "New native name")
        XCTAssertEqual(app.switches["Trade with real funds"].value as? String, "0")
        capture(app, "Canonical chat proposal awaits settings confirmation")
        let review = app.buttons["Review changes"]
        for _ in 0..<12 { if review.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(review.isHittable); review.tap()
        XCTAssertTrue(app.buttons["Save changes"].waitForExistence(timeout: 5)); app.buttons["Save changes"].tap()
        XCTAssertTrue(app.staticTexts["Settings saved."].waitForExistence(timeout: 8))
        app.terminate(); app.launchArguments = ["-ui-testing", "-signed-in"]; app.launch()
        app.tabBars.buttons["Chat"].tap()
        XCTAssertTrue(app.staticTexts["You can review this name change."].waitForExistence(timeout: 8))
        XCTAssertFalse(app.buttons["Review proposal"].exists)
    }
    func testPrivateProfileOnlyShowsDollarsFromOwnerEndpoint() {
        let app = XCUIApplication(); app.launchArguments = ["-ui-testing", "-reset-tour"]; app.launch()
        if app.buttons["Skip tour"].waitForExistence(timeout: 8) { app.buttons["Skip tour"].tap() }
        XCTAssertTrue(app.buttons["Test agent"].waitForExistence(timeout: 8)); app.buttons["Test agent"].tap()
        XCTAssertTrue(app.staticTexts["Top trades"].waitForExistence(timeout: 8))
        XCTAssertFalse(app.staticTexts["Size"].exists)
        XCTAssertFalse(app.staticTexts["Realized P&L"].exists)
        app.terminate(); app.launchArguments = ["-ui-testing", "-signed-in", "-reset-tour"]; app.launch()
        if app.buttons["Skip tour"].waitForExistence(timeout: 8) { app.buttons["Skip tour"].tap() }
        XCTAssertTrue(app.buttons["Test agent"].waitForExistence(timeout: 8)); app.buttons["Test agent"].tap()
        XCTAssertTrue(app.staticTexts["Your private view. These trade sizes and dollars remain hidden from other viewers."].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["Size"].exists)
        XCTAssertTrue(app.staticTexts["Realized P&L"].exists)
    }
    /// Posting on X is opt-in through a warning that names the connected
    /// account. "Not now" must send nothing (the fixture refuses an enable that
    /// is not the first write since launch), and confirming must send exactly
    /// {action: enable, xUserId, owner, tz} with tz the device's own zone (the
    /// fixture refuses any other keys or zone). The app runs in Tokyo so the
    /// zone is a real place whatever the simulator is set to. The waiting
    /// post's Skip is named for VoiceOver and skips exactly that post.
    func testXPostingWarnsWithTheConnectedAccountAndSendsOnlyTheConfirmedConsent() {
        let app = XCUIApplication(); app.launchArguments = ["-ui-testing", "-signed-in", "-x-posting-test", "-reset-tour"]
        app.launchEnvironment["TZ"] = "Asia/Tokyo"; app.launch()
        if app.buttons["Skip tour"].waitForExistence(timeout: 8) { app.buttons["Skip tour"].tap() }
        XCTAssertTrue(app.staticTexts["Connected as @robin_trades"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["slow day on the charts. honestly the quiet ones are when i learn the most."].exists)
        let toggle = app.switches["Let my Merryman post on X"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 5)); XCTAssertEqual(toggle.value as? String, "0")
        let posting = app.staticTexts["Posting from @robin_trades — whichever X account is connected."]
        XCTAssertFalse(posting.exists)

        flip(toggle)
        let warning = app.alerts["Post on X as @robin_trades?"]
        XCTAssertTrue(warning.waitForExistence(timeout: 5))
        XCTAssertTrue(warning.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Your Merryman will post from whichever X account is connected — right now that's @robin_trades.")).firstMatch.exists)
        // The review window it promises is the planner's ten-minute floor, not "you'll see each one".
        XCTAssertTrue(warning.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Posts go out on their own, a few a day at most. Each one waits under Coming up for at least ten minutes first, and you can skip it there. Turn this off or disconnect X at any time.")).firstMatch.exists)
        XCTAssertFalse(warning.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "You'll see each one here")).firstMatch.exists)
        capture(app, "Posting on X warning names the connected account")
        warning.buttons["Not now"].tap()
        XCTAssertTrue(warning.waitForNonExistence(timeout: 5))
        XCTAssertEqual(toggle.value as? String, "0")
        XCTAssertFalse(posting.exists)

        flip(toggle)
        XCTAssertTrue(warning.waitForExistence(timeout: 5))
        warning.buttons["Let it post as @robin_trades"].tap()
        XCTAssertTrue(posting.waitForExistence(timeout: 8))
        XCTAssertEqual(toggle.value as? String, "1")
        XCTAssertFalse(app.alerts["Merrymen"].exists)
        capture(app, "Posting on X on for the confirmed account")

        // Skip says which post it skips (label "Skip post", the post as its
        // hint), never a bare "Skip" repeated once per draft.
        let skip = app.buttons["Skip post"]
        XCTAssertTrue(skip.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Skip"].exists)
        for _ in 0..<6 { if skip.isHittable { break }; app.swipeUp() }
        skip.tap()
        XCTAssertTrue(app.staticTexts["Nothing waiting to go out."].waitForExistence(timeout: 8))
        XCTAssertFalse(app.staticTexts["slow day on the charts. honestly the quiet ones are when i learn the most."].exists)
        XCTAssertFalse(app.alerts["Merrymen"].exists)
    }
    /// A SwiftUI Toggle's element spans its label; only the switch itself flips it.
    private func flip(_ toggle: XCUIElement) {
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
    }
    private func capture(_ app: XCUIApplication, _ name: String) {
        let screenshot = XCTAttachment(screenshot: app.screenshot()); screenshot.name = name; screenshot.lifetime = .keepAlways; add(screenshot)
    }
    func testTimedOutOrderIsReconciledAndCannotReplayAfterRelaunch() {
        let app = XCUIApplication(); app.launchArguments = ["-ui-testing", "-order-timeout", "-reset-order", "-reset-tour"]; app.launch()
        if app.buttons["Skip tour"].waitForExistence(timeout: 8) { app.buttons["Skip tour"].tap() }
        let amount = app.textFields["Amount in USDG, e.g. 5.00"]
        XCTAssertTrue(amount.waitForExistence(timeout: 8)); amount.tap(); amount.typeText("5.00")
        app.buttons["Review order"].tap()
        XCTAssertTrue(app.buttons["Submit order"].waitForExistence(timeout: 5)); app.buttons["Submit order"].tap()
        XCTAssertTrue(app.staticTexts["Queued"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["Review order"].isEnabled)
        capture(app, "Uncertain order reconciled without resubmission")
        app.terminate(); app.launchArguments = ["-ui-testing", "-order-timeout"]; app.launch()
        XCTAssertTrue(app.staticTexts["Queued"].waitForExistence(timeout: 12))
        XCTAssertFalse(app.buttons["Review order"].isEnabled)
    }
    func testAmbiguousCoinRequiresContractChoiceAndSeparateOrderReview() {
        let app = XCUIApplication(); app.launchArguments = ["-ui-testing", "-signed-in", "-snipe-test", "-reset-tour"]; app.launch()
        if app.buttons["Skip tour"].waitForExistence(timeout: 8) { app.buttons["Skip tour"].tap() }
        XCTAssertTrue(app.buttons["Find matching coins"].waitForExistence(timeout: 8)); app.buttons["Find matching coins"].tap()
        let choice = app.buttons["Check this contract"].firstMatch
        XCTAssertTrue(choice.waitForExistence(timeout: 8)); choice.tap()
        let review = app.buttons["Review buy order"]
        XCTAssertTrue(review.waitForExistence(timeout: 8)); review.tap()
        XCTAssertTrue(app.textFields["Amount in USDG, e.g. 5.00"].waitForExistence(timeout: 8))
        XCTAssertEqual(app.textFields["Amount in USDG, e.g. 5.00"].value as? String, "5.00")
        XCTAssertFalse(app.staticTexts["Queued"].exists)
        app.buttons["Review order"].tap()
        XCTAssertTrue(app.buttons["Submit order"].waitForExistence(timeout: 5))
        capture(app, "Resolved contract awaits explicit order confirmation")
        app.buttons["Cancel"].tap()
        XCTAssertFalse(app.staticTexts["Queued"].exists)
    }
    func testAssistantTradeShowsRealMoneyAndApprovesOnlyWhatWasShown() {
        let app = XCUIApplication(); app.launchArguments = ["-ui-testing", "-signed-in", "-approval-test", "-reset-tour"]; app.launch()
        if app.buttons["Skip tour"].waitForExistence(timeout: 8) { app.buttons["Skip tour"].tap() }
        XCTAssertTrue(app.staticTexts["Claude"].waitForExistence(timeout: 8))
        let link = app.textFields["Paste the approval link"]
        XCTAssertTrue(link.waitForExistence(timeout: 5)); link.tap()
        link.typeText("https://app.merrymen.dev/connect/approve/prp_0123456789abcdef0123456789abcdef")
        app.buttons["Open request"].tap()
        XCTAssertTrue(app.staticTexts["Waiting for your decision"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Real money")).firstMatch.exists)
        capture(app, "Assistant trade awaiting approval with real-money warning")
        let approve = app.buttons["Approve"].firstMatch
        for _ in 0..<6 { if approve.isHittable { break }; app.swipeUp() }
        approve.tap()
        XCTAssertTrue(app.buttons["Yes, approve"].waitForExistence(timeout: 5)); app.buttons["Yes, approve"].tap()
        XCTAssertTrue(app.staticTexts["Queued for your agent"].waitForExistence(timeout: 10))
    }
}
