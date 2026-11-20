import SwiftData
import SwiftUI
import UIKit
import UserNotifications

@main
struct MultichatApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase
    @State private var model = AppModel.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .modelContainer(model.container)
                .modelErrorAlert()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { model.didBecomeActive() }
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        AppModel.shared.didRegisterPushToken(deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // En el simulador sin firma no hay token: no es un error para el usuario.
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        let thread = notification.request.content.threadIdentifier
        let open = await MainActor.run { AppModel.shared.openContactId }
        return open == thread ? [] : [.banner, .sound, .list]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        let mc = info["mc"] as? [String: Any]
        let contactId = (mc?["contactId"] as? String) ?? response.notification.request.content.threadIdentifier
        guard !contactId.isEmpty else { return }
        await MainActor.run { AppModel.shared.pendingOpenContactId = contactId }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        switch model.phase {
        case .loggedOut: LoginView()
        case .needsKey: KeySetupView()
        case .ready: MainTabView()
        }
    }
}

struct MainTabView: View {
    @Environment(AppModel.self) private var model
    @Query(filter: #Predicate<CachedContact> { $0.status == "pending" }) private var pending: [CachedContact]

    var body: some View {
        TabView {
            ChatListView()
                .tabItem { Label("Chats", systemImage: "bubble.left.and.bubble.right.fill") }
            RequestsView()
                .tabItem { Label("Solicitudes", systemImage: "person.crop.circle.badge.questionmark") }
                .badge(pending.count)
            SettingsView()
                .tabItem { Label("Ajustes", systemImage: "gearshape") }
        }
    }
}
