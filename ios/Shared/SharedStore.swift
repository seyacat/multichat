import Foundation
import Security

/// Constantes y almacenes compartidos entre la app y la extensión de notificaciones.
enum AppGroup {
    static let identifier = "group.com.dotrino.multichat"
    /// Servidor por defecto: clave MCDefaultServer del Info.plist (project.yml), o localhost.
    static var defaultServerURL: String {
        (Bundle.main.object(forInfoDictionaryKey: "MCDefaultServer") as? String).flatMap { $0.isEmpty ? nil : $0 }
            ?? "http://localhost:8787"
    }

    /// Carpeta del App Group. Sin el entitlement (simulador sin firma) cae a Application Support.
    static var containerURL: URL {
        if let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: identifier) {
            return url
        }
        let fallback = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: fallback, withIntermediateDirectories: true)
        return fallback
    }

    static var defaults: UserDefaults {
        UserDefaults(suiteName: identifier) ?? .standard
    }

    static var serverURL: String {
        get { defaults.string(forKey: "serverURL") ?? defaultServerURL }
        set { defaults.set(newValue, forKey: "serverURL") }
    }

    /// Último `seq` sincronizado, para que la extensión pueda bajar un mensaje que no vino en el push.
    static var lastSeq: Int {
        get { defaults.integer(forKey: "lastSeq") }
        set { defaults.set(newValue, forKey: "lastSeq") }
    }
}

/// Keychain con grupo de acceso compartido (`<prefijo>com.dotrino.multichat.shared`).
enum Keychain {
    static let service = "com.dotrino.multichat"

    static var accessGroup: String? {
        guard let prefix = Bundle.main.object(forInfoDictionaryKey: "AppIdentifierPrefix") as? String,
              !prefix.isEmpty, !prefix.contains("$") else { return nil }
        return prefix + "com.dotrino.multichat.shared"
    }

    private static func baseQuery(_ account: String, group: String?) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let group { q[kSecAttrAccessGroup as String] = group }
        return q
    }

    @discardableResult
    static func set(_ data: Data, for account: String) -> Bool {
        if write(data, account, group: accessGroup) { return true }
        // Sin entitlement (simulador sin firma): sin grupo.
        return write(data, account, group: nil)
    }

    private static func write(_ data: Data, _ account: String, group: String?) -> Bool {
        let q = baseQuery(account, group: group)
        let attrs: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        var status = SecItemUpdate(q as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound {
            var add = q
            add.merge(attrs) { $1 }
            status = SecItemAdd(add as CFDictionary, nil)
        }
        return status == errSecSuccess
    }

    static func get(_ account: String) -> Data? {
        for group in [accessGroup, nil] {
            var q = baseQuery(account, group: group)
            q[kSecReturnData as String] = true
            q[kSecMatchLimit as String] = kSecMatchLimitOne
            var out: CFTypeRef?
            if SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data {
                return d
            }
            if group == nil { break }
        }
        return nil
    }

    static func delete(_ account: String) {
        SecItemDelete(baseQuery(account, group: accessGroup) as CFDictionary)
        SecItemDelete(baseQuery(account, group: nil) as CFDictionary)
    }
}

/// Sesión y clave de cuenta guardadas en Keychain.
enum SecureStore {
    private static let sessionKey = "session"
    private static let accountKey = "accountPrivateKey"

    static func loadSession() -> Session? {
        guard let d = Keychain.get(sessionKey) else { return nil }
        return try? JSONDecoder().decode(Session.self, from: d)
    }

    static func saveSession(_ s: Session?) {
        if let s, let d = try? JSONEncoder().encode(s) {
            Keychain.set(d, for: sessionKey)
        } else {
            Keychain.delete(sessionKey)
        }
    }

    static func loadAccountKey() -> Data? {
        guard let d = Keychain.get(accountKey), d.count == 32 else { return nil }
        return d
    }

    static func saveAccountKey(_ key: Data?) {
        if let key { Keychain.set(key, for: accountKey) } else { Keychain.delete(accountKey) }
    }
}
