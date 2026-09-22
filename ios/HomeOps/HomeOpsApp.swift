import SwiftUI

/// Destinations reachable from a widget deep link.
public enum AppRoute: Hashable {
    case thermostat(deviceID: Int)

    /// Parses `homeops://thermostat/<smartrent device id>`.
    ///
    /// Addressed by device id rather than a room name, because SmartRent device
    /// names are whatever the property set them to and don't map onto any fixed
    /// set of rooms.
    static func parse(_ url: URL) -> AppRoute? {
        guard url.scheme == HomeOpsIdentifiers.urlScheme else { return nil }
        switch url.host() {
        case "thermostat":
            guard let raw = url.pathComponents.dropFirst().first,
                  let id = Int(raw) else { return nil }
            return .thermostat(deviceID: id)
        default:
            return nil
        }
    }
}

@main
struct HomeOpsApp: App {
    @State private var model = HomeViewModel()
    @State private var route: AppRoute?
    @State private var initialRoute: AppRoute?

    init() {
        #if DEBUG
        // Development convenience only: lets a simulator run be seeded from the
        // launch environment (SIMCTL_CHILD_* vars) so credentials never have to
        // be typed by hand. Compiled out of release builds entirely.
        let env = ProcessInfo.processInfo.environment
        let credentials = SmartRentCredentials()
        if let email = env["SMARTRENT_EMAIL"], !email.isEmpty {
            credentials.email = email
        }
        if let password = env["SMARTRENT_PASSWORD"], !password.isEmpty {
            credentials.password = password
        }
        if let route = env["HOMEOPS_SEED_ROUTE"],
           let url = URL(string: "\(HomeOpsIdentifiers.urlScheme)://\(route)"),
           let parsed = AppRoute.parse(url) {
            _initialRoute = State(initialValue: parsed)
        }
        #endif
    }

    var body: some Scene {
        WindowGroup {
            NavigationStack {
                DashboardView(model: model, route: $route)
            }
            // Applied outside the navigation stack: inside it, any pushed
            // screen draws over the toast layer.
            .toasts(model.toasts) { model.dismissToast($0) }
            .task {
                #if DEBUG
                // Lets a simulator run render a sample toast for visual checking.
                if let kind = ProcessInfo.processInfo.environment["HOMEOPS_SEED_TOAST"] {
                    switch kind {
                    case "success": model.show(.success("Door locked"))
                    case "error": model.show(.error("Can't reach SmartRent."))
                    default: model.show(.info("Locking the door…"))
                    }
                }
                #endif
            }
            .onOpenURL { url in
                if let parsed = AppRoute.parse(url) { route = parsed }
            }
            .task {
                if route == nil, let initialRoute { route = initialRoute }
            }
        }
    }
}
