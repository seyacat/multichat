import Foundation
import UserNotifications

/// Descifra el objeto `mc` del push (protocol.md §8) con la clave de cuenta del Keychain compartido.
final class NotificationService: UNNotificationServiceExtension, @unchecked Sendable {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttempt: UNMutableNotificationContent?
    private var work: Task<Void, Never>?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        self.contentHandler = contentHandler
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content)
            return
        }
        bestAttempt = content
        guard let mcObj = request.content.userInfo["mc"],
              let mcData = try? JSONSerialization.data(withJSONObject: mcObj),
              let mc = try? JSONDecoder().decode(PushMC.self, from: mcData) else {
            contentHandler(content)
            return
        }
        work = Task { [weak self] in
            let rendered = await NotificationRenderer.render(mc)
            guard let self else { return }
            self.deliver(rendered)
        }
    }

    private func deliver(_ r: NotificationRenderer.Rendered) {
        guard let content = bestAttempt, let handler = contentHandler else { return }
        if let t = r.title { content.title = t }
        if let b = r.body { content.body = b }
        content.threadIdentifier = r.threadId
        contentHandler = nil
        handler(content)
    }

    override func serviceExtensionTimeWillExpire() {
        work?.cancel()
        if let handler = contentHandler, let content = bestAttempt {
            contentHandler = nil
            handler(content)
        }
    }
}

enum NotificationRenderer {
    struct Rendered: Sendable {
        var title: String?
        var body: String?
        var threadId: String
    }

    static func render(_ mc: PushMC) async -> Rendered {
        var out = Rendered(title: nil, body: nil, threadId: mc.contactId)
        guard let key = SecureStore.loadAccountKey() else { return out }

        var name: String?
        if let a = mc.alias, let alias = try? Envelope.openJSON(AliasPayload.self, a, privateKey: key) { name = alias.name }
        if name == nil, let p = mc.profile, let profile = try? Envelope.openJSON(ContactProfile.self, p, privateKey: key) {
            name = profile.name ?? profile.username ?? profile.phone
        }
        out.title = name

        if mc.hidePreview == true {
            out.body = "Nuevo mensaje"
            return out
        }
        var payload: MessagePayload?
        if let env = mc.envelope {
            payload = try? Envelope.openJSON(MessagePayload.self, env, privateKey: key)
        } else {
            payload = await fetchPayload(messageId: mc.messageId, seq: mc.seq, key: key)
        }
        if let payload {
            let text = payload.previewText
            if let sender = payload.senderName, !sender.isEmpty {
                out.body = "\(sender): \(text)"
            } else {
                out.body = text
            }
        }
        return out
    }

    /// El push no trajo el sobre (> 4 KB): se baja con GET /api/messages?since=<seq - 1>
    /// (o desde el último seq conocido si el push no trae seq).
    private static func fetchPayload(messageId: String, seq: Int?, key: Data) async -> MessagePayload? {
        guard var session = SecureStore.loadSession(), let base = URL(string: AppGroup.serverURL) else { return nil }
        var since = seq.map { max(0, $0 - 1) } ?? max(0, AppGroup.lastSeq)
        for _ in 0..<3 {
            var comps = URLComponents(url: base.appendingPathComponent("api/messages"), resolvingAgainstBaseURL: false)!
            comps.queryItems = [URLQueryItem(name: "since", value: String(since)), URLQueryItem(name: "limit", value: "200")]
            var req = URLRequest(url: comps.url!)
            req.timeoutInterval = 10
            req.setValue("Bearer \(session.accessToken)", forHTTPHeaderField: "Authorization")
            guard let (data, resp) = try? await URLSession.shared.data(for: req) else { return nil }
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if status == 401 {
                guard let fresh = await refresh(session, base: base) else { return nil }
                session = fresh
                continue
            }
            guard status == 200, let page = try? JSONDecoder().decode(MessagesPage.self, from: data) else { return nil }
            if let m = page.messages.first(where: { $0.id == messageId }), let env = m.envelope {
                return try? Envelope.openJSON(MessagePayload.self, env, privateKey: key)
            }
            guard page.more, let last = page.messages.last else { return nil }
            since = last.seq
        }
        return nil
    }

    private static func refresh(_ s: Session, base: URL) async -> Session? {
        var req = URLRequest(url: base.appendingPathComponent("api/auth/refresh"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONEncoder().encode(["refreshToken": s.refreshToken])
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              (resp as? HTTPURLResponse)?.statusCode == 200,
              var ns = try? JSONDecoder().decode(Session.self, from: data) else { return nil }
        ns.obtainedAt = Date()
        // El refresh rota el token: se guarda para que la app use el nuevo.
        SecureStore.saveSession(ns)
        return ns
    }
}
