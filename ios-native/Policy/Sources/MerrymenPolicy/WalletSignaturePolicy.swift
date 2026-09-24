import Foundation

public enum WalletSignaturePolicy {
    public static func permitsPersonalSign(hex: String, operation: String, owner: String, did: String, expectedAccount: String, nonce: String?) -> Bool {
        guard hex.range(of: "^0x([0-9a-fA-F]{2}){1,8192}$", options: .regularExpression) != nil else { return false }
        // Kernel signs a 32-byte digest; receipt lookup cannot authorize one.
        if hex.count == 66 { return ["create", "withdraw"].contains(operation) }
        guard let nonce, nonce.range(of: "^[A-Za-z0-9_.-]{1,512}$", options: .regularExpression) != nil else { return false }
        var bytes = [UInt8](); var index = hex.index(hex.startIndex, offsetBy: 2)
        while index < hex.endIndex { let end = hex.index(index, offsetBy: 2); guard let byte = UInt8(hex[index..<end], radix: 16) else { return false }; bytes.append(byte); index = end }
        guard let text = String(bytes: bytes, encoding: .utf8) else { return false }
        let origin = "https://app.merrymen.dev"
        if ["withdraw", "reconcile"].contains(operation) {
            return text == ["\(origin) — withdraw from your merrymen account.", "", "This proves you control the owner key so the site will relay your withdrawal.", "It moves no funds by itself and grants no permissions: the withdrawal itself", "is a separate operation you sign next.", "", "URI: \(origin)", "Nonce: \(nonce)"].joined(separator: "\n")
        }
        guard operation == "create" else { return false }
        let lines = text.components(separatedBy: "\n")
        guard lines.count == 10, lines[4].hasPrefix("Agent account: ") else { return false }
        let account = String(lines[4].dropFirst("Agent account: ".count))
        guard account.range(of: "^0x[0-9a-f]{40}$", options: .regularExpression) != nil,
              expectedAccount.isEmpty || account == expectedAccount.lowercased() else { return false }
        return text == ["\(origin) wants you to authorize a merrymen agent account.", "", "You are linking the agent wallet below to your merrymen identity. It moves no funds.", "", "Agent account: \(account)", "Owner key: \(owner.lowercased())", "Identity: \(did)", "Chain ID: 4663", "URI: \(origin)", "Nonce: \(nonce)"].joined(separator: "\n")
    }
}
