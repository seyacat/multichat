import Foundation

struct APIError: LocalizedError, Sendable {
    var status: Int
    var code: String
    var message: String

    var errorDescription: String? { message }

    static func network(_ error: Error) -> APIError {
        APIError(status: 0, code: "network", message: "No se pudo conectar con el servidor: \(error.localizedDescription)")
    }
}

/// Cliente REST del proxy. Refresca el access token en 401 y reintenta una vez.
@MainActor
final class APIClient {
    var baseURL: URL
    private(set) var session: Session?
    var onSessionChange: ((Session?) -> Void)?
    private var refreshTask: Task<Session, Error>?
    private let urlSession: URLSession

    init(baseURL: URL, session: Session?) {
        self.baseURL = baseURL
        self.session = session
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 30
        cfg.waitsForConnectivity = false
        urlSession = URLSession(configuration: cfg)
    }

    func setSession(_ s: Session?) {
        session = s
        onSessionChange?(s)
    }

    static let encoder = JSONEncoder()
    static let decoder = JSONDecoder()

    func url(_ path: String, query: [String: String] = [:]) -> URL {
        var comps = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty {
            comps.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        return comps.url!
    }

    // MARK: Núcleo

    func send(_ method: String, _ path: String, query: [String: String] = [:], json: (any Encodable)? = nil, auth: Bool = true) async throws -> Data {
        var req = URLRequest(url: url(path, query: query))
        req.httpMethod = method
        if let json {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try Self.encoder.encode(json)
        }
        return try await perform(req, auth: auth)
    }

    func perform(_ request: URLRequest, auth: Bool = true) async throws -> Data {
        var req = request
        if auth {
            try await ensureFreshToken()
            req.setValue("Bearer \(session?.accessToken ?? "")", forHTTPHeaderField: "Authorization")
        }
        var (data, status) = try await raw(req)
        if status == 401 && auth {
            _ = try await refresh()
            req.setValue("Bearer \(session?.accessToken ?? "")", forHTTPHeaderField: "Authorization")
            (data, status) = try await raw(req)
        }
        try Self.check(status, data)
        return data
    }

    private func raw(_ req: URLRequest) async throws -> (Data, Int) {
        do {
            let (data, resp) = try await urlSession.data(for: req)
            return (data, (resp as? HTTPURLResponse)?.statusCode ?? 0)
        } catch {
            throw APIError.network(error)
        }
    }

    nonisolated static func check(_ status: Int, _ data: Data) throws {
        guard (200..<300).contains(status) else {
            let body = try? JSONDecoder().decode(APIErrorBody.self, from: data)
            throw APIError(
                status: status,
                code: body?.error ?? "http_\(status)",
                message: body?.message ?? body?.error ?? "Error del servidor (\(status))"
            )
        }
    }

    func get<T: Decodable>(_ type: T.Type, _ path: String, query: [String: String] = [:]) async throws -> T {
        try Self.decoder.decode(T.self, from: try await send("GET", path, query: query))
    }

    func call<T: Decodable>(_ type: T.Type, _ method: String, _ path: String, json: (any Encodable)? = nil, auth: Bool = true) async throws -> T {
        try Self.decoder.decode(T.self, from: try await send(method, path, json: json, auth: auth))
    }

    // MARK: Tokens

    /// El access token vale 15 min: se refresca por adelantado a los 13.
    func ensureFreshToken() async throws {
        guard let s = session else { throw APIError(status: 401, code: "unauthorized", message: "Sesión cerrada") }
        if let at = s.obtainedAt, Date().timeIntervalSince(at) < 13 * 60 { return }
        _ = try await refresh()
    }

    @discardableResult
    func refresh() async throws -> Session {
        if let t = refreshTask { return try await t.value }
        guard var s = session else { throw APIError(status: 401, code: "unauthorized", message: "Sesión cerrada") }
        // La extensión de notificaciones puede haber rotado el refresh token: usar el del Keychain.
        if let stored = SecureStore.loadSession(), stored.refreshToken != s.refreshToken, stored.user.id == s.user.id {
            s = stored
            if let at = stored.obtainedAt, Date().timeIntervalSince(at) < 13 * 60 {
                setSession(stored)
                return stored
            }
        }
        let t = Task { @MainActor [s] () throws -> Session in
            var req = URLRequest(url: url("api/auth/refresh"))
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try Self.encoder.encode(["refreshToken": s.refreshToken])
            let (data, status) = try await raw(req)
            try Self.check(status, data)
            var ns = try Self.decoder.decode(Session.self, from: data)
            ns.obtainedAt = Date()
            return ns
        }
        refreshTask = t
        defer { refreshTask = nil }
        do {
            let ns = try await t.value
            setSession(ns)
            return ns
        } catch let e as APIError where e.status == 401 {
            setSession(nil)
            throw e
        }
    }

    // MARK: Auth

    struct AuthBody: Encodable { var email: String; var password: String; var deviceName: String; var platform = "ios" }

    func authenticate(register: Bool, email: String, password: String, deviceName: String) async throws -> Session {
        var s = try await call(Session.self, "POST", register ? "api/auth/register" : "api/auth/login",
                               json: AuthBody(email: email, password: password, deviceName: deviceName), auth: false)
        s.obtainedAt = Date()
        setSession(s)
        return s
    }

    func logout() async {
        _ = try? await send("POST", "api/auth/logout")
        setSession(nil)
    }

    func me() async throws -> MeResponse { try await get(MeResponse.self, "api/me") }

    func putAccountKey(_ pub: String) async throws {
        _ = try await send("PUT", "api/account/key", json: ["publicKey": pub])
    }

    func deleteDevice(_ id: String) async throws { _ = try await send("DELETE", "api/devices/\(id)") }

    // MARK: Vínculo

    func createLink(ephemeralPublicKey: String) async throws -> LinkCreated {
        try await call(LinkCreated.self, "POST", "api/link", json: ["ephemeralPublicKey": ephemeralPublicKey])
    }

    func getLink(_ id: String) async throws -> LinkInfo { try await get(LinkInfo.self, "api/link/\(id)") }

    func approveLink(_ id: String, sealedKey: String) async throws {
        _ = try await send("POST", "api/link/\(id)/approve", json: ["sealedKey": sealedKey])
    }

    // MARK: Integraciones

    func integrations() async throws -> [Integration] { try await get([Integration].self, "api/integrations") }

    struct TestBody: Encodable { var type: PlatformType; var credentials: [String: String] }
    func testIntegration(type: PlatformType, credentials: [String: String]) async throws -> IntegrationTestResult {
        try await call(IntegrationTestResult.self, "POST", "api/integrations/test", json: TestBody(type: type, credentials: credentials))
    }

    struct CreateBody: Encodable {
        var type: PlatformType; var name: String; var color: String
        var credentials: [String: String]; var config: [String: JSONValue]?
    }
    func createIntegration(_ body: CreateBody) async throws -> Integration {
        try await call(Integration.self, "POST", "api/integrations", json: body)
    }

    struct PatchIntegration: Encodable {
        var name: String?; var color: String?; var enabled: Bool?
        var credentials: [String: String]?; var config: [String: JSONValue]?
    }
    func patchIntegration(_ id: String, _ body: PatchIntegration) async throws -> Integration {
        try await call(Integration.self, "PATCH", "api/integrations/\(id)", json: body)
    }

    func deleteIntegration(_ id: String) async throws { _ = try await send("DELETE", "api/integrations/\(id)") }

    func discordChannels(_ id: String) async throws -> DiscordChannels {
        try await get(DiscordChannels.self, "api/integrations/\(id)/discord/channels")
    }

    // MARK: Contactos y mensajes

    func contacts(since: Int?) async throws -> [Contact] {
        try await get([Contact].self, "api/contacts", query: since.map { ["since": String($0)] } ?? [:])
    }

    /// Campos opcionales de PATCH /api/contacts/:id. `alias` admite null explícito.
    struct PatchContact: Encodable {
        var status: String?
        var alias: String??
        var muted: Bool?
        var hidePreview: Bool?
        var read: Bool?

        enum CodingKeys: String, CodingKey { case status, alias, muted, hidePreview, read }
        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encodeIfPresent(status, forKey: .status)
            if let alias { try c.encode(alias, forKey: .alias) }
            try c.encodeIfPresent(muted, forKey: .muted)
            try c.encodeIfPresent(hidePreview, forKey: .hidePreview)
            try c.encodeIfPresent(read, forKey: .read)
        }
    }
    func patchContact(_ id: String, _ body: PatchContact) async throws -> Contact {
        try await call(Contact.self, "PATCH", "api/contacts/\(id)", json: body)
    }

    func deleteContact(_ id: String) async throws { _ = try await send("DELETE", "api/contacts/\(id)") }

    func messages(since: Int, limit: Int = 500) async throws -> MessagesPage {
        try await get(MessagesPage.self, "api/messages", query: ["since": String(since), "limit": String(limit)])
    }

    func olderMessages(contactId: String, before: Double, limit: Int = 50) async throws -> [Message] {
        try await get([Message].self, "api/contacts/\(contactId)/messages",
                      query: ["before": String(Int64(before)), "limit": String(limit)])
    }

    struct TextBody: Encodable { var clientId: String; var text: String }
    func sendText(contactId: String, clientId: String, text: String) async throws -> Message {
        try await call(Message.self, "POST", "api/contacts/\(contactId)/messages", json: TextBody(clientId: clientId, text: text))
    }

    /// Envío multipart (protocol.md §6) con progreso de subida.
    func sendMedia(contactId: String, clientId: String, text: String?, kind: String, fileURL: URL, fileName: String, mime: String,
                   progress: @escaping @Sendable (Double) -> Void) async throws -> Message {
        try await ensureFreshToken()
        let boundary = "mc-\(UUID().uuidString)"
        let body = try Multipart.write(boundary: boundary, fields: [("clientId", clientId), ("text", text ?? ""), ("kind", kind)]
            .filter { !($0.0 == "text" && $0.1.isEmpty) }, fileField: "file", fileURL: fileURL, fileName: fileName, mime: mime)
        defer { try? FileManager.default.removeItem(at: body) }
        func makeRequest() -> URLRequest {
            var req = URLRequest(url: url("api/contacts/\(contactId)/messages"))
            req.httpMethod = "POST"
            req.timeoutInterval = 600
            req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
            req.setValue("Bearer \(session?.accessToken ?? "")", forHTTPHeaderField: "Authorization")
            return req
        }
        let delegate = UploadProgressDelegate(progress)
        func upload() async throws -> (Data, Int) {
            do {
                let (data, resp) = try await urlSession.upload(for: makeRequest(), fromFile: body, delegate: delegate)
                return (data, (resp as? HTTPURLResponse)?.statusCode ?? 0)
            } catch { throw APIError.network(error) }
        }
        var (data, status) = try await upload()
        if status == 401 {
            _ = try await refresh()
            (data, status) = try await upload()
        }
        try Self.check(status, data)
        return try Self.decoder.decode(Message.self, from: data)
    }

    func downloadBlob(_ id: String) async throws -> URL {
        try await ensureFreshToken()
        func attempt() async throws -> (URL, Int) {
            var req = URLRequest(url: url("api/blobs/\(id)"))
            req.timeoutInterval = 600
            req.setValue("Bearer \(session?.accessToken ?? "")", forHTTPHeaderField: "Authorization")
            do {
                let (tmp, resp) = try await urlSession.download(for: req)
                let keep = FileManager.default.temporaryDirectory.appendingPathComponent("dl-\(UUID().uuidString)")
                try FileManager.default.moveItem(at: tmp, to: keep)
                return (keep, (resp as? HTTPURLResponse)?.statusCode ?? 0)
            } catch { throw APIError.network(error) }
        }
        var (file, status) = try await attempt()
        if status == 401 {
            try? FileManager.default.removeItem(at: file)
            _ = try await refresh()
            (file, status) = try await attempt()
        }
        if !(200..<300).contains(status) {
            let data = (try? Data(contentsOf: file)) ?? Data()
            try? FileManager.default.removeItem(at: file)
            try Self.check(status, data)
        }
        return file
    }

    // MARK: Push

    struct PushBody: Encodable {
        var kind: String?
        var token: String?
        var environment: String?
        enum CodingKeys: String, CodingKey { case kind, token, environment }
        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(kind, forKey: .kind) // null explícito para quitar
            try c.encodeIfPresent(token, forKey: .token)
            try c.encodeIfPresent(environment, forKey: .environment)
        }
    }
    func setPush(token: String?) async throws {
        #if DEBUG
        let env = "sandbox"
        #else
        let env = "production"
        #endif
        let body = token.map { PushBody(kind: "apns", token: $0, environment: env) } ?? PushBody(kind: nil)
        _ = try await send("PUT", "api/devices/me/push", json: body)
    }
}

final class UploadProgressDelegate: NSObject, URLSessionTaskDelegate, Sendable {
    let onProgress: @Sendable (Double) -> Void
    init(_ onProgress: @escaping @Sendable (Double) -> Void) { self.onProgress = onProgress }

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
                    totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        guard totalBytesExpectedToSend > 0 else { return }
        onProgress(Double(totalBytesSent) / Double(totalBytesExpectedToSend))
    }
}

enum Multipart {
    /// Escribe el cuerpo multipart en un archivo temporal (para subir con progreso sin cargarlo en memoria).
    static func write(boundary: String, fields: [(String, String)], fileField: String, fileURL: URL, fileName: String, mime: String) throws -> URL {
        let out = FileManager.default.temporaryDirectory.appendingPathComponent("mp-\(UUID().uuidString)")
        FileManager.default.createFile(atPath: out.path, contents: nil)
        let h = try FileHandle(forWritingTo: out)
        defer { try? h.close() }
        func w(_ s: String) throws { try h.write(contentsOf: Data(s.utf8)) }
        for (k, v) in fields {
            try w("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(k)\"\r\n\r\n\(v)\r\n")
        }
        let safeName = fileName.replacingOccurrences(of: "\"", with: "'").replacingOccurrences(of: "\r", with: "").replacingOccurrences(of: "\n", with: "")
        try w("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(fileField)\"; filename=\"\(safeName)\"\r\nContent-Type: \(mime)\r\n\r\n")
        let input = try FileHandle(forReadingFrom: fileURL)
        defer { try? input.close() }
        while let chunk = try input.read(upToCount: 1 << 20), !chunk.isEmpty {
            try h.write(contentsOf: chunk)
        }
        try w("\r\n--\(boundary)--\r\n")
        return out
    }
}
