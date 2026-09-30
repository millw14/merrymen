import XCTest
@testable import MerrymenPolicy

final class IdentityChallengeTests: XCTestCase {
    func testHolderProofBindsBothWalletsAndOrigin() {
        let message = IdentityChallenge.holder(address: "0xA", owner: "0xB", nonce: "test.nonce")
        let value: JSONValue = .object(["origin": .string(IdentityChallenge.origin), "nonce": .string("test.nonce"), "message": .string(message)])
        XCTAssertTrue(IdentityChallenge.valid(value, message: message))
        XCTAssertFalse(IdentityChallenge.valid(value, message: IdentityChallenge.holder(address: "0xA", owner: "0xC", nonce: "test.nonce")))
        XCTAssertFalse(IdentityChallenge.valid(value, message: IdentityChallenge.holder(address: "0xC", owner: "0xB", nonce: "test.nonce")))
        XCTAssertFalse(IdentityChallenge.valid(value, message: IdentityChallenge.signIn(nonce: "test.nonce")))
        var other = value.object; other["origin"] = .string("https://evil.invalid")
        XCTAssertFalse(IdentityChallenge.valid(.object(other), message: message))
        other = value.object; other["nonce"] = .string("bad\nnonce")
        XCTAssertFalse(IdentityChallenge.valid(.object(other), message: message))
    }
}
