import Foundation
import Security

/// Device-only Keychain records. A failed update preserves the previous grant.
enum SecureStore {
    static func read(_ service: String, _ key: String) throws -> Data? {
        var query = base(service, key); query[kSecReturnData as String] = true
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw failure() }
        return data
    }
    static func write(_ service: String, _ key: String, _ data: Data) throws {
        let query = base(service, key)
        let fields: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, fields as CFDictionary)
        if status == errSecItemNotFound { status = SecItemAdd(query.merging(fields, uniquingKeysWith: { _, new in new }) as CFDictionary, nil) }
        guard status == errSecSuccess else { throw failure() }
    }
    static func remove(_ service: String, _ key: String) throws {
        let status = SecItemDelete(base(service, key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw failure() }
    }
    private static func base(_ service: String, _ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key]
    }
    private static func failure() -> APIError { APIError(status: 0, message: "Secure storage is unavailable. Unlock your device and try again.") }
}
