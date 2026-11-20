import Foundation

// Tipos del protocolo app ↔ proxy (docs/protocol.md). Compartidos con la extensión de notificaciones.

/// Valor JSON genérico para `info` y `config` de las integraciones.
enum JSONValue: Codable, Hashable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n): try c.encode(n)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    var string: String? {
        switch self {
        case .string(let s): return s
        case .number(let n): return n == n.rounded() ? String(Int64(n)) : String(n)
        default: return nil
        }
    }

    var bool: Bool? { if case .bool(let b) = self { return b }; return nil }

    var stringArray: [String] {
        if case .array(let a) = self { return a.compactMap(\.string) }
        return []
    }
}

struct APIUser: Codable, Hashable, Sendable {
    var id: String
    var email: String
    var accountPublicKey: String?
}

struct APIDevice: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var name: String
    var platform: String
    var createdAt: Double?
    var lastSeenAt: Double?
    var push: String?
}

struct Session: Codable, Sendable {
    var accessToken: String
    var refreshToken: String
    var user: APIUser
    var device: APIDevice
    /// Local: cuándo se obtuvo el access token (vale 15 min).
    var obtainedAt: Date?
}

struct MeResponse: Codable, Sendable {
    var user: APIUser
    var device: APIDevice
    var devices: [APIDevice]
}

enum PlatformType: String, Codable, CaseIterable, Sendable, Identifiable {
    case telegram, discord, whatsapp
    var id: String { rawValue }
}

struct Integration: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var type: PlatformType
    var name: String
    var color: String
    var enabled: Bool
    var status: String
    var statusDetail: String?
    var credentialHint: String?
    var info: [String: JSONValue]?
    var config: [String: JSONValue]?
    var webhookUrl: String?
    var createdAt: Double?
    var updatedAt: Double?
}

struct Contact: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var integrationId: String
    var kind: String
    var status: String
    var profile: String
    var alias: String?
    var muted: Bool
    var hidePreview: Bool
    var unread: Int
    var lastMessageAt: Double?
    var lastInboundAt: Double?
    var seq: Int
    var createdAt: Double?
    var updatedAt: Double?
}

struct ContactProfile: Codable, Hashable, Sendable {
    var name: String?
    var username: String?
    var phone: String?
    var platform: String?
}

struct AliasPayload: Codable, Hashable, Sendable {
    var name: String
}

struct Message: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var contactId: String
    var direction: String
    var status: String
    var error: String?
    var envelope: String?
    var clientId: String?
    var seq: Int
    var createdAt: Double
    var updatedAt: Double?
}

struct MessagesPage: Codable, Sendable {
    var messages: [Message]
    var more: Bool
}

struct Attachment: Codable, Hashable, Sendable {
    var blobId: String
    var fileKey: String
    var mime: String?
    var name: String?
    var size: Int?
}

struct GeoPoint: Codable, Hashable, Sendable {
    var lat: Double
    var lon: Double
}

struct MessagePayload: Codable, Hashable, Sendable {
    var v: Int?
    var kind: String
    var text: String?
    var senderName: String?
    var location: GeoPoint?
    var attachment: Attachment?

    /// Texto corto para la lista de chats y las notificaciones.
    var previewText: String {
        let t = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let label: String
        switch kind {
        case "text": return t
        case "image": label = "📷 Foto"
        case "video": label = "🎬 Video"
        case "audio": label = "🎤 Audio"
        case "file": label = "📄 " + (attachment?.name ?? "Archivo")
        case "sticker": label = "Sticker"
        case "location": label = "📍 Ubicación"
        default: label = "Mensaje no soportado"
        }
        return t.isEmpty ? label : "\(label): \(t)"
    }
}

/// Objeto `mc` del payload APNs (protocol.md §8).
struct PushMC: Codable, Sendable {
    var messageId: String
    var contactId: String
    var hidePreview: Bool?
    var profile: String?
    var alias: String?
    var envelope: String?
}

struct APIErrorBody: Codable, Sendable {
    var error: String
    var message: String?
}

struct LinkCreated: Codable, Sendable {
    var id: String
    var expiresAt: Double
}

struct LinkInfo: Codable, Sendable {
    var id: String
    var ephemeralPublicKey: String
    var deviceName: String?
    var platform: String?
    var status: String
    var sealedKey: String?
}

struct DiscordChannels: Codable, Sendable {
    struct Channel: Codable, Hashable, Sendable, Identifiable { var id: String; var name: String }
    struct Guild: Codable, Hashable, Sendable, Identifiable { var id: String; var name: String; var channels: [Channel] }
    var guilds: [Guild]
}

struct IntegrationTestResult: Codable, Sendable {
    var ok: Bool
    var info: [String: JSONValue]?
}
