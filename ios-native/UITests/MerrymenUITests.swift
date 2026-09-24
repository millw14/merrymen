import XCTest

final class MerrymenUITests: XCTestCase {
    func testGuestCanNavigateNativeTabsAndReadThesis() {
        let app = XCUIApplication(); app.launchArguments = ["-ui-testing"]; app.launch()
        XCTAssertTrue(app.buttons["Skip tour"].waitForExistence(timeout: 8)); app.buttons["Skip tour"].tap()
        XCTAssertTrue(app.staticTexts["A test thesis with a clear investment rationale."].waitForExistence(timeout: 8))
        app.tabBars.buttons["Home"].tap()
        XCTAssertTrue(app.buttons["Explore markets"].waitForExistence(timeout: 5))
        app.buttons["Explore markets"].tap()
        XCTAssertTrue(app.navigationBars["Markets"].waitForExistence(timeout: 5))
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.tabBars.buttons["Chat"].tap()
        XCTAssertTrue(app.textFields["Message your agent"].waitForExistence(timeout: 5))
        app.tabBars.buttons["Profile"].tap()
        XCTAssertTrue(app.buttons["Sign in"].waitForExistence(timeout: 5))
        let screenshot = XCTAttachment(screenshot: app.screenshot()); screenshot.name = "Native profile — guest"; screenshot.lifetime = .keepAlways; add(screenshot)
    }
    func testTourDismissalSurvivesRelaunch() {
        let app = XCUIApplication(); app.launchArguments = ["-ui-testing"]; app.launch()
        if app.buttons["Skip tour"].waitForExistence(timeout: 3) { app.buttons["Skip tour"].tap() }
        app.terminate(); app.launch()
        XCTAssertFalse(app.buttons["Skip tour"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.tabBars.buttons["Feed"].exists)
    }
}
