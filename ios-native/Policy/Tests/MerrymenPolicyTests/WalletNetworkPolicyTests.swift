import XCTest
@testable import MerrymenPolicy

final class WalletNetworkPolicyTests: XCTestCase {
    func testWalletTransportCannotSendCredentialsOrWritesToPublicRPC() {
        XCTAssertNotNil(WalletNetworkPolicy.destination("https://rpc.mainnet.chain.robinhood.com", method: "POST", operation: "create", rpcMethod: "eth_call"))
        for address in ["https://app.merrymen.dev.evil.test/api/grants", "http://app.merrymen.dev/api/grants", "https://x@app.merrymen.dev/api/grants", "//evil.test/api/grants", "https://app.merrymen.dev:8443/api/grants"] {
            XCTAssertNil(WalletNetworkPolicy.destination(address, method: "POST", operation: "create", rpcMethod: nil))
        }
        XCTAssertNil(WalletNetworkPolicy.destination("https://rpc.mainnet.chain.robinhood.com", method: "POST", operation: "withdraw", rpcMethod: "eth_sendRawTransaction"))
        XCTAssertNil(WalletNetworkPolicy.destination("/api/bundler/4663", method: "POST", operation: "reconcile", rpcMethod: "eth_sendUserOperation"))
        XCTAssertNil(WalletNetworkPolicy.destination("/api/grants", method: "POST", operation: "plan", rpcMethod: nil))
        XCTAssertNotNil(WalletNetworkPolicy.destination("/api/bundler/4663", method: "POST", operation: "withdraw", rpcMethod: "eth_sendUserOperation"))
    }

    func testRecoveryFeeChecksAndSponsorshipStayInsideTheirReviewedCapabilities() {
        for operation in ["preview", "plan", "withdraw", "reconcile"] {
            XCTAssertNotNil(WalletNetworkPolicy.destination("/api/recover/ticket", method: "GET", operation: operation, rpcMethod: nil))
            XCTAssertNotNil(WalletNetworkPolicy.destination("/api/recover/ticket", method: "POST", operation: operation, rpcMethod: nil))
            XCTAssertNotNil(WalletNetworkPolicy.destination("/api/bundler/4663", method: "GET", operation: operation, rpcMethod: nil))
            XCTAssertNil(WalletNetworkPolicy.destination("/api/bundler/46630", method: "GET", operation: operation, rpcMethod: nil))
        }
        for method in ["pm_getPaymasterStubData", "pm_getPaymasterData"] {
            XCTAssertNotNil(WalletNetworkPolicy.destination("/api/bundler/4663", method: "POST", operation: "withdraw", rpcMethod: method))
            for operation in ["create", "restore", "preview", "plan", "reconcile"] {
                XCTAssertNil(WalletNetworkPolicy.destination("/api/bundler/4663", method: "POST", operation: operation, rpcMethod: method))
            }
            XCTAssertNil(WalletNetworkPolicy.destination("https://api.pimlico.io/v2/4663/rpc", method: "POST", operation: "withdraw", rpcMethod: method))
        }
        for operation in ["preview", "plan"] {
            XCTAssertNil(WalletNetworkPolicy.destination("/api/bundler/4663", method: "POST", operation: operation, rpcMethod: "eth_sendUserOperation"))
            XCTAssertNil(WalletNetworkPolicy.destination("/api/bundler/4663", method: "POST", operation: operation, rpcMethod: "eth_estimateUserOperationGas"))
        }
        XCTAssertNil(WalletNetworkPolicy.destination("/api/bundler/4663?policy=caller", method: "GET", operation: "plan", rpcMethod: nil))
        XCTAssertNil(WalletNetworkPolicy.destination("/api/bundler/4663", method: "GET", operation: "create", rpcMethod: nil))
    }
}
