import XCTest
@testable import MerrymenPolicy

final class ChatStreamTests: XCTestCase {
    func testCommandsAndReasoningNeverAppearInPartialText() throws {
        var stream = ChatStream()
        for line in ["event: text", #"data: {"t":"<think>private reasoning</think>Wait <"}"#, ""] { try stream.line(line) }
        XCTAssertEqual(stream.visible, "Wait ")
        for line in ["event: text", #"data: {"t":"<CMD buy {}>>"}"#, ""] { try stream.line(line) }
        XCTAssertEqual(stream.visible, "Wait ")
        XCTAssertNil(stream.finished)
        for line in ["event: done", #"data: {"reply":"Wait for confirmation.","command":{"id":"buy","args":{"symbol":"NVDA"}}}"#, ""] { try stream.line(line) }
        XCTAssertEqual(stream.finished?["reply"].text, "Wait for confirmation.")
    }
    func testAProviderErrorDoesNotBecomeACompletedAnswer() throws {
        var stream = ChatStream()
        try stream.line("event: error"); try stream.line(#"data: {"detail":"a private upstream detail"}"#)
        XCTAssertThrowsError(try stream.line(""))
        XCTAssertNil(stream.finished)
    }
}
