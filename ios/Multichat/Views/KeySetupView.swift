import CoreImage
import CoreImage.CIFilterBuiltins
import SwiftUI
import UIKit

/// Configurar la clave de cuenta tras entrar (protocol.md §2 y §3).
struct KeySetupView: View {
    @Environment(AppModel.self) private var model
    @State private var busy = false
    @State private var error: String?
    @State private var importText = ""
    @State private var showLink = false

    private var firstDevice: Bool { model.session?.user.accountPublicKey == nil }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(firstDevice
                         ? "Es el primer dispositivo de esta cuenta. Genera la clave de cuenta: con ella se cifran tus mensajes y solo tus dispositivos podrán leerlos."
                         : "Esta cuenta ya tiene clave. Para leer tus mensajes en este dispositivo, vincúlalo desde otro dispositivo tuyo o importa la clave de recuperación.")
                }

                if firstDevice {
                    Section {
                        Button {
                            Task { await run { try await model.generateAccountKey() } }
                        } label: {
                            Label("Generar clave de cuenta", systemImage: "key.fill")
                        }
                        .disabled(busy)
                    }
                } else {
                    Section {
                        Button {
                            showLink = true
                        } label: {
                            Label("Vincular con otro dispositivo", systemImage: "qrcode")
                        }
                    } footer: {
                        Text("Muestra un código QR que escaneas desde Ajustes → Dispositivos en un dispositivo ya vinculado.")
                    }
                }

                Section {
                    TextField("multichat-key:…", text: $importText, axis: .vertical)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.system(.footnote, design: .monospaced))
                    Button("Pegar") { importText = UIPasteboard.general.string ?? "" }
                    Button("Importar clave") {
                        Task { await run { try await model.importRecoveryKey(importText) } }
                    }
                    .disabled(importText.isEmpty || busy)
                } header: {
                    Text("Clave de recuperación")
                } footer: {
                    Text("La clave de recuperación se ve en Ajustes → Clave de recuperación de un dispositivo vinculado.")
                }

                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }

                Section {
                    Button("Cerrar sesión", role: .destructive) {
                        Task { await model.logout() }
                    }
                }
            }
            .overlay { if busy { ProgressView() } }
            .navigationTitle("Clave de cuenta")
            .sheet(isPresented: $showLink) { LinkThisDeviceView() }
        }
    }

    private func run(_ op: () async throws -> Void) async {
        busy = true
        error = nil
        defer { busy = false }
        do { try await op() } catch { self.error = error.localizedDescription }
    }
}

/// Dispositivo nuevo: muestra el QR `multichat-link:<id>:<pub>` y espera el evento `link`.
struct LinkThisDeviceView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var ephemeral = X25519.generatePrivate()
    @State private var link: LinkCreated?
    @State private var text = ""
    @State private var error: String?
    @State private var done = false
    @State private var pollTask: Task<Void, Never>?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    if let error {
                        Text(error).foregroundStyle(.red).multilineTextAlignment(.center)
                        Button("Reintentar") { Task { await start() } }
                    } else if link == nil {
                        ProgressView("Preparando vínculo…")
                    } else {
                        Text("Escanea este código desde un dispositivo ya vinculado: Ajustes → Dispositivos → Vincular otro dispositivo.")
                            .multilineTextAlignment(.center)
                        if let img = QRCode.image(text) {
                            Image(uiImage: img)
                                .interpolation(.none)
                                .resizable()
                                .scaledToFit()
                                .frame(maxWidth: 260)
                                .padding()
                                .background(.white, in: RoundedRectangle(cornerRadius: 12))
                        }
                        CopyableText(label: "O copia este texto y pégalo en el otro dispositivo", value: text)
                            .padding()
                            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
                        HStack(spacing: 8) {
                            ProgressView()
                            Text("Esperando aprobación…").foregroundStyle(.secondary)
                        }
                        if let exp = link?.expiresAt {
                            Text("Caduca a las \(Fmt.date(exp).formatted(date: .omitted, time: .shortened))")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                }
                .padding()
            }
            .navigationTitle("Vincular dispositivo")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cerrar") { dismiss() } }
            }
        }
        .task { await start() }
        .onDisappear {
            pollTask?.cancel()
            model.onLinkEvent = nil
        }
    }

    private func start() async {
        error = nil
        link = nil
        ephemeral = X25519.generatePrivate()
        do {
            let pub = B64U.encode(try X25519.publicKey(fromPrivate: ephemeral))
            let l = try await model.createLink(ephemeralPublicKey: pub)
            link = l
            text = "multichat-link:\(l.id):\(pub)"
            let eph = ephemeral
            model.onLinkEvent = { id, sealed in
                guard id == l.id else { return }
                Task { await finish(sealed, eph) }
            }
            pollTask?.cancel()
            pollTask = Task {
                // Respaldo por si el evento del WebSocket no llega.
                while !Task.isCancelled && !done {
                    try? await Task.sleep(for: .seconds(3))
                    guard !Task.isCancelled, !done else { return }
                    if let info = try? await model.linkInfo(l.id) {
                        if info.status == "approved", let sk = info.sealedKey {
                            await finish(sk, eph)
                            return
                        } else if info.status == "expired" {
                            error = "El vínculo ha caducado."
                            return
                        }
                    }
                }
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func finish(_ sealed: String, _ eph: Data) async {
        guard !done else { return }
        done = true
        do {
            try await model.completeLink(sealedKey: sealed, ephemeralPrivate: eph)
            pollTask?.cancel()
            dismiss()
        } catch {
            done = false
            self.error = error.localizedDescription
        }
    }
}

enum QRCode {
    static func image(_ text: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let out = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 10, y: 10)),
              let cg = CIContext().createCGImage(out, from: out.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}
