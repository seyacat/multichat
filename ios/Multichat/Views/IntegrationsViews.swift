import SwiftUI

extension PlatformType {
    /// Campos de credenciales (protocol.md §4): clave, etiqueta, secreto.
    var credentialFields: [(key: String, label: String, secret: Bool)] {
        switch self {
        case .telegram: [("botToken", "Token del bot", true)]
        case .discord: [("botToken", "Token del bot", true)]
        case .whatsapp: [
            ("appId", "App ID", false),
            ("appSecret", "App Secret", true),
            ("accessToken", "Token de acceso", true),
            ("phoneNumberId", "Phone number ID", false),
            ("wabaId", "WhatsApp Business Account ID", false),
        ]
        }
    }

    var credentialHelp: String {
        switch self {
        case .telegram:
            "Abre @BotFather en Telegram, envía /newbot, elige nombre y usuario, y copia el token que te da (tiene la forma 123456789:ABC…)."
        case .discord:
            "En discord.com/developers/applications crea una aplicación. En «Bot» pulsa «Reset Token» y copia el token. Activa «Message Content Intent». Tras activar la integración tendrás aquí el enlace para invitar al bot a tu servidor."
        case .whatsapp:
            "En developers.facebook.com crea una app de tipo Business y añade el producto WhatsApp. App ID y App Secret están en Configuración → Básica. En WhatsApp → Configuración de la API están el Phone number ID y el WhatsApp Business Account ID. Usa un token de acceso permanente de un usuario del sistema (el temporal caduca en 24 h)."
        }
    }

    var defaultColor: Color { color }
}

func integrationStatusLabel(_ s: String) -> String {
    switch s {
    case "connected": "Conectada"
    case "connecting": "Conectando…"
    case "error": "Error"
    case "disabled": "En pausa"
    default: s
    }
}

func integrationStatusColor(_ s: String) -> Color {
    switch s {
    case "connected": .green
    case "connecting": .orange
    case "error": .red
    default: .gray
    }
}

struct IntegrationsView: View {
    @Environment(AppModel.self) private var model
    @State private var adding = false

    var body: some View {
        List {
            ForEach(model.integrations) { i in
                NavigationLink {
                    IntegrationDetailView(integrationId: i.id)
                } label: {
                    HStack(spacing: 12) {
                        PlatformBadge(type: i.type, size: 32)
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                Circle().fill(Color(hex: i.color)).frame(width: 8, height: 8)
                                Text(i.name).font(.headline)
                            }
                            Text(i.type.label + (i.credentialHint.map { " · \($0)" } ?? ""))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        HStack(spacing: 4) {
                            Circle().fill(integrationStatusColor(i.status)).frame(width: 8, height: 8)
                            Text(integrationStatusLabel(i.status)).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            if model.integrations.isEmpty {
                ContentUnavailableView("Sin integraciones", systemImage: "puzzlepiece.extension",
                                       description: Text("Añade un bot de Telegram o de Discord, o un número de WhatsApp Cloud API."))
            }
        }
        .navigationTitle("Integraciones")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { adding = true } label: { Image(systemName: "plus") }
                    .accessibilityLabel("Añadir integración")
            }
        }
        .refreshable { await model.sync() }
        .sheet(isPresented: $adding) { AddIntegrationView() }
    }
}

struct CredentialFieldsView: View {
    let type: PlatformType
    @Binding var values: [String: String]

    var body: some View {
        ForEach(type.credentialFields, id: \.key) { f in
            let binding = Binding(get: { values[f.key] ?? "" }, set: { values[f.key] = $0 })
            Group {
                if f.secret { SecureField(f.label, text: binding) } else { TextField(f.label, text: binding) }
            }
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
        }
    }
}

struct AddIntegrationView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var type: PlatformType?
    @State private var credentials: [String: String] = [:]
    @State private var testedInfo: [String: JSONValue]?
    @State private var name = ""
    @State private var color = Color.blue
    @State private var busy = false
    @State private var error: String?

    private var credentialsComplete: Bool {
        guard let type else { return false }
        return type.credentialFields.allSatisfy { !(credentials[$0.key] ?? "").trimmingCharacters(in: .whitespaces).isEmpty }
    }

    private var trimmedCredentials: [String: String] {
        credentials.mapValues { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
    }

    var body: some View {
        NavigationStack {
            Form {
                if let type {
                    Section {
                        CredentialFieldsView(type: type, values: $credentials)
                            .onChange(of: credentials) { _, _ in testedInfo = nil }
                    } header: {
                        Label(type.label, systemImage: type.symbol)
                    } footer: {
                        Text(type.credentialHelp)
                    }
                    if type == .whatsapp {
                        Section {
                            Label("En modo de pruebas, WhatsApp Cloud API solo deja escribir a un máximo de 5 números destinatarios verificados en tu app de Meta.",
                                  systemImage: "exclamationmark.triangle")
                                .font(.footnote)
                        }
                    }
                    Section {
                        Button {
                            Task { await test(type) }
                        } label: {
                            HStack { Text("Probar"); if busy && testedInfo == nil { Spacer(); ProgressView() } }
                        }
                        .disabled(!credentialsComplete || busy)
                    }
                    if let info = testedInfo {
                        Section("Datos de la plataforma") {
                            InfoRows(info: info)
                        }
                        Section("Cómo se verá") {
                            TextField("Nombre", text: $name)
                            ColorPicker("Color", selection: $color, supportsOpacity: false)
                        }
                        Section {
                            Button {
                                Task { await activate(type) }
                            } label: {
                                HStack { Text("Activar").bold(); if busy { Spacer(); ProgressView() } }
                            }
                            .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || busy)
                        }
                    }
                } else {
                    Section("Elige la plataforma") {
                        ForEach(PlatformType.allCases) { p in
                            Button {
                                type = p
                                color = p.defaultColor
                            } label: {
                                HStack(spacing: 12) {
                                    PlatformBadge(type: p, size: 30)
                                    Text(p.label).foregroundStyle(.primary)
                                }
                            }
                        }
                    }
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Añadir integración")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancelar") { dismiss() } }
                if type != nil && testedInfo == nil {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Atrás") { type = nil; credentials = [:]; error = nil }
                    }
                }
            }
        }
    }

    private func test(_ type: PlatformType) async {
        guard let api = model.api else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            let r = try await api.testIntegration(type: type, credentials: trimmedCredentials)
            testedInfo = r.info ?? [:]
            if name.isEmpty {
                let i = r.info ?? [:]
                name = i["verifiedName"]?.string ?? i["firstName"]?.string ?? i["username"]?.string ?? type.label
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func activate(_ type: PlatformType) async {
        busy = true
        error = nil
        defer { busy = false }
        let config: [String: JSONValue]? = type == .discord ? ["channelIds": .array([]), "allowDMs": .bool(true)] : nil
        do {
            _ = try await model.createIntegration(.init(type: type, name: name.trimmingCharacters(in: .whitespaces),
                                                         color: color.hexString, credentials: trimmedCredentials, config: config))
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct InfoRows: View {
    let info: [String: JSONValue]

    private static let labels: [String: String] = [
        "botId": "ID del bot", "username": "Usuario", "firstName": "Nombre",
        "displayPhoneNumber": "Número", "verifiedName": "Nombre verificado",
        "webhookRegistered": "Webhook registrado", "inviteUrl": "Invitación",
    ]

    var body: some View {
        ForEach(info.keys.sorted(), id: \.self) { k in
            if k != "inviteUrl" {
                let v = info[k]!
                LabeledContent(Self.labels[k] ?? k, value: v.bool.map { $0 ? "Sí" : "No" } ?? v.string ?? "—")
            }
        }
    }
}

struct IntegrationDetailView: View {
    let integrationId: String
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var color = Color.blue
    @State private var busy = false
    @State private var error: String?
    @State private var rotating = false
    @State private var confirmDelete = false

    var body: some View {
        if let i = model.integration(integrationId) {
            content(i)
        } else {
            ContentUnavailableView("Integración eliminada", systemImage: "puzzlepiece.extension")
        }
    }

    private func content(_ i: Integration) -> some View {
        Form {
            Section {
                HStack {
                    PlatformBadge(type: i.type, size: 28)
                    Text(i.type.label)
                    Spacer()
                    Circle().fill(integrationStatusColor(i.status)).frame(width: 10, height: 10)
                    Text(integrationStatusLabel(i.status)).foregroundStyle(.secondary)
                }
                if let d = i.statusDetail, !d.isEmpty {
                    Text(d).font(.footnote).foregroundStyle(i.status == "error" ? .red : .secondary)
                }
                Toggle("Activa", isOn: Binding(get: { i.enabled }, set: { v in
                    Task { await patch(.init(enabled: v)) }
                }))
            } footer: {
                Text("Al pausarla deja de recibir y enviar mensajes hasta que la reactives.")
            }

            Section("Nombre y color") {
                TextField("Nombre", text: $name)
                ColorPicker("Color", selection: $color, supportsOpacity: false)
                Button("Guardar") {
                    Task { await patch(.init(name: name.trimmingCharacters(in: .whitespaces), color: color.hexString)) }
                }
                .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || (name == i.name && color.hexString.lowercased() == i.color.lowercased()))
            }

            if let info = i.info, !info.isEmpty {
                Section("Datos de la plataforma") { InfoRows(info: info) }
            }

            if i.type == .discord { DiscordSection(integration: i) }
            if i.type == .whatsapp { whatsappSection(i) }

            Section {
                if let h = i.credentialHint { LabeledContent("Credencial actual", value: h) }
                Button("Cambiar token o credenciales") { rotating = true }
            } footer: {
                Text(i.type.credentialHelp)
            }

            if let error {
                Section { Text(error).foregroundStyle(.red) }
            }

            Section {
                Button("Eliminar integración", role: .destructive) { confirmDelete = true }
            }
        }
        .disabled(busy)
        .navigationTitle(i.name)
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            name = i.name
            color = Color(hex: i.color)
        }
        .sheet(isPresented: $rotating) { RotateCredentialsView(integration: i) }
        .confirmationDialog("¿Eliminar «\(i.name)»?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Eliminar", role: .destructive) {
                Task {
                    do {
                        try await model.deleteIntegration(i.id)
                        dismiss()
                    } catch {
                        self.error = error.localizedDescription
                    }
                }
            }
        } message: {
            Text("Se desconecta de la plataforma y se borran sus contactos y mensajes.")
        }
    }

    @ViewBuilder private func whatsappSection(_ i: Integration) -> some View {
        Section {
            Label("En modo de pruebas solo puedes escribir a un máximo de 5 números destinatarios verificados en tu app de Meta.",
                  systemImage: "exclamationmark.triangle")
                .font(.footnote)
        }
        if i.info?["webhookRegistered"]?.bool != true {
            Section {
                if let url = i.webhookUrl { CopyableText(label: "URL de devolución de llamada", value: url) }
                if let token = i.config?["verifyToken"]?.string { CopyableText(label: "Token de verificación", value: token) }
            } header: {
                Text("Webhook pendiente")
            } footer: {
                Text("No se pudo registrar el webhook automáticamente. En tu app de Meta: WhatsApp → Configuración → Webhook, pega esta URL y el token, y suscríbete al campo «messages».")
            }
        }
    }

    private func patch(_ body: APIClient.PatchIntegration) async {
        busy = true
        error = nil
        defer { busy = false }
        do { try await model.patchIntegration(integrationId, body) } catch { self.error = error.localizedDescription }
    }
}

struct DiscordSection: View {
    @Environment(AppModel.self) private var model
    let integration: Integration
    @State private var guilds: [DiscordChannels.Guild] = []
    @State private var selected: Set<String> = []
    @State private var loading = false
    @State private var error: String?
    @State private var dirty = false

    private var allowDMs: Bool { integration.config?["allowDMs"]?.bool ?? false }
    private var savedChannels: Set<String> { Set(integration.config?["channelIds"]?.stringArray ?? []) }

    var body: some View {
        Section {
            if let s = integration.info?["inviteUrl"]?.string, let url = URL(string: s) {
                Link(destination: url) { Label("Invitar el bot a un servidor", systemImage: "person.badge.plus") }
                CopyableText(label: "Enlace de invitación", value: s)
            }
            Toggle("Recibir mensajes directos (DMs)", isOn: Binding(get: { allowDMs }, set: { v in
                Task { await save(channels: savedChannels, dms: v) }
            }))
        } header: {
            Text("Discord")
        }

        Section {
            if loading {
                ProgressView()
            } else if guilds.isEmpty {
                Text(error ?? "El bot no ve ningún canal de texto. Invítalo a un servidor.").foregroundStyle(error == nil ? Color.secondary : Color.red)
            }
            ForEach(guilds) { g in
                DisclosureGroup(g.name) {
                    ForEach(g.channels) { ch in
                        Toggle("#\(ch.name)", isOn: Binding(get: { selected.contains(ch.id) }, set: { on in
                            if on { selected.insert(ch.id) } else { selected.remove(ch.id) }
                            dirty = selected != savedChannels
                        }))
                    }
                }
            }
            if dirty {
                Button("Guardar canales") { Task { await save(channels: selected, dms: allowDMs) } }
            }
            Button("Recargar canales") { Task { await load() } }
        } header: {
            Text("Canales")
        } footer: {
            Text("Cada canal activado aparece como un chat de grupo.")
        }
        .task { await load() }
    }

    private func load() async {
        guard let api = model.api else { return }
        loading = true
        defer { loading = false }
        do {
            guilds = try await api.discordChannels(integration.id).guilds
            selected = savedChannels
            dirty = false
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func save(channels: Set<String>, dms: Bool) async {
        do {
            try await model.patchIntegration(integration.id, .init(config: [
                "channelIds": .array(channels.sorted().map { .string($0) }),
                "allowDMs": .bool(dms),
            ]))
            dirty = false
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct RotateCredentialsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let integration: Integration
    @State private var values: [String: String] = [:]
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    CredentialFieldsView(type: integration.type, values: $values)
                } footer: {
                    Text("Escribe solo lo que cambia (por ejemplo, el token). Los campos vacíos se mantienen. Se validan con la plataforma y la integración se reinicia.")
                }
                if let error { Section { Text(error).foregroundStyle(.red) } }
            }
            .navigationTitle("Cambiar credenciales")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancelar") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if busy { ProgressView() } else {
                        Button("Guardar") { Task { await save() } }
                            .disabled(!integration.type.credentialFields.contains { !(values[$0.key] ?? "").trimmingCharacters(in: .whitespaces).isEmpty })
                    }
                }
            }
        }
    }

    private func save() async {
        busy = true
        defer { busy = false }
        do {
            let changed = values.mapValues { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.value.isEmpty }
            try await model.patchIntegration(integration.id, .init(credentials: changed))
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
