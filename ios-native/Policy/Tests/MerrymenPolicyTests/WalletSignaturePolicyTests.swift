import XCTest
@testable import MerrymenPolicy

final class WalletSignaturePolicyTests: XCTestCase {
    func testRestoreBindingPinsBothAccountAndOwnerToTheServerNonce() {
        let owner = "0x1111111111111111111111111111111111111111", account = "0x2222222222222222222222222222222222222222"
        let message = ["https://app.merrymen.dev wants you to authorize a merrymen agent account.", "", "You are linking the agent wallet below to this login. It moves no funds.", "", "Agent account: \(account)", "Owner key: \(owner)", "Chain ID: 4663", "URI: https://app.merrymen.dev", "Nonce: challenge"].joined(separator: "\n")
        func allowed(_ text: String, operation: String = "restore", expected: String? = nil) -> Bool {
            WalletSignaturePolicy.permitsPersonalSign(hex: "0x" + text.utf8.map { String(format: "%02x", $0) }.joined(), operation: operation, owner: owner, did: "", expectedAccount: expected ?? account, nonce: "challenge")
        }
        XCTAssertTrue(allowed(message))
        XCTAssertFalse(allowed(message.replacingOccurrences(of: "challenge", with: "other")))
        XCTAssertFalse(allowed(message, expected: owner))
        XCTAssertFalse(allowed(message.replacingOccurrences(of: owner, with: account)))
        XCTAssertFalse(allowed(message, operation: "preview"))
        XCTAssertFalse(allowed(message, operation: "reconcile"))
    }
    func testReceiptLookupCannotSignAnOperationOrAnArbitraryChallenge() {
        let owner = "0x1111111111111111111111111111111111111111"
        func permits(_ text: String) -> Bool {
            WalletSignaturePolicy.permitsPersonalSign(hex: "0x" + text.utf8.map { String(format: "%02x", $0) }.joined(), operation: "reconcile", owner: owner, did: "did:privy:test", expectedAccount: owner, nonce: "test_nonce")
        }
        let message = ["https://app.merrymen.dev — recover your merrymen account.", "", "This proves you control the owner key so the site can relay withdrawals and permission revocations.", "It moves no funds by itself and grants no permissions: each operation", "is a separate operation you sign next.", "", "URI: https://app.merrymen.dev", "Nonce: test_nonce"].joined(separator: "\n")
        XCTAssertTrue(permits(message))
        XCTAssertFalse(permits(message.replacingOccurrences(of: "test_nonce", with: "other_nonce")))
        XCTAssertFalse(permits("Approve my spending request"))
        XCTAssertFalse(WalletSignaturePolicy.permitsPersonalSign(hex: "0x" + String(repeating: "01", count: 32), operation: "reconcile", owner: owner, did: "did:privy:test", expectedAccount: owner, nonce: nil))
    }

    func testRecoveryPlanCanProveOwnershipWithoutSigningSpending() {
        let owner = "0x1111111111111111111111111111111111111111"
        let message = ["https://app.merrymen.dev — recover your merrymen account.", "", "This proves you control the owner key so the site can relay withdrawals and permission revocations.", "It moves no funds by itself and grants no permissions: each operation", "is a separate operation you sign next.", "", "URI: https://app.merrymen.dev", "Nonce: fee_check"].joined(separator: "\n")
        for operation in ["preview", "plan"] {
            func permits(_ text: String) -> Bool {
                WalletSignaturePolicy.permitsPersonalSign(hex: "0x" + text.utf8.map { String(format: "%02x", $0) }.joined(), operation: operation, owner: owner, did: "", expectedAccount: owner, nonce: "fee_check")
            }
            XCTAssertTrue(permits(message))
            XCTAssertFalse(permits(message.replacingOccurrences(of: "fee_check", with: "other")))
            XCTAssertFalse(permits(message.replacingOccurrences(of: "app.merrymen.dev", with: "evil.test")))
            XCTAssertFalse(permits("Approve the withdrawal"))
            XCTAssertFalse(WalletSignaturePolicy.permitsPersonalSign(hex: "0x" + String(repeating: "01", count: 32), operation: operation, owner: owner, did: "", expectedAccount: owner, nonce: "fee_check"))
        }
    }

    func testDeployedLegacyAndScopedProofsAreExactInEveryRecoveryOperation() {
        let owner = "0x1111111111111111111111111111111111111111"
        let legacy = ["https://app.merrymen.dev — withdraw from your merrymen account.", "", "This proves you control the owner key so the site will relay your withdrawal.", "It moves no funds by itself and grants no permissions: the withdrawal itself", "is a separate operation you sign next.", "", "URI: https://app.merrymen.dev", "Nonce: compatibility_nonce"].joined(separator: "\n")
        let scoped = ["https://app.merrymen.dev — recover your merrymen account.", "", "This proves you control the owner key so the site can relay withdrawals and permission revocations.", "It moves no funds by itself and grants no permissions: each operation", "is a separate operation you sign next.", "", "URI: https://app.merrymen.dev", "Nonce: compatibility_nonce"].joined(separator: "\n")
        for operation in ["preview", "plan", "withdraw", "reconcile"] {
            func permits(_ text: String, nonce: String? = "compatibility_nonce") -> Bool {
                WalletSignaturePolicy.permitsPersonalSign(hex: "0x" + text.utf8.map { String(format: "%02x", $0) }.joined(), operation: operation, owner: owner, did: "", expectedAccount: owner, nonce: nonce)
            }
            for message in [legacy, scoped] {
                XCTAssertTrue(permits(message), operation)
                XCTAssertFalse(permits(message, nonce: "other_nonce"))
                XCTAssertFalse(permits(message, nonce: nil))
                XCTAssertFalse(permits(message.replacingOccurrences(of: "app.merrymen.dev", with: "evil.test")))
                XCTAssertFalse(permits(message + "\nApprove all transactions."))
                XCTAssertFalse(permits(message.replacingOccurrences(of: "grants no permissions", with: "grants unlimited permissions")))
            }
            XCTAssertFalse(permits("Approve the withdrawal"))
            let digest = "0x" + String(repeating: "01", count: 32)
            XCTAssertEqual(WalletSignaturePolicy.permitsPersonalSign(hex: digest, operation: operation, owner: owner, did: "", expectedAccount: owner, nonce: "compatibility_nonce"), operation == "withdraw")
        }
    }
}
