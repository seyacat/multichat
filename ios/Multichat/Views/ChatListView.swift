import SwiftData
import SwiftUI

struct ChatListView: View {
    @Environment(AppModel.self) private var model
    @Query private var contacts: [CachedContact]
    @State private var path: [String] = []
    @State private var search = ""
    @State private var platformFilter: PlatformType?
    @State private var integrationFilter: String?

    private func matches(_ c: CachedContact) -> Bool {
        if let integrationFilter, c.integrationId != integrationFilter { return false }
        if let platformFilter, model.integration(c.integrationId)?.type != platformFilter { return false }
        let q = search.trimmingCharacters(in: .whitespaces)
        if !q.isEmpty {
            let hay = [c.displayName, c.profileName, c.username ?? "", c.phone ?? "", c.previewText ?? ""].joined(separator: " ")
            if !hay.localizedCaseInsensitiveContains(q) { return false }
        }
        return true
    }

    private var visible: [CachedContact] {
        contacts.filter { $0.status == "accepted" && matches($0) }.sorted { $0.sortDate > $1.sortDate }
    }

    private var archivedCount: Int { contacts.filter { $0.status == "archived" }.count }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if model.wsState != .connected {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text(model.wsState == .connecting ? "Conectando…" : "Sin conexión con el servidor. Reintentando…")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                if archivedCount > 0 && search.isEmpty {
                    NavigationLink {
                        ArchivedChatsView()
                    } label: {
                        Label("Archivados (\(archivedCount))", systemImage: "archivebox")
                    }
                }
                ForEach(visible) { c in
                    NavigationLink(value: c.id) { ChatRow(contact: c) }
                        .swipeActions(edge: .trailing) { ChatSwipeActions(contact: c) }
                }
                if visible.isEmpty {
                    ContentUnavailableView(
                        model.integrations.isEmpty ? "Sin integraciones" : "Sin chats",
                        systemImage: "bubble.left.and.bubble.right",
                        description: Text(model.integrations.isEmpty
                                          ? "Añade un bot de Telegram o Discord, o un número de WhatsApp en Ajustes → Integraciones."
                                          : "Cuando alguien escriba a tus bots aparecerá aquí.")
                    )
                    .listRowSeparator(.hidden)
                }
            }
            .listStyle(.plain)
            .searchable(text: $search, prompt: "Buscar")
            .refreshable { await model.sync() }
            .navigationTitle("Chats")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { filterMenu }
            }
            .safeAreaInset(edge: .top) {
                if platformFilter != nil || integrationFilter != nil { activeFilterBar }
            }
            .navigationDestination(for: String.self) { id in ChatView(contactId: id) }
        }
        .onChange(of: model.pendingOpenContactId) { _, id in openPending(id) }
        .onAppear { openPending(model.pendingOpenContactId) }
    }

    private func openPending(_ id: String?) {
        guard let id else { return }
        model.pendingOpenContactId = nil
        path = [id]
    }

    private var filterMenu: some View {
        Menu {
            Picker("Plataforma", selection: $platformFilter) {
                Text("Todas las plataformas").tag(PlatformType?.none)
                ForEach(PlatformType.allCases) { p in
                    Label(p.label, systemImage: p.symbol).tag(PlatformType?.some(p))
                }
            }
            if !model.integrations.isEmpty {
                Picker("Integración", selection: $integrationFilter) {
                    Text("Todas las integraciones").tag(String?.none)
                    ForEach(model.integrations) { i in
                        Text(i.name).tag(String?.some(i.id))
                    }
                }
            }
        } label: {
            Image(systemName: platformFilter == nil && integrationFilter == nil
                  ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
        }
        .accessibilityLabel("Filtrar")
    }

    private var activeFilterBar: some View {
        HStack {
            if let p = platformFilter { Label(p.label, systemImage: p.symbol).foregroundStyle(p.color) }
            if let id = integrationFilter, let i = model.integration(id) {
                Text(i.name).foregroundStyle(Color(hex: i.color))
            }
            Spacer()
            Button("Quitar filtro") {
                platformFilter = nil
                integrationFilter = nil
            }
        }
        .font(.footnote)
        .padding(.horizontal)
        .padding(.vertical, 6)
        .background(.bar)
    }
}

struct ChatSwipeActions: View {
    @Environment(AppModel.self) private var model
    let contact: CachedContact

    var body: some View {
        Button {
            Task { await model.setStatus(contact, contact.status == "archived" ? "accepted" : "archived") }
        } label: {
            if contact.status == "archived" {
                Label("Desarchivar", systemImage: "tray.and.arrow.up")
            } else {
                Label("Archivar", systemImage: "archivebox")
            }
        }
        .tint(.indigo)
        Button {
            let v = !contact.muted
            contact.muted = v
            Task { await model.patchContact(contact.id, .init(muted: v)) }
        } label: {
            Label(contact.muted ? "Activar sonido" : "Silenciar", systemImage: contact.muted ? "bell" : "bell.slash")
        }
        .tint(.orange)
    }
}

struct ChatRow: View {
    @Environment(AppModel.self) private var model
    let contact: CachedContact

    var body: some View {
        let integration = model.integration(contact.integrationId)
        HStack(spacing: 12) {
            AvatarView(name: contact.displayName, platform: integration?.type, isGroup: contact.kind == "group")
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(contact.displayName).font(.headline).lineLimit(1)
                    if contact.muted { Image(systemName: "bell.slash.fill").font(.caption2).foregroundStyle(.secondary) }
                    Spacer()
                    Text(Fmt.listTime(contact.previewAt ?? contact.lastMessageAt))
                        .font(.caption)
                        .foregroundStyle(contact.unread > 0 ? Color.accentColor : .secondary)
                }
                HStack(alignment: .center, spacing: 4) {
                    if let integration {
                        Circle().fill(Color(hex: integration.color)).frame(width: 7, height: 7)
                        Text(integration.name).font(.caption).foregroundStyle(Color(hex: integration.color)).lineLimit(1)
                    }
                    Spacer()
                }
                HStack(spacing: 4) {
                    if contact.previewOutgoing, let st = contact.previewStatus { StatusIcon(status: st).font(.caption) }
                    Text(contact.hidePreview ? "Vista previa oculta" : (contact.previewText ?? ""))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer()
                    if contact.unread > 0 {
                        Text("\(contact.unread)")
                            .font(.caption2.bold())
                            .foregroundStyle(.white)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Capsule().fill(contact.muted ? Color.gray : Color.accentColor))
                    }
                }
            }
        }
        .padding(.vertical, 2)
    }
}

struct ArchivedChatsView: View {
    @Query(filter: #Predicate<CachedContact> { $0.status == "archived" }) private var contacts: [CachedContact]

    var body: some View {
        List {
            ForEach(contacts.sorted { $0.sortDate > $1.sortDate }) { c in
                NavigationLink(value: c.id) { ChatRow(contact: c) }
                    .swipeActions(edge: .trailing) { ChatSwipeActions(contact: c) }
            }
            if contacts.isEmpty {
                ContentUnavailableView("Sin archivados", systemImage: "archivebox")
            }
        }
        .listStyle(.plain)
        .navigationTitle("Archivados")
    }
}

struct RequestsView: View {
    @Environment(AppModel.self) private var model
    @Query(filter: #Predicate<CachedContact> { $0.status == "pending" }) private var contacts: [CachedContact]

    var body: some View {
        NavigationStack {
            List {
                ForEach(contacts.sorted { $0.sortDate > $1.sortDate }) { c in
                    VStack(alignment: .leading, spacing: 10) {
                        NavigationLink(value: c.id) { ChatRow(contact: c) }
                        HStack {
                            Button {
                                Task { await model.setStatus(c, "accepted") }
                            } label: {
                                Label("Aceptar", systemImage: "checkmark").frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.borderedProminent)
                            Button(role: .destructive) {
                                Task { await model.setStatus(c, "blocked") }
                            } label: {
                                Label("Bloquear", systemImage: "hand.raised.fill").frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                    .padding(.vertical, 4)
                }
                if contacts.isEmpty {
                    ContentUnavailableView("Sin solicitudes", systemImage: "person.crop.circle.badge.checkmark",
                                           description: Text("Quien escriba por primera vez a uno de tus bots aparece aquí hasta que lo aceptes o lo bloquees."))
                }
            }
            .listStyle(.plain)
            .navigationTitle("Solicitudes")
            .navigationDestination(for: String.self) { id in ChatView(contactId: id) }
            .refreshable { await model.sync() }
        }
    }
}
