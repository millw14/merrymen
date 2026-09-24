import XCTest

final class MerrymenUITests: XCTestCase {
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
    private func capture(_ app: XCUIApplication, _ name: String) {
        let screenshot = XCTAttachment(screenshot: app.screenshot()); screenshot.name = name; screenshot.lifetime = .keepAlways; add(screenshot)
    }
}
