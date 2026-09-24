#if canImport(JavaScriptCore)
import XCTest
@testable import MerrymenPolicy

final class WalletRuntimeTests: XCTestCase {
    @MainActor
    func testUnfinishedOperationTimesOutAndCannotBeReused() async throws {
        let runtime = try WalletRuntime(bootstrap: "function __runWallet() {}", library: "")
        do {
            _ = try await runtime.call("withdraw", input: .null, timeout: .milliseconds(20))
            XCTFail("Unfinished operation succeeded")
        } catch { XCTAssertTrue(error.localizedDescription.contains("timed out")) }
        do {
            _ = try await runtime.call("withdraw", input: .null)
            XCTFail("A timed-out runtime was reused")
        } catch { XCTAssertTrue(error.localizedDescription.contains("timed out")) }
    }

    @MainActor
    func testAsyncExceptionFinishesPendingOperation() async throws {
        let runtime = try WalletRuntime(bootstrap: "function __runWallet() { throw new Error('test failure'); }", library: "")
        do { _ = try await runtime.call("plan", input: .null); XCTFail("Exception was ignored") }
        catch { XCTAssertTrue(error.localizedDescription.contains("test failure")) }
    }

    @MainActor
    func testShippedWalletLibraryLoadsAndRefusesMismatchedOwnerBeforeSigning() async throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let bootstrap = try String(contentsOf: root.appendingPathComponent("Resources/WalletRuntime.js"), encoding: .utf8)
        let library = try String(contentsOf: root.appendingPathComponent("Resources/WalletEngine.js"), encoding: .utf8)
        let runtime = try WalletRuntime(bootstrap: bootstrap, library: library)
        var calls = 0
        runtime.handle = { _, _ in calls += 1; throw WalletRuntimeError("No network/signature allowed in this test") }
        let capabilities = try await runtime.call("capabilities", input: .object([:]))
        XCTAssertEqual(capabilities["nativeScreens"].bool, true)
        do {
            _ = try await runtime.call("create", input: .object(["owner": .string("0x1111111111111111111111111111111111111111"), "tenant": .string("0x2222222222222222222222222222222222222222")]))
            XCTFail("Account mismatch was accepted")
        } catch { XCTAssertTrue(error.localizedDescription.contains("does not own")) }
        XCTAssertEqual(calls, 0)
    }
}
#endif
