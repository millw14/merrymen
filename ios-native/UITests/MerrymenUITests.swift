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
        XCTAssertTrue(app.buttons["Iniciar sesión"].waitForExistence(timeout: 8))
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
        XCTAssertTrue(app.buttons["Sign in"].waitForExistence(timeout: 5))
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
}
