import Foundation

/// A transient result of something the user just did.
///
/// Deliberately distinct from the inline banners on the dashboard: a toast
/// reports an *event* ("Locking…", "Couldn't reach SmartRent") and leaves. A
/// persistent *condition* — not signed in, readings are stale — stays inline
/// where it can be read at leisure, because a message that disappears is the
/// wrong way to communicate a state that hasn't gone away.
public struct Toast: Identifiable, Equatable, Sendable {
    public enum Kind: Sendable, Equatable {
        case success
        case info
        case error

        /// Errors stay until dismissed; everything else leaves on its own.
        public var autoDismissAfter: Duration? {
            switch self {
            case .success: .seconds(2.5)
            case .info: .seconds(3)
            case .error: nil
            }
        }

        public var symbolName: String {
            switch self {
            case .success: "checkmark.circle.fill"
            case .info: "info.circle.fill"
            case .error: "exclamationmark.triangle.fill"
            }
        }
    }

    public let id = UUID()
    public let kind: Kind
    public let message: String

    public init(kind: Kind, message: String) {
        self.kind = kind
        self.message = message
    }

    public static func success(_ message: String) -> Toast { Toast(kind: .success, message: message) }
    public static func info(_ message: String) -> Toast { Toast(kind: .info, message: message) }
    public static func error(_ message: String) -> Toast { Toast(kind: .error, message: message) }
}
