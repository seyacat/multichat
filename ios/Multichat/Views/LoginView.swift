import SwiftUI
import UIKit

struct LoginView: View {
    @Environment(AppModel.self) private var model
    @State private var register = false
    @State private var email = ""
    @State private var password = ""
    @State private var deviceName = UIDevice.current.name
    @State private var server = AppGroup.serverURL
    @State private var busy = false
    @State private var error: String?

    private var valid: Bool {
        email.contains("@") && password.count >= 8 && !deviceName.trimmingCharacters(in: .whitespaces).isEmpty
            && URL(string: server)?.scheme?.hasPrefix("http") == true
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(spacing: 8) {
                        Image(systemName: "bubble.left.and.bubble.right.fill")
                            .font(.system(size: 48))
                            .foregroundStyle(.tint)
                        Text("Multichat").font(.largeTitle.bold())
                        Text("Tus chats de Telegram, Discord y WhatsApp en una sola bandeja, cifrados para tus dispositivos.")
                            .font(.subheadline)
                            .multilineTextAlignment(.center)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
                }

                Picker("Modo", selection: $register) {
                    Text("Entrar").tag(false)
                    Text("Crear cuenta").tag(true)
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)

                Section("Cuenta") {
                    TextField("Correo electrónico", text: $email)
                        .keyboardType(.emailAddress)
                        .textContentType(.username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Contraseña (mínimo 8)", text: $password)
                        .textContentType(register ? .newPassword : .password)
                    TextField("Nombre del dispositivo", text: $deviceName)
                }

                Section {
                    TextField("URL del servidor", text: $server)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Servidor")
                } footer: {
                    Text("Dirección del proxy de Multichat. En desarrollo: \(AppGroup.defaultServerURL).")
                }

                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }

                Section {
                    Button {
                        Task { await submit() }
                    } label: {
                        HStack {
                            Spacer()
                            if busy { ProgressView() } else { Text(register ? "Crear cuenta" : "Entrar").bold() }
                            Spacer()
                        }
                    }
                    .disabled(!valid || busy)
                }
            }
            .navigationTitle(register ? "Crear cuenta" : "Entrar")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private func submit() async {
        busy = true
        error = nil
        defer { busy = false }
        var url = server.trimmingCharacters(in: .whitespacesAndNewlines)
        while url.hasSuffix("/") { url.removeLast() }
        model.serverURL = url
        do {
            try await model.authenticate(register: register, email: email.trimmingCharacters(in: .whitespaces),
                                         password: password, deviceName: deviceName.trimmingCharacters(in: .whitespaces))
        } catch {
            self.error = error.localizedDescription
        }
    }
}
