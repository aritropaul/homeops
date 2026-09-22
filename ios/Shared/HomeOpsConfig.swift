import Foundation

/// Identifiers shared by the app and the widget extension.
///
/// The keychain access group is written out in full rather than using
/// `$(AppIdentifierPrefix)`: that variable is substituted only inside
/// `.entitlements` files at codesign time, never in compiled Swift, so the
/// literal here must match the entitlements string exactly.
public enum HomeOpsIdentifiers {
    public static let appGroup = "group.dev.aritro.homeops"
    public static let keychainAccessGroup = "2J3WW2KWBU.dev.aritro.homeops.shared"
    public static let keychainService = "dev.aritro.homeops"

    /// Widget/control kinds, used for targeted reloads.
    public enum WidgetKind {
        public static let lock = "LockWidget"
        public static let climate = "ClimateWidget"
        public static let overview = "OverviewWidget"
    }

    public enum ControlKind {
        public static let lock = "dev.aritro.homeops.control.lock"
        public static let thermostat = "dev.aritro.homeops.control.thermostat"
    }

    /// Deep links the widgets use to open a specific screen.
    public static let urlScheme = "homeops"
}

/// The three thermostats the server exposes, keyed by the names its
