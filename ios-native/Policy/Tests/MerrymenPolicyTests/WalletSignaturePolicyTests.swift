import XCTest
@testable import MerrymenPolicy

final class WalletSignaturePolicyTests: XCTestCase {
    func testReceiptLookupCannotSignAnOperationOrAnArbitraryChallenge() {
        let owner = "0x1111111111111111111111111111111111111111"
        func permits(_ text: String) -> Bool {
            WalletSignaturePolicy.permitsPersonalSign(hex: "0x" + text.utf8.map { String(format: "%02x", $0) }.joined(), operation: "reconcile", owner: owner, did: "did:privy:test", expectedAccount: owner, nonce: "test_nonce")
        }
        let message = ["https://app.merrymen.dev — withdraw from your merrymen account.", "", "This proves you control the owner key so the site will relay your withdrawal.", "It moves no funds by itself and grants no permissions: the withdrawal itself", "is a separate operation you sign next.", "", "URI: https://app.merrymen.dev", "Nonce: test_nonce"].joined(separator: "\n")
        XCTAssertTrue(permits(message))
        XCTAssertFalse(permits(message.replacingOccurrences(of: "test_nonce", with: "other_nonce")))
        XCTAssertFalse(permits("Approve my spending request"))
        XCTAssertFalse(WalletSignaturePolicy.permitsPersonalSign(hex: "0x" + String(repeating: "01", count: 32), operation: "reconcile", owner: owner, did: "did:privy:test", expectedAccount: owner, nonce: nil))
    }
}
