import AVFoundation
import MapKit
import SwiftUI
import UIKit

struct MessageBubble: View {
    @Environment(AppModel.self) private var model
    let message: CachedMessage
    let showSender: Bool
    let onRetry: () -> Void
    let onImage: (URL) -> Void
    let onVideo: (URL) -> Void
    let onFile: (URL) -> Void

    private var outgoing: Bool { message.direction == "out" }

    var body: some View {
        HStack {
            if outgoing { Spacer(minLength: 50) }
            VStack(alignment: outgoing ? .trailing : .leading, spacing: 2) {
                VStack(alignment: .leading, spacing: 4) {
                    if showSender, !outgoing, let s = message.senderName, !s.isEmpty {
                        Text(s).font(.caption.bold()).foregroundStyle(AvatarView.color(for: s))
                    }
                    content
                    HStack(spacing: 4) {
                        Spacer(minLength: 0)
                        Text(Fmt.date(message.createdAt).formatted(date: .omitted, time: .shortened))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        if outgoing { StatusIcon(status: message.status).font(.caption2) }
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(
                    RoundedRectangle(cornerRadius: 14)
                        .fill(outgoing ? Color.accentColor.opacity(0.22) : Color(.secondarySystemGroupedBackground))
                )
                if let p = message.clientId.flatMap({ model.uploadProgress[$0] }) {
                    ProgressView(value: p).frame(width: 140)
                }
                if message.status == "failed" {
                    Button(action: onRetry) {
                        Label(message.error.map { "No enviado: \($0). Reintentar" } ?? "No enviado. Reintentar",
                              systemImage: "arrow.clockwise")
                            .font(.caption)
                    }
                    .foregroundStyle(.red)
                }
            }
            if !outgoing { Spacer(minLength: 50) }
        }
    }

    @ViewBuilder private var content: some View {
        if message.decryptFailed {
            Label("No se pudo descifrar este mensaje", systemImage: "lock.trianglebadge.exclamationmark")
                .font(.callout).foregroundStyle(.secondary)
        } else {
            switch message.kind {
            case "image", "sticker":
                AttachmentImage(message: message, maxSide: message.kind == "sticker" ? 140 : 240, onOpen: onImage)
            case "video":
                AttachmentButton(message: message, systemImage: "play.rectangle.fill", title: message.fileName ?? "Video", onOpen: onVideo)
            case "audio":
                AudioAttachment(message: message)
            case "file":
                AttachmentButton(message: message, systemImage: "doc.fill", title: message.fileName ?? "Archivo", onOpen: onFile)
            case "location":
                if let lat = message.lat, let lon = message.lon { LocationAttachment(lat: lat, lon: lon) }
            case "text":
                EmptyView()
            default:
                Label("Tipo de mensaje no soportado", systemImage: "questionmark.square.dashed")
                    .font(.callout).foregroundStyle(.secondary)
            }
            if let t = message.text, !t.isEmpty {
                Text(t).textSelection(.enabled)
            }
        }
    }
}

extension AvatarView {
    static func color(for name: String) -> Color {
        let palette: [Color] = [.blue, .purple, .orange, .pink, .teal, .indigo, .green, .red, .brown, .cyan]
        var h: UInt32 = 5381
        for b in name.utf8 { h = (h &* 33) &+ UInt32(b) }
        return palette[Int(h % UInt32(palette.count))]
    }
}

/// Obtiene el archivo en claro de un adjunto: copia local del envío o blob descifrado de la caché.
@MainActor
enum AttachmentFile {
    static func url(for m: CachedMessage, model: AppModel) async throws -> URL {
        if let local = m.localFile {
            let u = AppModel.outbox.appendingPathComponent(local)
            if FileManager.default.fileExists(atPath: u.path) { return u }
        }
        guard let a = m.payload.attachment, !a.fileKey.isEmpty else {
            throw APIError(status: 0, code: "not_found", message: "El adjunto aún no está disponible.")
        }
        return try await model.blobs.file(for: a)
    }
}

struct AttachmentImage: View {
    @Environment(AppModel.self) private var model
    let message: CachedMessage
    let maxSide: CGFloat
    let onOpen: (URL) -> Void
    @State private var image: UIImage?
    @State private var url: URL?
    @State private var failed = false

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: maxSide, maxHeight: maxSide)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .onTapGesture { if let url { onOpen(url) } }
            } else if failed {
                Button {
                    failed = false
                    Task { await load() }
                } label: {
                    Label("No se pudo cargar la imagen. Tocar para reintentar", systemImage: "photo.badge.exclamationmark")
                        .font(.caption)
                }
            } else {
                RoundedRectangle(cornerRadius: 10)
                    .fill(Color.gray.opacity(0.2))
                    .frame(width: maxSide * 0.8, height: maxSide * 0.6)
                    .overlay(ProgressView())
            }
        }
        .task(id: message.blobId ?? message.localFile ?? message.id) { await load() }
    }

    private func load() async {
        do {
            let u = try await AttachmentFile.url(for: message, model: model)
            let img = await Task.detached { UIImage(contentsOfFile: u.path)?.preparingThumbnail(of: CGSize(width: 720, height: 720)) }.value
            url = u
            image = img
            failed = img == nil
        } catch {
            if message.blobId != nil || message.localFile != nil { failed = true }
        }
    }
}

struct AttachmentButton: View {
    @Environment(AppModel.self) private var model
    let message: CachedMessage
    let systemImage: String
    let title: String
    let onOpen: (URL) -> Void
    @State private var loading = false
    @State private var error: String?

    var body: some View {
        Button {
            Task {
                loading = true
                defer { loading = false }
                do {
                    onOpen(try await AttachmentFile.url(for: message, model: model))
                    error = nil
                } catch {
                    self.error = error.localizedDescription
                }
            }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: systemImage).font(.title2)
                VStack(alignment: .leading) {
                    Text(title).font(.callout).lineLimit(2).multilineTextAlignment(.leading)
                    Text(error ?? Fmt.bytes(message.fileSize)).font(.caption2).foregroundStyle(error == nil ? Color.secondary : Color.red)
                }
                if loading { ProgressView() }
            }
            .frame(minWidth: 160, alignment: .leading)
        }
        .buttonStyle(.plain)
    }
}

@MainActor
@Observable
final class AudioPlayback: NSObject, AVAudioPlayerDelegate {
    static let shared = AudioPlayback()
    var playingId: String?
    @ObservationIgnored private var player: AVAudioPlayer?

    func toggle(id: String, url: URL) {
        if playingId == id {
            player?.stop()
            playingId = nil
            return
        }
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback)
            try AVAudioSession.sharedInstance().setActive(true)
            let p = try AVAudioPlayer(contentsOf: url)
            p.delegate = self
            p.play()
            player = p
            playingId = id
        } catch {
            playingId = nil
        }
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in self.playingId = nil }
    }
}

struct AudioAttachment: View {
    @Environment(AppModel.self) private var model
    let message: CachedMessage
    @State private var playback = AudioPlayback.shared
    @State private var loading = false
    @State private var failed = false

    var body: some View {
        Button {
            Task {
                loading = true
                defer { loading = false }
                do {
                    playback.toggle(id: message.id, url: try await AttachmentFile.url(for: message, model: model))
                    failed = false
                } catch {
                    failed = true
                }
            }
        } label: {
            HStack(spacing: 10) {
                if loading {
                    ProgressView()
                } else {
                    Image(systemName: playback.playingId == message.id ? "stop.circle.fill" : "play.circle.fill").font(.title)
                }
                VStack(alignment: .leading) {
                    Text(failed ? "No se pudo cargar el audio" : "Audio").font(.callout)
                    Text(Fmt.bytes(message.fileSize)).font(.caption2).foregroundStyle(.secondary)
                }
            }
            .frame(minWidth: 160, alignment: .leading)
        }
        .buttonStyle(.plain)
    }
}

struct LocationAttachment: View {
    let lat: Double
    let lon: Double

    var body: some View {
        let coord = CLLocationCoordinate2D(latitude: lat, longitude: lon)
        Map(initialPosition: .region(MKCoordinateRegion(center: coord, latitudinalMeters: 800, longitudinalMeters: 800))) {
            Marker("Ubicación", coordinate: coord)
        }
        .frame(width: 230, height: 150)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .allowsHitTesting(false)
        .overlay(alignment: .bottomTrailing) {
            Link(destination: URL(string: "https://maps.apple.com/?ll=\(lat),\(lon)&q=Ubicaci%C3%B3n")!) {
                Image(systemName: "arrow.up.right.square.fill").font(.title2).padding(6)
            }
        }
    }
}

/// Visor de imagen a pantalla completa con zoom.
struct ImageViewer: View {
    let url: URL
    @Environment(\.dismiss) private var dismiss
    @State private var scale: CGFloat = 1
    @State private var lastScale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var lastOffset: CGSize = .zero

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            if let img = UIImage(contentsOfFile: url.path) {
                Image(uiImage: img)
                    .resizable()
                    .scaledToFit()
                    .scaleEffect(scale)
                    .offset(offset)
                    .gesture(
                        MagnifyGesture()
                            .onChanged { scale = max(1, lastScale * $0.magnification) }
                            .onEnded { _ in lastScale = scale; if scale == 1 { offset = .zero; lastOffset = .zero } }
                            .simultaneously(with: DragGesture()
                                .onChanged { v in
                                    guard scale > 1 else { return }
                                    offset = CGSize(width: lastOffset.width + v.translation.width, height: lastOffset.height + v.translation.height)
                                }
                                .onEnded { _ in lastOffset = offset })
                    )
                    .onTapGesture(count: 2) {
                        withAnimation {
                            scale = scale > 1 ? 1 : 2.5
                            lastScale = scale
                            if scale == 1 { offset = .zero; lastOffset = .zero }
                        }
                    }
            }
            HStack {
                ShareLink(item: url) { Image(systemName: "square.and.arrow.up") }
                Button { dismiss() } label: { Image(systemName: "xmark") }
            }
            .font(.title2)
            .foregroundStyle(.white)
            .padding()
        }
    }
}
