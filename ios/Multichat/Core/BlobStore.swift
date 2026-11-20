import Foundation
import UniformTypeIdentifiers

/// Caché en disco (App Group) de blobs ya descifrados.
@MainActor
final class BlobStore {
    private let api: () -> APIClient?
    private var inflight: [String: Task<URL, Error>] = [:]

    init(api: @escaping () -> APIClient?) { self.api = api }

    static var directory: URL {
        let d = AppGroup.containerURL.appendingPathComponent("blobs", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    static func fileExtension(mime: String?, name: String?) -> String {
        if let name, let ext = name.split(separator: ".").last, ext.count <= 5, name.contains(".") { return String(ext).lowercased() }
        if let mime, let t = UTType(mimeType: mime), let ext = t.preferredFilenameExtension { return ext }
        return "bin"
    }

    static func cachedURL(blobId: String, mime: String?, name: String?) -> URL {
        let safe = blobId.replacingOccurrences(of: "/", with: "_")
        return directory.appendingPathComponent("\(safe).\(fileExtension(mime: mime, name: name))")
    }

    func existing(_ a: Attachment) -> URL? {
        let u = Self.cachedURL(blobId: a.blobId, mime: a.mime, name: a.name)
        return FileManager.default.fileExists(atPath: u.path) ? u : nil
    }

    /// Copia un archivo local (envío propio) a la caché con el id del blob.
    func seed(_ a: Attachment, from local: URL) {
        let dst = Self.cachedURL(blobId: a.blobId, mime: a.mime, name: a.name)
        guard !FileManager.default.fileExists(atPath: dst.path) else { return }
        try? FileManager.default.copyItem(at: local, to: dst)
    }

    func file(for a: Attachment) async throws -> URL {
        if let u = existing(a) { return u }
        if let t = inflight[a.blobId] { return try await t.value }
        guard let api = api() else { throw APIError(status: 401, code: "unauthorized", message: "Sesión cerrada") }
        guard let key = B64U.decode(a.fileKey), key.count == 32 else { throw CryptoError.invalidKey }
        let dst = Self.cachedURL(blobId: a.blobId, mime: a.mime, name: a.name)
        let t = Task { @MainActor () throws -> URL in
            let enc = try await api.downloadBlob(a.blobId)
            defer { try? FileManager.default.removeItem(at: enc) }
            let tmp = dst.appendingPathExtension("part")
            try await Task.detached(priority: .userInitiated) {
                try? FileManager.default.removeItem(at: tmp)
                try MCBlob.decryptFile(at: enc, to: tmp, fileKey: key)
            }.value
            try? FileManager.default.removeItem(at: dst)
            try FileManager.default.moveItem(at: tmp, to: dst)
            return dst
        }
        inflight[a.blobId] = t
        defer { inflight[a.blobId] = nil }
        return try await t.value
    }

    static func clearAll() {
        try? FileManager.default.removeItem(at: directory)
    }
}
