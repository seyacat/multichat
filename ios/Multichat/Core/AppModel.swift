import Foundation
import Observation
import SwiftData
import UIKit
import UserNotifications

/// Estado global de la app: sesión, clave de cuenta, sincronización, tiempo real y operaciones.
@Observable
@MainActor
final class AppModel {
    static let shared = AppModel()

    enum Phase: Equatable { case loggedOut, needsKey, ready }

    var phase: Phase = .loggedOut
    var session: Session?
    var integrations: [Integration] = []
    var wsState: WebSocketClient.State = .disconnected
    var syncing = false
    var lastError: String?
    var uploadProgress: [String: Double] = [:]
    /// Chat visible ahora (para no avisar de lo que ya se está leyendo).
    var openContactId: String?
    /// Chat a abrir al tocar una notificación.
    var pendingOpenContactId: String?
    var notificationStatus: UNAuthorizationStatus = .notDetermined

    @ObservationIgnored private(set) var accountKey: Data?
    @ObservationIgnored let container: ModelContainer
    @ObservationIgnored private(set) var api: APIClient?
    @ObservationIgnored private var ws: WebSocketClient?
    @ObservationIgnored private(set) var blobs: BlobStore!
    @ObservationIgnored private var syncAgain = false
    /// Recibe los eventos `link` del WebSocket mientras se vincula este dispositivo.
    @ObservationIgnored var onLinkEvent: ((String, String) -> Void)?

    var context: ModelContext { container.mainContext }

    var serverURL: String {
        get { AppGroup.serverURL }
        set { AppGroup.serverURL = newValue }
    }

    init(container: ModelContainer? = nil) {
        self.container = container ?? Persistence.makeContainer()
        blobs = BlobStore(api: { [weak self] in self?.api })
        accountKey = SecureStore.loadAccountKey()
        loadCachedIntegrations()
        if let s = SecureStore.loadSession() {
            session = s
            configureAPI(s)
            phase = keyMatches(s.user.accountPublicKey) ? .ready : .needsKey
            startRealtime()
            Task { await refreshMe() }
        }
    }

    // MARK: Sesión

    private func configureAPI(_ s: Session?) {
        let base = URL(string: serverURL) ?? URL(string: AppGroup.defaultServerURL)!
        let api = APIClient(baseURL: base, session: s)
        api.onSessionChange = { [weak self] ns in
            guard let self else { return }
            SecureStore.saveSession(ns)
            if let ns {
                self.session = ns
            } else if self.session != nil {
                // Refresh rechazado: la sesión ya no vale.
                self.lastError = "La sesión ha caducado. Vuelve a entrar."
                self.localLogout()
            }
        }
        self.api = api
        let ws = WebSocketClient(api: api)
        ws.onState = { [weak self] st in self?.wsState = st }
        ws.onConnected = { [weak self] in Task { await self?.sync() } }
        ws.onPoll = { [weak self] in Task { await self?.sync() } }
        ws.onEvent = { [weak self] ev in self?.handle(ev) }
        self.ws = ws
    }

    private func keyMatches(_ pub: String?) -> Bool {
        guard let pub, let key = accountKey, let mine = try? X25519.publicKey(fromPrivate: key) else { return false }
        return B64U.encode(mine) == pub
    }

    var accountPublicKeyB64U: String? {
        if let k = accountKey, let p = try? X25519.publicKey(fromPrivate: k) { return B64U.encode(p) }
        return session?.user.accountPublicKey
    }

    func authenticate(register: Bool, email: String, password: String, deviceName: String) async throws {
        configureAPI(nil)
        guard let api else { return }
        let s = try await api.authenticate(register: register, email: email, password: password, deviceName: deviceName)
        session = s
        SecureStore.saveSession(s)
        decidePhase(s.user)
        startRealtime()
    }

    private func decidePhase(_ user: APIUser) {
        if keyMatches(user.accountPublicKey) {
            if phase != .ready { phase = .ready; Task { await sync() } }
        } else {
            if accountKey != nil, user.accountPublicKey != nil {
                // La clave guardada no es la de esta cuenta: se descarta.
                SecureStore.saveAccountKey(nil)
                accountKey = nil
            }
            phase = .needsKey
        }
    }

    func refreshMe() async {
        guard let api else { return }
        do {
            let me = try await api.me()
            if var s = session {
                s.user = me.user
                s.device = me.device
                session = s
                SecureStore.saveSession(s)
            }
            decidePhase(me.user)
        } catch {}
    }

    func logout() async {
        if let api {
            session = nil // evita que el cierre de sesión se tome por caducidad
            _ = try? await api.setPush(token: nil)
            await api.logout()
        }
        localLogout()
    }

    /// Borra sesión, clave y caché de este dispositivo.
    func localLogout() {
        ws?.stop()
        ws = nil
        api = nil
        session = nil
        SecureStore.saveSession(nil)
        SecureStore.saveAccountKey(nil)
        accountKey = nil
        integrations = []
        uploadProgress = [:]
        try? context.delete(model: CachedMessage.self)
        try? context.delete(model: CachedContact.self)
        try? context.delete(model: CachedIntegration.self)
        try? context.delete(model: SyncState.self)
        try? context.save()
        AppGroup.lastSeq = 0
        BlobStore.clearAll()
        try? FileManager.default.removeItem(at: Self.outbox)
        phase = .loggedOut
    }

    // MARK: Clave de cuenta

    private func storeAccountKey(_ key: Data) {
        SecureStore.saveAccountKey(key)
        accountKey = key
    }

    /// Primer dispositivo: genera la clave y sube la pública.
    func generateAccountKey() async throws {
        guard let api else { return }
        let key = X25519.generatePrivate()
        let pub = B64U.encode(try X25519.publicKey(fromPrivate: key))
        storeAccountKey(key)
        do {
            try await api.putAccountKey(pub)
        } catch let e as APIError {
            SecureStore.saveAccountKey(nil)
            accountKey = nil
            if e.code == "conflict" { await refreshMe() }
            throw e
        }
        if var s = session { s.user.accountPublicKey = pub; session = s; SecureStore.saveSession(s) }
        decidePhase(session!.user)
    }

    var recoveryKeyText: String? { accountKey.map { "multichat-key:" + B64U.encode($0) } }

    func importRecoveryKey(_ text: String) async throws {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard t.hasPrefix("multichat-key:"), let key = B64U.decode(String(t.dropFirst("multichat-key:".count))), key.count == 32 else {
            throw APIError(status: 0, code: "bad_request", message: "El texto no es una clave de recuperación válida (multichat-key:…).")
        }
        let pub = B64U.encode(try X25519.publicKey(fromPrivate: key))
        await refreshMe()
        if let expected = session?.user.accountPublicKey {
            guard expected == pub else {
                throw APIError(status: 0, code: "bad_request", message: "Esa clave no corresponde a esta cuenta.")
            }
        } else if let api {
            try await api.putAccountKey(pub)
            if var s = session { s.user.accountPublicKey = pub; session = s; SecureStore.saveSession(s) }
        }
        storeAccountKey(key)
        decidePhase(session!.user)
    }

    /// Dispositivo nuevo: abre el `sealedKey` del vínculo con la efímera y guarda la clave.
    func completeLink(sealedKey: String, ephemeralPrivate: Data) async throws {
        guard let env = B64U.decode(sealedKey) else { throw CryptoError.invalidEnvelope }
        let key = try Envelope.open(env, privateKey: ephemeralPrivate)
        guard key.count == 32 else { throw CryptoError.invalidKey }
        let pub = B64U.encode(try X25519.publicKey(fromPrivate: key))
        await refreshMe()
        guard session?.user.accountPublicKey == pub else {
            throw APIError(status: 0, code: "bad_request", message: "La clave recibida no coincide con la de la cuenta.")
        }
        storeAccountKey(key)
        decidePhase(session!.user)
    }

    static func parseLinkText(_ text: String) -> (id: String, pub: String)? {
        let parts = text.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0] == "multichat-link", !parts[1].isEmpty,
              let pub = B64U.decode(String(parts[2])), pub.count == 32 else { return nil }
        return (String(parts[1]), String(parts[2]))
    }

    /// Dispositivo vinculado: aprueba un vínculo sellando la privada de cuenta a la efímera del nuevo.
    func approveLink(id: String, ephemeralPublicKey: String) async throws {
        guard let api, let key = accountKey, let epub = B64U.decode(ephemeralPublicKey) else { return }
        let sealed = B64U.encode(try Envelope.seal(key, to: epub))
        try await api.approveLink(id, sealedKey: sealed)
    }

    // MARK: Tiempo real y sincronización

    private func startRealtime() {
        ws?.start()
    }

    func didBecomeActive() {
        ws?.kick()
        Task { await sync() }
        Task { await refreshNotificationStatus() }
    }

    private var syncState: SyncState {
        if let s = try? context.fetch(FetchDescriptor<SyncState>()).first { return s }
        let s = SyncState()
        context.insert(s)
        return s
    }

    var lastSeq: Int { syncState.lastSeq }

    func sync() async {
        guard phase == .ready, let api else { return }
        if syncing { syncAgain = true; return }
        syncing = true
        defer {
            syncing = false
            if syncAgain { syncAgain = false; Task { await sync() } }
        }
        do {
            applyIntegrations(try await api.integrations())
            let since = lastSeq
            var maxSeq = since
            var contactCursor = since
            for c in try await api.contacts(since: since) {
                upsertContact(c)
                contactCursor = max(contactCursor, c.seq)
            }
            var cursor = since
            var more = true
            while more {
                let page = try await api.messages(since: cursor, limit: 500)
                for m in page.messages {
                    upsertMessage(m)
                    cursor = max(cursor, m.seq)
                }
                more = page.more && !page.messages.isEmpty
            }
            // Contactos que cambiaron mientras se paginaban los mensajes (comparten contador).
            for c in try await api.contacts(since: contactCursor) {
                upsertContact(c)
                contactCursor = max(contactCursor, c.seq)
            }
            maxSeq = max(maxSeq, cursor, contactCursor)
            setLastSeq(maxSeq)
            try? context.save()
            lastError = nil
        } catch let e as APIError where e.code == "network" {
            // Sin red: la caché sigue valiendo; se reintenta al reconectar.
        } catch {
            lastError = error.localizedDescription
        }
    }

    private func setLastSeq(_ seq: Int) {
        let s = syncState
        if seq > s.lastSeq { s.lastSeq = seq }
        AppGroup.lastSeq = s.lastSeq
    }

    private func handle(_ ev: WSEvent) {
        switch ev.type {
        case "link":
            if let id = ev.id, let sk = ev.sealedKey { onLinkEvent?(id, sk) }
        case "integration":
            if let i = ev.integration { upsertIntegration(i) }
        case "integration_deleted":
            if let id = ev.id { removeIntegrationLocally(id) }
        case "contact":
            guard phase == .ready, let c = ev.contact else { return }
            upsertContact(c)
            setLastSeq(c.seq)
            try? context.save()
        case "contact_deleted":
            if let id = ev.id { removeContactLocally(id) }
        case "message":
            guard phase == .ready, let m = ev.message else { return }
            upsertMessage(m)
            setLastSeq(m.seq)
            try? context.save()
            if m.direction == "in", m.contactId == openContactId, UIApplication.shared.applicationState == .active {
                markRead(contactId: m.contactId, force: true)
            }
        default:
            break
        }
    }

    // MARK: Caché

    func contact(_ id: String) -> CachedContact? {
        try? context.fetch(FetchDescriptor<CachedContact>(predicate: #Predicate { $0.id == id })).first
    }

    private func message(id: String) -> CachedMessage? {
        try? context.fetch(FetchDescriptor<CachedMessage>(predicate: #Predicate { $0.id == id })).first
    }

    private func message(clientId: String) -> CachedMessage? {
        try? context.fetch(FetchDescriptor<CachedMessage>(predicate: #Predicate { $0.clientId == clientId })).first
    }

    func upsertContact(_ c: Contact) {
        let cc: CachedContact
        if let existing = contact(c.id) {
            if existing.seq > c.seq { return }
            cc = existing
        } else {
            cc = CachedContact(id: c.id, integrationId: c.integrationId)
            context.insert(cc)
        }
        cc.integrationId = c.integrationId
        cc.kind = c.kind
        cc.status = c.status
        cc.muted = c.muted
        cc.hidePreview = c.hidePreview
        cc.unread = c.unread
        cc.lastMessageAt = c.lastMessageAt
        cc.lastInboundAt = c.lastInboundAt
        cc.seq = c.seq
        cc.createdAt = c.createdAt ?? cc.createdAt
        if let key = accountKey {
            if let p = try? Envelope.openJSON(ContactProfile.self, c.profile, privateKey: key) {
                cc.profileName = p.name ?? ""
                cc.username = p.username
                cc.phone = p.phone
                cc.platform = p.platform
            }
            if let a = c.alias {
                cc.aliasName = (try? Envelope.openJSON(AliasPayload.self, a, privateKey: key))?.name
            } else {
                cc.aliasName = nil
            }
        }
    }

    @discardableResult
    func upsertMessage(_ m: Message) -> CachedMessage? {
        var cm = message(id: m.id)
        if cm == nil, let cid = m.clientId { cm = message(clientId: cid) }
        if let cm, cm.seq > m.seq, !cm.id.hasPrefix("local:") { return cm }
        let msg: CachedMessage
        if let cm {
            msg = cm
            msg.id = m.id
        } else {
            msg = CachedMessage(id: m.id, contactId: m.contactId)
            context.insert(msg)
        }
        msg.contactId = m.contactId
        msg.clientId = m.clientId ?? msg.clientId
        msg.direction = m.direction
        msg.status = m.status
        msg.error = m.error
        msg.seq = m.seq
        if msg.createdAt == 0 || !msg.id.hasPrefix("local:") { msg.createdAt = m.createdAt }
        if let env = m.envelope, let key = accountKey {
            if let p = try? Envelope.openJSON(MessagePayload.self, env, privateKey: key) {
                msg.apply(p)
                msg.decryptFailed = false
            } else if msg.blobId == nil && msg.text == nil {
                msg.decryptFailed = true
            }
        }
        if let local = msg.localFile, let a = msg.payload.attachment, !a.fileKey.isEmpty {
            blobs.seed(a, from: Self.outbox.appendingPathComponent(local))
        }
        updatePreview(for: msg)
        return msg
    }

    private func updatePreview(for msg: CachedMessage) {
        guard !msg.hidden, let c = contact(msg.contactId) else { return }
        if (c.previewAt ?? 0) <= msg.createdAt {
            c.previewAt = msg.createdAt
            c.previewText = msg.decryptFailed ? "🔒 No se pudo descifrar" : msg.payload.previewText
            c.previewOutgoing = msg.direction == "out"
            c.previewStatus = msg.status
        }
    }

    private func removeContactLocally(_ id: String) {
        if let c = contact(id) { context.delete(c) }
        try? context.delete(model: CachedMessage.self, where: #Predicate { $0.contactId == id })
        try? context.save()
    }

    // MARK: Integraciones

    private func loadCachedIntegrations() {
        let rows = (try? context.fetch(FetchDescriptor<CachedIntegration>())) ?? []
        integrations = rows.compactMap { try? JSONDecoder().decode(Integration.self, from: $0.json) }
            .sorted { ($0.createdAt ?? 0) < ($1.createdAt ?? 0) }
    }

    func integration(_ id: String) -> Integration? { integrations.first { $0.id == id } }

    private func applyIntegrations(_ list: [Integration]) {
        integrations = list.sorted { ($0.createdAt ?? 0) < ($1.createdAt ?? 0) }
        try? context.delete(model: CachedIntegration.self)
        for i in list {
            if let d = try? JSONEncoder().encode(i) { context.insert(CachedIntegration(id: i.id, json: d)) }
        }
        try? context.save()
    }

    func upsertIntegration(_ i: Integration) {
        var list = integrations
        if let idx = list.firstIndex(where: { $0.id == i.id }) { list[idx] = i } else { list.append(i) }
        applyIntegrations(list)
    }

    private func removeIntegrationLocally(_ id: String) {
        applyIntegrations(integrations.filter { $0.id != id })
        let contacts = (try? context.fetch(FetchDescriptor<CachedContact>(predicate: #Predicate { $0.integrationId == id }))) ?? []
        for c in contacts { removeContactLocally(c.id) }
    }

    func createIntegration(_ body: APIClient.CreateBody) async throws -> Integration {
        guard let api else { throw APIError(status: 401, code: "unauthorized", message: "Sesión cerrada") }
        let i = try await api.createIntegration(body)
        upsertIntegration(i)
        return i
    }

    func patchIntegration(_ id: String, _ body: APIClient.PatchIntegration) async throws {
        guard let api else { return }
        upsertIntegration(try await api.patchIntegration(id, body))
    }

    func deleteIntegration(_ id: String) async throws {
        guard let api else { return }
        try await api.deleteIntegration(id)
        removeIntegrationLocally(id)
    }

    // MARK: Contactos

    func patchContact(_ id: String, _ body: APIClient.PatchContact) async {
        guard let api else { return }
        do {
            upsertContact(try await api.patchContact(id, body))
            try? context.save()
        } catch {
            lastError = error.localizedDescription
        }
    }

    func setStatus(_ c: CachedContact, _ status: String) async {
        c.status = status
        await patchContact(c.id, .init(status: status))
    }

    func setAlias(_ c: CachedContact, _ name: String) async {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            c.aliasName = nil
            await patchContact(c.id, .init(alias: .some(nil)))
            return
        }
        guard let pub = accountPublicKeyB64U, let env = try? Envelope.sealJSON(AliasPayload(name: trimmed), toB64U: pub) else { return }
        c.aliasName = trimmed
        await patchContact(c.id, .init(alias: .some(env)))
    }

    func markRead(contactId: String, force: Bool = false) {
        guard let c = contact(contactId), c.unread > 0 || force else { return }
        c.unread = 0
        Task { await patchContact(contactId, .init(read: true)) }
    }

    func deleteContact(_ c: CachedContact) async {
        guard let api else { return }
        let id = c.id
        do {
            try await api.deleteContact(id)
            removeContactLocally(id)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func loadOlder(contactId: String) async -> Int {
        guard let api else { return 0 }
        var d = FetchDescriptor<CachedMessage>(predicate: #Predicate { $0.contactId == contactId },
                                               sortBy: [SortDescriptor(\.createdAt)])
        d.fetchLimit = 100
        let oldest = ((try? context.fetch(d)) ?? []).first { !$0.id.hasPrefix("local:") }?.createdAt
            ?? Date().timeIntervalSince1970 * 1000
        do {
            let list = try await api.olderMessages(contactId: contactId, before: oldest, limit: 50)
            for m in list { upsertMessage(m) }
            try? context.save()
            return list.count
        } catch {
            lastError = error.localizedDescription
            return 0
        }
    }

    // MARK: Envío

    static var outbox: URL {
        let d = AppGroup.containerURL.appendingPathComponent("outbox", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    private func newOutgoing(contactId: String, clientId: String, kind: String) -> CachedMessage {
        let m = CachedMessage(id: "local:\(clientId)", contactId: contactId)
        m.clientId = clientId
        m.direction = "out"
        m.status = "pending"
        m.kind = kind
        m.createdAt = Date().timeIntervalSince1970 * 1000
        context.insert(m)
        return m
    }

    func sendText(_ text: String, contactId: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        let clientId = UUID().uuidString.lowercased()
        let m = newOutgoing(contactId: contactId, clientId: clientId, kind: "text")
        m.text = t
        updatePreview(for: m)
        try? context.save()
        Task { await deliver(clientId: clientId) }
    }

    /// Envía un archivo. `source` se copia a la bandeja de salida del App Group (sirve para reintentar).
    func sendFile(_ source: URL, name: String, mime: String, kind: String, caption: String?, contactId: String) {
        let clientId = UUID().uuidString.lowercased()
        let ext = (name as NSString).pathExtension
        let localName = clientId + (ext.isEmpty ? "" : ".\(ext)")
        let dst = Self.outbox.appendingPathComponent(localName)
        do {
            try? FileManager.default.removeItem(at: dst)
            try FileManager.default.copyItem(at: source, to: dst)
        } catch {
            lastError = "No se pudo preparar el archivo: \(error.localizedDescription)"
            return
        }
        let m = newOutgoing(contactId: contactId, clientId: clientId, kind: kind)
        let cap = caption?.trimmingCharacters(in: .whitespacesAndNewlines)
        m.text = (cap?.isEmpty ?? true) ? nil : cap
        m.fileName = name
        m.mime = mime
        m.localFile = localName
        m.fileSize = (try? FileManager.default.attributesOfItem(atPath: dst.path)[.size] as? NSNumber)?.intValue
        updatePreview(for: m)
        try? context.save()
        Task { await deliver(clientId: clientId) }
    }

    private func deliver(clientId: String) async {
        guard let api, let m = message(clientId: clientId) else { return }
        let contactId = m.contactId
        do {
            let result: Message
            if let local = m.localFile {
                let kind = m.kind
                uploadProgress[clientId] = 0
                defer { uploadProgress[clientId] = nil }
                result = try await api.sendMedia(
                    contactId: contactId, clientId: clientId, text: m.text, kind: kind,
                    fileURL: Self.outbox.appendingPathComponent(local),
                    fileName: m.fileName ?? local, mime: m.mime ?? "application/octet-stream",
                    progress: { p in Task { @MainActor in AppModel.shared.uploadProgress[clientId] = p } }
                )
            } else {
                result = try await api.sendText(contactId: contactId, clientId: clientId, text: m.text ?? "")
            }
            upsertMessage(result)
        } catch {
            if let m = message(clientId: clientId), m.id.hasPrefix("local:") {
                m.status = "failed"
                m.error = error.localizedDescription
                updatePreview(for: m)
            }
        }
        try? context.save()
    }

    func retry(_ m: CachedMessage) async {
        if m.id.hasPrefix("local:"), let cid = m.clientId {
            // Nunca llegó al servidor: se reintenta con el mismo clientId.
            m.status = "pending"
            m.error = nil
            try? context.save()
            await deliver(clientId: cid)
            return
        }
        // El servidor lo marcó fallido: se manda una copia nueva y se oculta el original.
        if let local = m.localFile {
            m.hidden = true
            sendFile(Self.outbox.appendingPathComponent(local), name: m.fileName ?? local,
                     mime: m.mime ?? "application/octet-stream", kind: m.kind, caption: m.text, contactId: m.contactId)
        } else if let a = m.payload.attachment, !a.fileKey.isEmpty {
            do {
                let url = try await blobs.file(for: a)
                m.hidden = true
                sendFile(url, name: a.name ?? url.lastPathComponent, mime: a.mime ?? "application/octet-stream",
                         kind: m.kind, caption: m.text, contactId: m.contactId)
            } catch {
                lastError = error.localizedDescription
            }
        } else if let t = m.text {
            m.hidden = true
            sendText(t, contactId: m.contactId)
        }
        try? context.save()
    }

    // MARK: Dispositivos

    func me() async throws -> MeResponse {
        guard let api else { throw APIError(status: 401, code: "unauthorized", message: "Sesión cerrada") }
        return try await api.me()
    }

    func revokeDevice(_ id: String) async throws {
        guard let api else { return }
        try await api.deleteDevice(id)
        if id == session?.device.id { localLogout() }
    }

    func linkInfo(_ id: String) async throws -> LinkInfo {
        guard let api else { throw APIError(status: 401, code: "unauthorized", message: "Sesión cerrada") }
        return try await api.getLink(id)
    }

    func createLink(ephemeralPublicKey: String) async throws -> LinkCreated {
        guard let api else { throw APIError(status: 401, code: "unauthorized", message: "Sesión cerrada") }
        return try await api.createLink(ephemeralPublicKey: ephemeralPublicKey)
    }

    // MARK: Notificaciones

    func refreshNotificationStatus() async {
        notificationStatus = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        if notificationStatus == .authorized || notificationStatus == .provisional {
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    func requestNotifications() async {
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
        await refreshNotificationStatus()
    }

    func didRegisterPushToken(_ token: Data) {
        let hex = token.map { String(format: "%02x", $0) }.joined()
        AppGroup.defaults.set(hex, forKey: "apnsToken")
        Task {
            do { try await api?.setPush(token: hex) } catch { lastError = error.localizedDescription }
        }
    }

    func disablePush() async {
        do {
            try await api?.setPush(token: nil)
            UIApplication.shared.unregisterForRemoteNotifications()
        } catch {
            lastError = error.localizedDescription
        }
    }

    // MARK: Ayudas

    func integrationAccessor(for c: CachedContact) -> Integration? { integration(c.integrationId) }

    func whatsappWindowClosed(_ c: CachedContact) -> Bool {
        guard integration(c.integrationId)?.type == .whatsapp else { return false }
        guard let last = c.lastInboundAt else { return true }
        return Date().timeIntervalSince1970 * 1000 - last > 24 * 3600 * 1000
    }
}
