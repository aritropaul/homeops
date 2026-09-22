import Foundation
import Security

/// Shared keychain access for the app and its widget extension.
///
/// Items are written with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`.
/// That matters: with the default `WhenUnlocked`, a widget or Control Center
/// control refreshing while the phone is locked fails with
/// `errSecInteractionNotAllowed` — and the Simulator does not model that, so
/// the bug would only ever appear on a real locked device.
/// `ThisDeviceOnly` additionally keeps credentials out of iCloud Keychain sync
/// and out of an encrypted backup restored onto another device.
public struct Keychain: Sendable {
    public let service: String
    public let accessGroup: String?

    public init(
        service: String = HomeOpsIdentifiers.keychainService,
        accessGroup: String? = HomeOpsIdentifiers.keychainAccessGroup
    ) {
        self.service = service
        self.accessGroup = accessGroup
    }

    private func baseQuery(account: String) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let accessGroup {
            query[kSecAttrAccessGroup as String] = accessGroup
        }
        return query
    }

    @discardableResult
    public func set(_ value: String, account: String) -> Bool {
        guard let data = value.data(using: .utf8) else { return false }
        let query = baseQuery(account: account)

        let updateStatus = SecItemUpdate(
            query as CFDictionary,
            [kSecValueData as String: data] as CFDictionary
        )
        if updateStatus == errSecSuccess { return true }
        guard updateStatus == errSecItemNotFound else { return false }

        var addQuery = query
        addQuery[kSecValueData as String] = data
        addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(addQuery as CFDictionary, nil) == errSecSuccess
    }

    public func string(account: String) -> String? {
        var query = baseQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    public func remove(account: String) -> Bool {
        let status = SecItemDelete(baseQuery(account: account) as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }
}
