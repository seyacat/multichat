import SwiftUI
import UIKit

extension PlatformType {
    var label: String {
        switch self {
        case .telegram: "Telegram"
        case .discord: "Discord"
        case .whatsapp: "WhatsApp"
        }
    }

    /// Icono propio (SF Symbol), no el logo oficial.
    var symbol: String {
        switch self {
        case .telegram: "paperplane.fill"
        case .discord: "gamecontroller.fill"
        case .whatsapp: "phone.fill"
        }
    }

    var color: Color {
        switch self {
        case .telegram: Color(hex: "#229ED9")
        case .discord: Color(hex: "#5865F2")
        case .whatsapp: Color(hex: "#25D366")
        }
    }
}

extension Color {
    init(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("#") { s.removeFirst() }
        if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
        let v = UInt64(s, radix: 16) ?? 0x888888
        self.init(red: Double((v >> 16) & 0xff) / 255, green: Double((v >> 8) & 0xff) / 255, blue: Double(v & 0xff) / 255)
    }

    var hexString: String {
        let c = UIColor(self)
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        c.getRed(&r, green: &g, blue: &b, alpha: &a)
        func clamp(_ x: CGFloat) -> Int { max(0, min(255, Int((x * 255).rounded()))) }
        return String(format: "#%02x%02x%02x", clamp(r), clamp(g), clamp(b))
    }
}

/// Insignia pequeña de plataforma (círculo con el color de la plataforma).
struct PlatformBadge: View {
    let type: PlatformType
    var size: CGFloat = 18

    var body: some View {
        Image(systemName: type.symbol)
            .font(.system(size: size * 0.5, weight: .bold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(Circle().fill(type.color))
            .overlay(Circle().stroke(Color(.systemBackground), lineWidth: 2))
            .accessibilityLabel(type.label)
    }
}

/// Avatar con iniciales y la plataforma en la esquina.
struct AvatarView: View {
    let name: String
    let platform: PlatformType?
    var isGroup = false
    var size: CGFloat = 50

    static func initials(_ name: String) -> String {
        let words = name.split(whereSeparator: { $0.isWhitespace }).prefix(2)
        let s = words.compactMap { $0.first }.map { String($0) }.joined().uppercased()
        return s.isEmpty ? "?" : s
    }

    private var tint: Color {
        let palette: [Color] = [.blue, .purple, .orange, .pink, .teal, .indigo, .green, .red, .brown, .cyan]
        var h: UInt32 = 5381
        for b in name.utf8 { h = (h &* 33) &+ UInt32(b) }
        return palette[Int(h % UInt32(palette.count))]
    }

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            Circle()
                .fill(tint.gradient)
                .frame(width: size, height: size)
                .overlay {
                    if isGroup {
                        Image(systemName: "person.3.fill").font(.system(size: size * 0.32)).foregroundStyle(.white)
                    } else {
                        Text(Self.initials(name)).font(.system(size: size * 0.38, weight: .semibold)).foregroundStyle(.white)
                    }
                }
            if let platform {
                PlatformBadge(type: platform, size: size * 0.38)
                    .offset(x: 2, y: 2)
            }
        }
    }
}

struct StatusIcon: View {
    let status: String

    var body: some View {
        switch status {
        case "pending": Image(systemName: "clock").foregroundStyle(.secondary)
        case "sent": Image(systemName: "checkmark").foregroundStyle(.secondary)
        case "delivered": Image(systemName: "checkmark.circle").foregroundStyle(.secondary)
        case "read": Image(systemName: "checkmark.circle.fill").foregroundStyle(.blue)
        case "failed": Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.red)
        default: EmptyView()
        }
    }
}

enum Fmt {
    static func date(_ ms: Double) -> Date { Date(timeIntervalSince1970: ms / 1000) }

    static func listTime(_ ms: Double?) -> String {
        guard let ms, ms > 0 else { return "" }
        let d = date(ms)
        let cal = Calendar.current
        if cal.isDateInToday(d) { return d.formatted(date: .omitted, time: .shortened) }
        if cal.isDateInYesterday(d) { return "Ayer" }
        if let days = cal.dateComponents([.day], from: d, to: Date()).day, days < 7 {
            return d.formatted(.dateTime.weekday(.wide)).capitalized
        }
        return d.formatted(date: .numeric, time: .omitted)
    }

    static func daySeparator(_ d: Date) -> String {
        let cal = Calendar.current
        if cal.isDateInToday(d) { return "Hoy" }
        if cal.isDateInYesterday(d) { return "Ayer" }
        return d.formatted(.dateTime.weekday(.wide).day().month(.wide).year()).capitalized
    }

    static func bytes(_ n: Int?) -> String {
        guard let n else { return "" }
        return ByteCountFormatter.string(fromByteCount: Int64(n), countStyle: .file)
    }
}

/// Muestra `AppModel.lastError` como alerta.
struct ErrorAlert: ViewModifier {
    @Environment(AppModel.self) private var model

    func body(content: Content) -> some View {
        content.alert("Error", isPresented: Binding(
            get: { model.lastError != nil },
            set: { if !$0 { model.lastError = nil } }
        )) {
            Button("Aceptar", role: .cancel) {}
        } message: {
            Text(model.lastError ?? "")
        }
    }
}

extension View {
    func modelErrorAlert() -> some View { modifier(ErrorAlert()) }
}

struct CopyableText: View {
    let label: String
    let value: String
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            HStack {
                Text(value).font(.system(.footnote, design: .monospaced)).textSelection(.enabled).lineLimit(3)
                Spacer()
                Button {
                    UIPasteboard.general.string = value
                    copied = true
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Copiar")
            }
        }
    }
}
