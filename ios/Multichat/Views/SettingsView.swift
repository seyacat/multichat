import AVFoundation
import SwiftData
import SwiftUI
import UserNotifications

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var confirmLogout = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    NavigationLink { IntegrationsView() } label: {
                        Label("Integraciones", systemImage: "puzzlepiece.extension")
                            .badge(model.integrations.filter { $0.status == "error" }.count)
                    }
                    NavigationLink { DevicesView() } label: { Label("Dispositivos", systemImage: "iphone.and.ipad") }
                    NavigationLink { RecoveryKeyView() } label: { Label("Clave de recuperación", systemImage: "key") }
                    NavigationLink { NotificationsView() } label: { Label("Notificaciones", systemImage: "bell.badge") }
                    NavigationLink { BlockedContactsView() } label: { Label("Bloqueados", systemImage: "hand.raised") }
                }
                Section("Cuenta") {
                    LabeledContent("Correo", value: model.session?.user.email ?? "—")
                    LabeledContent("Dispositivo", value: model.session?.device.name ?? "—")
                    LabeledContent("Servidor", value: model.serverURL)
                    LabeledContent("Tiempo real", value: model.wsState == .connected ? "Conectado" : (model.wsState == .connecting ? "Conectando…" : "Desconectado"))
                }
                Section {
                    Button("Cerrar sesión", role: .destructive) { confirmLogout = true }
                }
            }
            .navigationTitle("Ajustes")
            .confirmationDialog("¿Cerrar sesión en este dispositivo?", isPresented: $confirmLogout, titleVisibility: .visible) {
                Button("Cerrar sesión", role: .destructive) { Task { await model.logout() } }
            } message: {
                Text("Se borran de este iPhone la clave de cuenta y los mensajes guardados. Para volver a leerlos tendrás que vincularlo otra vez o importar la clave de recuperación.")
            }
        }
    }
}

struct BlockedContactsView: View {
    @Environment(AppModel.self) private var model
    @Query(filter: #Predicate<CachedContact> { $0.status == "blocked" }) private var contacts: [CachedContact]

    var body: some View {
        List {
            ForEach(contacts) { c in
                HStack {
                    AvatarView(name: c.displayName, platform: model.integration(c.integrationId)?.type, size: 36)
                    Text(c.displayName)
                    Spacer()
                    Button("Desbloquear") { Task { await model.setStatus(c, "accepted") } }
                        .buttonStyle(.bordered)
                }
            }
            if contacts.isEmpty { ContentUnavailableView("Nadie bloqueado", systemImage: "hand.raised") }
        }
        .navigationTitle("Bloqueados")
    }
}

struct RecoveryKeyView: View {
    @Environment(AppModel.self) private var model
    @State private var revealed = false

    var body: some View {
        Form {
            Section {
                Label("Quien tenga esta clave puede leer todos tus mensajes. No la compartas ni la guardes en un sitio inseguro. El servidor no la conoce: si pierdes todos tus dispositivos y esta clave, no hay forma de recuperar los mensajes.",
                      systemImage: "exclamationmark.shield.fill")
                    .foregroundStyle(.orange)
            }
            Section {
                if revealed, let key = model.recoveryKeyText {
                    CopyableText(label: "Clave de recuperación", value: key)
                } else {
                    Button("Mostrar clave") { revealed = true }
                }
            } footer: {
                Text("En un dispositivo nuevo, tras entrar, elige «Importar clave» y pega este texto.")
            }
        }
        .navigationTitle("Clave de recuperación")
        .onDisappear { revealed = false }
    }
}

struct NotificationsView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Form {
            Section {
                LabeledContent("Permiso", value: label(model.notificationStatus))
                switch model.notificationStatus {
                case .notDetermined:
                    Button("Activar notificaciones") { Task { await model.requestNotifications() } }
                case .denied:
                    Button("Abrir Ajustes del sistema") {
                        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                    }
                default:
                    Button("Volver a registrar este dispositivo") { Task { await model.refreshNotificationStatus() } }
                    Button("Desactivar avisos en este dispositivo", role: .destructive) { Task { await model.disablePush() } }
                }
            } footer: {
                Text("Los avisos llegan cifrados y se descifran en el propio iPhone. Solo se envían cuando la app no está conectada. Los chats silenciados no avisan.")
            }
        }
        .navigationTitle("Notificaciones")
        .task { await model.refreshNotificationStatus() }
    }

    private func label(_ s: UNAuthorizationStatus) -> String {
        switch s {
        case .authorized: "Permitidas"
        case .denied: "Denegadas"
        case .provisional: "Provisionales"
        case .ephemeral: "Temporales"
        default: "Sin decidir"
        }
    }
}

struct DevicesView: View {
    @Environment(AppModel.self) private var model
    @State private var devices: [APIDevice] = []
    @State private var error: String?
    @State private var linking = false
    @State private var revoke: APIDevice?

    var body: some View {
        List {
            Section {
                Button { linking = true } label: { Label("Vincular otro dispositivo", systemImage: "qrcode.viewfinder") }
            } footer: {
                Text("Escanea el código que muestra el dispositivo nuevo, o pega su texto multichat-link:…")
            }
            Section("Dispositivos de la cuenta") {
                ForEach(devices) { d in
                    HStack {
                        Image(systemName: d.platform == "ios" ? "iphone" : "globe")
                        VStack(alignment: .leading) {
                            HStack {
                                Text(d.name)
                                if d.id == model.session?.device.id { Text("(este)").foregroundStyle(.secondary) }
                            }
                            Text(detail(d)).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .swipeActions {
                        Button("Revocar", role: .destructive) { revoke = d }
                    }
                }
            }
            if let error { Section { Text(error).foregroundStyle(.red) } }
        }
        .navigationTitle("Dispositivos")
        .task { await load() }
        .refreshable { await load() }
        .sheet(isPresented: $linking, onDismiss: { Task { await load() } }) { ApproveLinkView() }
        .confirmationDialog("¿Revocar «\(revoke?.name ?? "")»?", isPresented: Binding(get: { revoke != nil }, set: { if !$0 { revoke = nil } }),
                            titleVisibility: .visible) {
            Button("Revocar", role: .destructive) {
                guard let d = revoke else { return }
                Task {
                    do {
                        try await model.revokeDevice(d.id)
                        await load()
                    } catch {
                        self.error = error.localizedDescription
                    }
                }
            }
        } message: {
            Text("Ese dispositivo pierde la sesión. Si guardó la clave de cuenta, la conserva hasta que se borre la app.")
        }
    }

    private func detail(_ d: APIDevice) -> String {
        var parts = [d.platform == "ios" ? "iOS" : "Web"]
        if let s = d.lastSeenAt { parts.append("visto " + Fmt.date(s).formatted(.relative(presentation: .named))) }
        if d.push != nil { parts.append("avisos activos") }
        return parts.joined(separator: " · ")
    }

    private func load() async {
        do {
            devices = try await model.me().devices
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// Dispositivo ya vinculado: escanea o pega `multichat-link:<id>:<pub>` y aprueba.
struct ApproveLinkView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var pasted = ""
    @State private var info: LinkInfo?
    @State private var error: String?
    @State private var busy = false
    @State private var approved = false
    @State private var cameraAllowed = AVCaptureDevice.authorizationStatus(for: .video) != .denied

    var body: some View {
        NavigationStack {
            Form {
                if approved {
                    Section {
                        Label("Dispositivo vinculado", systemImage: "checkmark.seal.fill").foregroundStyle(.green)
                    }
                } else if let info {
                    Section {
                        Text("¿Dar acceso a tus mensajes a «\(info.deviceName ?? "dispositivo sin nombre")» (\(info.platform == "ios" ? "iOS" : "Web"))?")
                        Text("Solo apruébalo si es un dispositivo tuyo y lo tienes delante.").font(.footnote).foregroundStyle(.secondary)
                        Button("Aprobar") { Task { await approve(info) } }.disabled(busy)
                        Button("Cancelar", role: .cancel) { self.info = nil }
                    }
                } else {
                    if cameraAllowed {
                        Section("Escanear código") {
                            QRScannerView { code in Task { await handle(code) } }
                                .frame(height: 280)
                                .listRowInsets(EdgeInsets())
                        }
                    }
                    Section("O pega el texto") {
                        TextField("multichat-link:…", text: $pasted, axis: .vertical)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .font(.system(.footnote, design: .monospaced))
                        Button("Pegar") { pasted = UIPasteboard.general.string ?? "" }
                        Button("Continuar") { Task { await handle(pasted) } }.disabled(pasted.isEmpty || busy)
                    }
                }
                if let error { Section { Text(error).foregroundStyle(.red) } }
            }
            .navigationTitle("Vincular dispositivo")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(approved ? "Hecho" : "Cerrar") { dismiss() } }
            }
            .task {
                if AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined {
                    cameraAllowed = await AVCaptureDevice.requestAccess(for: .video)
                }
            }
        }
    }

    private func handle(_ text: String) async {
        guard !busy, info == nil else { return }
        guard let parsed = AppModel.parseLinkText(text) else {
            error = "El código no es un vínculo de Multichat válido."
            return
        }
        busy = true
        defer { busy = false }
        do {
            let i = try await model.linkInfo(parsed.id)
            guard i.ephemeralPublicKey == parsed.pub else {
                error = "La clave del vínculo no coincide con la del código. Se ha cancelado por seguridad."
                return
            }
            guard i.status == "pending" else {
                error = i.status == "expired" ? "El vínculo ha caducado. Genera uno nuevo." : "Este vínculo ya se aprobó."
                return
            }
            error = nil
            info = i
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func approve(_ i: LinkInfo) async {
        busy = true
        defer { busy = false }
        do {
            try await model.approveLink(id: i.id, ephemeralPublicKey: i.ephemeralPublicKey)
            approved = true
        } catch {
            self.error = error.localizedDescription
        }
    }
}
