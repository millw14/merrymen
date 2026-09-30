import Foundation
import JavaScriptCore

/// A fresh, capability-free context per operation. In particular, this context
/// has no native bridge and cannot send an imported key to an API or RPC.
enum WalletCryptography {
    private static let source: String? = Bundle.main.url(forResource: "WalletCryptography", withExtension: "js").flatMap { try? String(contentsOf: $0, encoding: .utf8) }
    static func call(_ operation: String, _ input: J) throws -> String {
        guard ["address", "signMessage", "signTypedData", "keccak", "recoverPublicKey", "recoverAddress"].contains(operation),
              let source, let context = JSContext() else { throw failure() }
        context.evaluateScript(source)
        guard context.exception == nil,
              let json = String(data: try JSONEncoder().encode(input), encoding: .utf8),
              let argument = context.objectForKeyedSubscript("JSON")?.objectForKeyedSubscript("parse")?.call(withArguments: [json]),
              let function = context.objectForKeyedSubscript("WalletCryptography")?.objectForKeyedSubscript(operation),
              let result = function.call(withArguments: [argument]), context.exception == nil,
              result.isString, let text = result.toString() else { throw failure() }
        return text
    }
    private static func failure() -> APIError { APIError(status: 0, message: "The wallet proof could not be processed. Check the recovery key or signature.") }
}
