import Foundation

// Mirrors packages/protocol/src/index.ts (protocol v1).

struct PairingInfo: Codable, Equatable {
    var v: Int
    var name: String
    var urls: [String]
    var token: String
}

struct SessionCard: Codable, Identifiable, Equatable {
    var id: String
    var project: String
    var cwd: String
    var state: String
    var summary: String
    var updatedAt: String
}

struct PendingCard: Codable, Identifiable, Equatable {
    var id: String
    var sessionId: String
    var project: String
    var kind: String
    var summary: String
    var risk: String
    var createdAt: String
    var deadline: String
}

struct Snapshot: Codable, Equatable {
    var mode: String
    var language: String?
    var paused: Bool
    var hubVersion: String
    var sessions: [SessionCard]
    var pending: [PendingCard]
    /// Spoken "task complete" alerts: "off", "computer" or "phone"; nil from older hubs.
    var doneAlert: String?
}

enum SessionStateUI {
    static func label(_ s: String) -> String {
        switch s {
        case "running": return "Working"
        case "waiting_permission": return "Needs permission"
        case "waiting_input": return "Waiting for you"
        case "blocked": return "Stuck"
        case "done": return "Done"
        case "errored": return "Error"
        case "stale": return "Quiet"
        case "ended": return "Closed"
        default: return s
        }
    }

    static func symbol(_ s: String) -> String {
        switch s {
        case "running": return "gearshape.2.fill"
        case "waiting_permission", "waiting_input": return "questionmark.bubble.fill"
        case "blocked": return "exclamationmark.octagon.fill"
        case "done": return "checkmark.seal.fill"
        case "errored": return "xmark.octagon.fill"
        case "stale": return "moon.zzz.fill"
        default: return "circle"
        }
    }
}

enum PairingStore {
    private static let key = "cmc.pairing"

    static func load() -> PairingInfo? {
        guard let data = Keychain.get(key) else { return nil }
        return try? JSONDecoder().decode(PairingInfo.self, from: data)
    }

    static func save(_ p: PairingInfo?) {
        if let p, let data = try? JSONEncoder().encode(p) { Keychain.set(key, data) } else { Keychain.delete(key) }
    }
}

enum Keychain {
    static func set(_ key: String, _ data: Data) {
        delete(key)
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        SecItemAdd(q as CFDictionary, nil)
    }

    static func get(_ key: String) -> Data? {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: AnyObject?
        return SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
    }

    static func delete(_ key: String) {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: key]
        SecItemDelete(q as CFDictionary)
    }
}
