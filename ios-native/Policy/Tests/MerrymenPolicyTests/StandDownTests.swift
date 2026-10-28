import XCTest
@testable import MerrymenPolicy

final class StandDownTests: XCTestCase {
    let owner = "0x1111111111111111111111111111111111111111"

    func testStandDownNamesItsPurposeAndTheWalletThatConfirmed() throws {
        let body = try XCTUnwrap(StandDown.body(owner: owner))
        XCTAssertEqual(body, .object(["purpose": .string("delete-agent"), "expectedTenant": .string(owner)]))
        // What the hosted route parses, and never the bare {} it refuses with 400.
        let sent = try JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: String]
        XCTAssertEqual(sent, ["purpose": "delete-agent", "expectedTenant": owner])
        for other in ["", "someone else", "0x1234", owner + "1", " " + owner] { XCTAssertNil(StandDown.body(owner: other), other) }
    }

    /// The app target cannot be imported here, so its sources are read: every
    /// DELETE /api/grants is built by StandDown, never by hand.
    func testEveryGrantDeleteInTheAppSendsTheStandDownBody() throws {
        let sources = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources")
        var found = 0
        for file in try FileManager.default.contentsOfDirectory(at: sources, includingPropertiesForKeys: nil) where file.pathExtension == "swift" {
            let text = try String(contentsOf: file, encoding: .utf8)
            for line in text.components(separatedBy: .newlines) where line.contains("\"/api/grants\"") && line.contains("\"DELETE\"") {
                found += 1
                XCTAssertFalse(line.contains(".object("), "\(file.lastPathComponent): \(line.trimmingCharacters(in: .whitespaces))")
                XCTAssertTrue(text.contains("StandDown.body(owner:"), "\(file.lastPathComponent) sends a stand-down StandDown did not build")
            }
        }
        XCTAssertGreaterThan(found, 0, "no stand-down found under \(sources.path)")
    }
}
