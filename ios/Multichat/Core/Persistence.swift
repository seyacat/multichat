import Foundation
import SwiftData

// Caché local (SwiftData) en el contenedor del App Group: contactos y mensajes ya descifrados,
// integraciones y último seq.

@Model
final class CachedContact {
    @Attribute(.unique) var id: String
    var integrationId: String
    var kind: String
    var status: String
    var profileName: String
    var username: String?
    var phone: String?
    var platform: String?
    var aliasName: String?
    var muted: Bool
    var hidePreview: Bool
    var unread: Int
    var lastMessageAt: Double?
    var lastInboundAt: Double?
    var seq: Int
    var createdAt: Double
    var previewText: String?
    var previewAt: Double?
    var previewOutgoing: Bool
    var previewStatus: String?

    init(id: String, integrationId: String) {
        self.id = id
        self.integrationId = integrationId
        kind = "direct"
        status = "pending"
        profileName = ""
        muted = false
        hidePreview = false
        unread = 0
        seq = 0
        createdAt = 0
        previewOutgoing = false
    }

    var displayName: String {
        if let a = aliasName, !a.isEmpty { return a }
        if !profileName.isEmpty { return profileName }
        return username ?? phone ?? "Sin nombre"
    }

    var sortDate: Double { max(lastMessageAt ?? 0, previewAt ?? 0, createdAt) }
}

@Model
final class CachedMessage {
    @Attribute(.unique) var id: String
    var contactId: String
    var clientId: String?
    var direction: String
    var status: String
    var error: String?
    var seq: Int
    var createdAt: Double
    var kind: String
    var text: String?
    var senderName: String?
    var lat: Double?
    var lon: Double?
    var blobId: String?
    var fileKey: String?
    var mime: String?
    var fileName: String?
    var fileSize: Int?
    /// Archivo local de un envío optimista (para reintentar y previsualizar sin bajar el blob).
    var localFile: String?
    /// Oculto localmente tras reintentar un envío fallido (el servidor no permite borrar un mensaje suelto).
    var hidden: Bool
    var decryptFailed: Bool

    init(id: String, contactId: String) {
        self.id = id
        self.contactId = contactId
        direction = "in"
        status = "received"
        seq = 0
        createdAt = 0
        kind = "text"
        hidden = false
        decryptFailed = false
    }

    var payload: MessagePayload {
        MessagePayload(
            v: 1, kind: kind, text: text, senderName: senderName,
            location: lat.flatMap { la in lon.map { GeoPoint(lat: la, lon: $0) } },
            attachment: blobId.map { Attachment(blobId: $0, fileKey: fileKey ?? "", mime: mime, name: fileName, size: fileSize) }
        )
    }

    func apply(_ p: MessagePayload) {
        kind = p.kind
        text = p.text
        senderName = p.senderName
        lat = p.location?.lat
        lon = p.location?.lon
        if let a = p.attachment {
            blobId = a.blobId
            fileKey = a.fileKey
            mime = a.mime
            fileName = a.name
            fileSize = a.size
        }
    }
}

@Model
final class CachedIntegration {
    @Attribute(.unique) var id: String
    var json: Data
    init(id: String, json: Data) { self.id = id; self.json = json }
}

@Model
final class SyncState {
    @Attribute(.unique) var key: String
    var lastSeq: Int
    init(key: String = "main", lastSeq: Int = 0) { self.key = key; self.lastSeq = lastSeq }
}

enum Persistence {
    static let schema = Schema([CachedContact.self, CachedMessage.self, CachedIntegration.self, SyncState.self])

    static var storeURL: URL { AppGroup.containerURL.appendingPathComponent("Multichat.store") }

    static func makeContainer(inMemory: Bool = false) -> ModelContainer {
        let config = inMemory
            ? ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)
            : ModelConfiguration(schema: schema, url: storeURL)
        if let c = try? ModelContainer(for: schema, configurations: config) { return c }
        // Esquema incompatible: es una caché, se borra y se rehace.
        for suffix in ["", "-shm", "-wal"] {
            try? FileManager.default.removeItem(at: URL(fileURLWithPath: storeURL.path + suffix))
        }
        if let c = try? ModelContainer(for: schema, configurations: config) { return c }
        return try! ModelContainer(for: schema, configurations: ModelConfiguration(schema: schema, isStoredInMemoryOnly: true))
    }
}
