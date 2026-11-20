import AVKit
import PhotosUI
import QuickLook
import SwiftData
import SwiftUI
import UniformTypeIdentifiers

struct ChatView: View {
    let contactId: String
    @Environment(AppModel.self) private var model
    @Query private var messages: [CachedMessage]
    @Query private var contactRows: [CachedContact]

    @State private var text = ""
    @State private var showPhotos = false
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var showCamera = false
    @State private var showFiles = false
    @State private var loadingOlder = false
    @State private var noMoreOlder = false
    @State private var viewerImage: URL?
    @State private var videoURL: URL?
    @State private var quickLookURL: URL?
    @FocusState private var focused: Bool

    init(contactId: String) {
        self.contactId = contactId
        _messages = Query(filter: #Predicate<CachedMessage> { $0.contactId == contactId && !$0.hidden },
                          sort: [SortDescriptor(\CachedMessage.createdAt)])
        _contactRows = Query(filter: #Predicate<CachedContact> { $0.id == contactId })
    }

    private var contact: CachedContact? { contactRows.first }

    private enum Row: Identifiable {
        case day(Date)
        case message(CachedMessage)
        var id: String {
            switch self {
            case .day(let d): "day-\(d.timeIntervalSince1970)"
            case .message(let m): m.id
            }
        }
    }

    private var rows: [Row] {
        var out: [Row] = []
        var lastDay: Date?
        let cal = Calendar.current
        for m in messages {
            let day = cal.startOfDay(for: Fmt.date(m.createdAt))
            if day != lastDay {
                out.append(.day(day))
                lastDay = day
            }
            out.append(.message(m))
        }
        return out
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 4) {
                    if !messages.isEmpty && !noMoreOlder {
                        Button {
                            Task { await loadOlder() }
                        } label: {
                            if loadingOlder { ProgressView() } else { Text("Cargar mensajes anteriores").font(.footnote) }
                        }
                        .padding(.vertical, 8)
                    }
                    ForEach(rows) { row in
                        switch row {
                        case .day(let d):
                            Text(Fmt.daySeparator(d))
                                .font(.caption.weight(.medium))
                                .padding(.horizontal, 10)
                                .padding(.vertical, 4)
                                .background(.thinMaterial, in: Capsule())
                                .padding(.vertical, 6)
                        case .message(let m):
                            MessageBubble(
                                message: m,
                                showSender: contact?.kind == "group",
                                onRetry: { Task { await model.retry(m) } },
                                onImage: { viewerImage = $0 },
                                onVideo: { videoURL = $0 },
                                onFile: { quickLookURL = $0 }
                            )
                            .id(m.id)
                        }
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal, 10)
                .padding(.top, 8)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: messages.count) { old, new in
                if new > old, messages.last?.direction == "out" || isNearBottom {
                    withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
                }
                model.markRead(contactId: contactId)
            }
            .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
        }
        .background(Color(.systemGroupedBackground))
        .safeAreaInset(edge: .bottom) { bottomBar }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                NavigationLink {
                    ContactDetailView(contactId: contactId)
                } label: {
                    header
                }
                .buttonStyle(.plain)
            }
        }
        .onAppear {
            model.openContactId = contactId
            model.markRead(contactId: contactId, force: (contact?.unread ?? 0) > 0)
        }
        .onDisappear {
            if model.openContactId == contactId { model.openContactId = nil }
        }
        .photosPicker(isPresented: $showPhotos, selection: $photoItems, maxSelectionCount: 10, matching: .any(of: [.images, .videos]))
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            photoItems = []
            Task { await sendPhotos(items) }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { result in sendCamera(result) }
                .ignoresSafeArea()
        }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { for u in urls { sendPicked(u) } }
        }
        .fullScreenCover(item: $viewerImage) { url in ImageViewer(url: url) }
        .sheet(item: $videoURL) { url in
            VideoPlayer(player: AVPlayer(url: url)).ignoresSafeArea()
        }
        .quickLookPreview($quickLookURL)
    }

    @State private var isNearBottom = true

    private var header: some View {
        HStack(spacing: 8) {
            if let c = contact {
                AvatarView(name: c.displayName, platform: model.integration(c.integrationId)?.type, isGroup: c.kind == "group", size: 32)
                VStack(alignment: .leading, spacing: 0) {
                    Text(c.displayName).font(.subheadline.bold()).lineLimit(1)
                    if let i = model.integration(c.integrationId) {
                        Text(i.name).font(.caption2).foregroundStyle(Color(hex: i.color)).lineLimit(1)
                    }
                }
            }
        }
    }

    @ViewBuilder private var bottomBar: some View {
        VStack(spacing: 0) {
            if let c = contact {
                if c.status == "pending" {
                    pendingBar(c)
                } else if c.status == "blocked" {
                    HStack {
                        Text("Contacto bloqueado").foregroundStyle(.secondary)
                        Spacer()
                        Button("Desbloquear") { Task { await model.setStatus(c, "accepted") } }
                    }
                    .padding()
                    .background(.bar)
                } else {
                    if model.whatsappWindowClosed(c) {
                        Label("Han pasado más de 24 h desde el último mensaje de este contacto. WhatsApp solo deja responder libremente dentro de esa ventana; el envío puede fallar.",
                              systemImage: "clock.badge.exclamationmark")
                            .font(.caption)
                            .padding(8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Color.yellow.opacity(0.2))
                    }
                    composer
                }
            }
        }
    }

    private func pendingBar(_ c: CachedContact) -> some View {
        VStack(spacing: 8) {
            Text("Este contacto aún no está aceptado. Acéptalo para poder responder.").font(.footnote).foregroundStyle(.secondary)
            HStack {
                Button { Task { await model.setStatus(c, "accepted") } } label: {
                    Text("Aceptar").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                Button(role: .destructive) { Task { await model.setStatus(c, "blocked") } } label: {
                    Text("Bloquear").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
        }
        .padding()
        .background(.bar)
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            Menu {
                Button { showPhotos = true } label: { Label("Fotos y videos", systemImage: "photo.on.rectangle") }
                if UIImagePickerController.isSourceTypeAvailable(.camera) {
                    Button { showCamera = true } label: { Label("Cámara", systemImage: "camera") }
                }
                Button { showFiles = true } label: { Label("Archivo", systemImage: "doc") }
            } label: {
                Image(systemName: "plus.circle.fill").font(.system(size: 28))
            }
            .accessibilityLabel("Adjuntar")
            TextField("Mensaje", text: $text, axis: .vertical)
                .lineLimit(1...5)
                .focused($focused)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18))
            Button {
                model.sendText(text, contactId: contactId)
                text = ""
            } label: {
                Image(systemName: "arrow.up.circle.fill").font(.system(size: 30))
            }
            .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityLabel("Enviar")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(.bar)
    }

    // MARK: Acciones

    private func loadOlder() async {
        loadingOlder = true
        defer { loadingOlder = false }
        let n = await model.loadOlder(contactId: contactId)
        if n == 0 { noMoreOlder = true }
    }

    private func takeCaption() -> String? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        text = ""
        return t.isEmpty ? nil : t
    }

    private func send(file url: URL, name: String) {
        let type = UTType(filenameExtension: (name as NSString).pathExtension) ?? .data
        let mime = type.preferredMIMEType ?? "application/octet-stream"
        let kind: String
        if type.conforms(to: .image) { kind = "image" }
        else if type.conforms(to: .movie) || type.conforms(to: .video) { kind = "video" }
        else if type.conforms(to: .audio) { kind = "audio" }
        else { kind = "file" }
        model.sendFile(url, name: name, mime: mime, kind: kind, caption: takeCaption(), contactId: contactId)
    }

    private func sendPicked(_ url: URL) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        send(file: url, name: url.lastPathComponent)
    }

    private func sendPhotos(_ items: [PhotosPickerItem]) async {
        for item in items {
            do {
                if item.supportedContentTypes.contains(where: { $0.conforms(to: .movie) }) {
                    if let movie = try await item.loadTransferable(type: MovieFile.self) {
                        send(file: movie.url, name: "video-\(Self.stamp()).\(movie.url.pathExtension.isEmpty ? "mov" : movie.url.pathExtension)")
                        try? FileManager.default.removeItem(at: movie.url)
                    }
                } else if let data = try await item.loadTransferable(type: Data.self) {
                    try sendImageData(data)
                }
            } catch {
                model.lastError = "No se pudo leer el elemento: \(error.localizedDescription)"
            }
        }
    }

    /// Las fotos se envían como JPEG (HEIC no lo aceptan todas las plataformas).
    private func sendImageData(_ data: Data) throws {
        let jpeg = UIImage(data: data)?.jpegData(compressionQuality: 0.85) ?? data
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("foto-\(Self.stamp()).jpg")
        try jpeg.write(to: url)
        send(file: url, name: url.lastPathComponent)
        try? FileManager.default.removeItem(at: url)
    }

    private func sendCamera(_ result: CameraPicker.Result) {
        switch result {
        case .image(let img):
            if let d = img.jpegData(compressionQuality: 0.85) { try? sendImageData(d) }
        case .movie(let url):
            send(file: url, name: "video-\(Self.stamp()).\(url.pathExtension.isEmpty ? "mov" : url.pathExtension)")
        }
    }

    private static func stamp() -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyyMMdd-HHmmss"
        return f.string(from: Date())
    }
}

extension URL: @retroactive Identifiable {
    public var id: String { absoluteString }
}

struct MovieFile: Transferable {
    let url: URL
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { movie in
            SentTransferredFile(movie.url)
        } importing: { received in
            let ext = received.file.pathExtension
            let dst = FileManager.default.temporaryDirectory.appendingPathComponent("pick-\(UUID().uuidString).\(ext.isEmpty ? "mov" : ext)")
            try FileManager.default.copyItem(at: received.file, to: dst)
            return MovieFile(url: dst)
        }
    }
}

/// Cámara del sistema (foto o video).
struct CameraPicker: UIViewControllerRepresentable {
    enum Result { case image(UIImage), movie(URL) }
    let onPick: (Result) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let p = UIImagePickerController()
        p.sourceType = .camera
        p.mediaTypes = [UTType.image.identifier, UTType.movie.identifier]
        p.videoQuality = .typeMedium
        p.delegate = context.coordinator
        return p
    }

    func updateUIViewController(_ vc: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let url = info[.mediaURL] as? URL {
                parent.onPick(.movie(url))
            } else if let img = info[.originalImage] as? UIImage {
                parent.onPick(.image(img))
            }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
    }
}
