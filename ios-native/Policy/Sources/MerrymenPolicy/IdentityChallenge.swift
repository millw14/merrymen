import Foundation

public enum IdentityChallenge {
    public static let origin = "https://app.merrymen.dev"
    public static func signIn(nonce: String) -> String {
        ["\(origin) wants you to sign in with your merrymen wallet.", "", "This proves you control the owner key. It moves no funds and grants no permissions.", "", "URI: \(origin)", "Nonce: \(nonce)"].joined(separator: "\n")
    }
    public static func holder(address: String, owner: String, nonce: String) -> String {
        ["\(origin) wants you to link a wallet to your merrymen account.", "", "This proves you control the wallet below, so your $MERRYMEN balance can count", "toward your tier. It moves no funds, grants no trading permission, and the", "wallet is only ever read.", "", "Holder wallet: \(address.lowercased())", "merrymen account: \(owner.lowercased())", "URI: \(origin)", "Nonce: \(nonce)"].joined(separator: "\n")
    }
    public static func valid(_ challenge: JSONValue, message: String) -> Bool {
        challenge["origin"].text == origin &&
        challenge["nonce"].text.range(of: "^[A-Za-z0-9_.-]{1,512}$", options: .regularExpression) != nil &&
        challenge["message"].text == message
    }
}
