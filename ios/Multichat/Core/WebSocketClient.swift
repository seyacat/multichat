import Foundation

struct WSEvent: Decodable, Sendable {
    var type: String
    var message: Message?
    var contact: Contact?
    var integration: Integration?
    var id: String?
    var sealedKey: String?
}

/// WebSocket de tiempo real (protocol.md §7): ping cada 25 s y reconexión con backoff.
@MainActor
final class WebSocketClient {
    enum State: Equatable { case disconnected, connecting, connected }

    private(set) var state: State = .disconnected { didSet { onState?(state) } }
    var onEvent: ((WSEvent) -> Void)?
    var onState: ((State) -> Void)?
    /// Se llama tras cada conexión (la app sincroniza).
    var onConnected: (() -> Void)?
    /// Sondeo de respaldo mientras el WS no conecta (p. ej. detrás de un túnel sin WebSocket).
    var onPoll: (() -> Void)?
    private var pollTask: Task<Void, Never>?

    private let api: APIClient
    private let urlSession = URLSession(configuration: .default)
    private var task: URLSessionWebSocketTask?
    private var pingTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var attempt = 0
    private var wanted = false
    private var generation = 0

    init(api: APIClient) { self.api = api }

    func start() {
        wanted = true
        if state == .disconnected { connect() }
    }

    func stop() {
        wanted = false
        generation += 1
        reconnectTask?.cancel()
        pingTask?.cancel()
        stopPolling()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        state = .disconnected
    }

    /// Fuerza reconexión inmediata (al volver a primer plano).
    func kick() {
        guard wanted else { return }
        if state == .disconnected {
            reconnectTask?.cancel()
            attempt = 0
            connect()
        }
    }

    private func connect() {
        guard wanted else { return }
        generation += 1
        let gen = generation
        state = .connecting
        Task { @MainActor in
            do {
                try await api.ensureFreshToken()
            } catch let e as APIError where e.status == 401 {
                self.stop()
                return
            } catch {
                self.scheduleReconnect(gen)
                return
            }
            guard gen == self.generation, self.wanted, let token = self.api.session?.accessToken else { return }
            var comps = URLComponents(url: self.api.baseURL.appendingPathComponent("api/ws"), resolvingAgainstBaseURL: false)!
            comps.scheme = comps.scheme == "https" ? "wss" : "ws"
            comps.queryItems = [URLQueryItem(name: "token", value: token)]
            let t = self.urlSession.webSocketTask(with: comps.url!)
            self.task = t
            t.resume()
            self.receive(t, gen)
            self.startPing(t, gen)
        }
    }

    private func receive(_ t: URLSessionWebSocketTask, _ gen: Int) {
        Task { @MainActor [weak self] in
            while true {
                let data: Data?
                do {
                    switch try await t.receive() {
                    case .string(let s): data = Data(s.utf8)
                    case .data(let d): data = d
                    @unknown default: data = nil
                    }
                } catch {
                    guard let self else { return }
                    self.handleDrop(gen)
                    return
                }
                guard let self, gen == self.generation else { return }
                if self.state != .connected {
                    self.state = .connected
                    self.attempt = 0
                    self.stopPolling()
                    self.onConnected?()
                }
                if let data, let ev = try? JSONDecoder().decode(WSEvent.self, from: data) {
                    self.onEvent?(ev)
                }
            }
        }
    }

    private func startPing(_ t: URLSessionWebSocketTask, _ gen: Int) {
        pingTask?.cancel()
        pingTask = Task { @MainActor [weak self] in
            // Primer ping inmediato: confirma la conexión aunque el servidor no mande nada.
            var first = true
            while !Task.isCancelled {
                if !first { try? await Task.sleep(for: .seconds(25)) }
                first = false
                guard let self, gen == self.generation, !Task.isCancelled else { return }
                do {
                    try await t.send(.string("{\"type\":\"ping\"}"))
                } catch {
                    self.handleDrop(gen)
                    return
                }
            }
        }
    }

    private func handleDrop(_ gen: Int) {
        guard gen == generation else { return }
        pingTask?.cancel()
        task?.cancel(with: .abnormalClosure, reason: nil)
        task = nil
        state = .disconnected
        scheduleReconnect(gen)
    }

    private func scheduleReconnect(_ gen: Int) {
        guard wanted, gen == generation else { return }
        state = .disconnected
        attempt += 1
        if attempt >= 2 { startPolling() }
        let delay = min(30.0, pow(2.0, Double(min(attempt, 5)))) * Double.random(in: 0.8...1.2)
        reconnectTask?.cancel()
        reconnectTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self, !Task.isCancelled, self.wanted, self.state == .disconnected else { return }
            // Un fallo de handshake puede ser token caducado: forzar refresh la próxima vez.
            if self.attempt >= 2 { _ = try? await self.api.refresh() }
            self.connect()
        }
    }

    private func startPolling() {
        guard pollTask == nil, onPoll != nil else { return }
        pollTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(4))
                guard let self, !Task.isCancelled, self.wanted, self.state != .connected else { return }
                self.onPoll?()
            }
        }
    }

    private func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }
}
