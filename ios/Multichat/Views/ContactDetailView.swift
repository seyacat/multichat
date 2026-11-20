import SwiftData
import SwiftUI

struct ContactDetailView: View {
    let contactId: String
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Query private var rows: [CachedContact]
    @State private var alias = ""
    @State private var confirmDelete = false
    @State private var confirmBlock = false

    init(contactId: String) {
        self.contactId = contactId
        _rows = Query(filter: #Predicate<CachedContact> { $0.id == contactId })
    }

    var body: some View {
        if let c = rows.first {
            form(c)
        } else {
            ContentUnavailableView("Contacto eliminado", systemImage: "person.crop.circle.badge.xmark")
        }
    }

    private func form(_ c: CachedContact) -> some View {
        let integration = model.integration(c.integrationId)
        return Form {
            Section {
                VStack(spacing: 8) {
                    AvatarView(name: c.displayName, platform: integration?.type, isGroup: c.kind == "group", size: 84)
                    Text(c.displayName).font(.title2.bold())
                    if let integration {
                        Label(integration.name, systemImage: integration.type.symbol)
                            .font(.subheadline)
                            .foregroundStyle(Color(hex: integration.color))
                    }
                }
                .frame(maxWidth: .infinity)
                .listRowBackground(Color.clear)
            }

            Section("Perfil") {
                LabeledContent("Nombre", value: c.profileName.isEmpty ? "—" : c.profileName)
                if let u = c.username, !u.isEmpty { LabeledContent("Usuario", value: "@\(u)") }
                if let p = c.phone, !p.isEmpty { LabeledContent("Teléfono", value: p) }
                LabeledContent("Tipo", value: c.kind == "group" ? "Grupo / canal" : "Directo")
                LabeledContent("Estado", value: statusLabel(c.status))
            }

            Section {
                TextField("Alias (solo lo ves tú)", text: $alias)
                Button("Guardar alias") {
                    Task { await model.setAlias(c, alias) }
                }
                .disabled(alias == (c.aliasName ?? ""))
            } header: {
                Text("Alias")
            } footer: {
                Text("El alias se cifra con la clave de tu cuenta. Déjalo vacío para usar el nombre del perfil.")
            }

            Section {
                Toggle("Silenciar", isOn: Binding(get: { c.muted }, set: { v in
                    c.muted = v
                    Task { await model.patchContact(c.id, .init(muted: v)) }
                }))
                Toggle("Ocultar vista previa", isOn: Binding(get: { c.hidePreview }, set: { v in
                    c.hidePreview = v
                    Task { await model.patchContact(c.id, .init(hidePreview: v)) }
                }))
            } footer: {
                Text("Con la vista previa oculta, las notificaciones y la lista de chats no muestran el contenido.")
            }

            Section {
                if c.status == "archived" {
                    Button("Desarchivar") { Task { await model.setStatus(c, "accepted") } }
                } else if c.status == "accepted" {
                    Button("Archivar") { Task { await model.setStatus(c, "archived") } }
                } else if c.status == "pending" {
                    Button("Aceptar solicitud") { Task { await model.setStatus(c, "accepted") } }
                }
                if c.status == "blocked" {
                    Button("Desbloquear") { Task { await model.setStatus(c, "accepted") } }
                } else {
                    Button("Bloquear", role: .destructive) { confirmBlock = true }
                }
                Button("Borrar chat e historial", role: .destructive) { confirmDelete = true }
            }
        }
        .navigationTitle("Contacto")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { alias = c.aliasName ?? "" }
        .confirmationDialog("¿Bloquear a \(c.displayName)?", isPresented: $confirmBlock, titleVisibility: .visible) {
            Button("Bloquear", role: .destructive) { Task { await model.setStatus(c, "blocked") } }
        } message: {
            Text("Se descartará todo lo que envíe.")
        }
        .confirmationDialog("¿Borrar el chat y todo su historial?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Borrar", role: .destructive) {
                Task {
                    await model.deleteContact(c)
                    dismiss()
                }
            }
        } message: {
            Text("Se borra el contacto y sus mensajes en el servidor y en todos tus dispositivos. Si vuelve a escribir, aparecerá como solicitud nueva.")
        }
    }

    private func statusLabel(_ s: String) -> String {
        switch s {
        case "pending": "Solicitud pendiente"
        case "accepted": "Aceptado"
        case "blocked": "Bloqueado"
        case "archived": "Archivado"
        default: s
        }
    }
}
