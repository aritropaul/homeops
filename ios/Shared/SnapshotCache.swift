import Foundation

/// Last-known `/status`, shared between the app and the widget extension via the
/// App Group container.
///
/// Widgets render from this immediately and only then attempt a bounded network
/// refresh, so a widget never shows an empty frame while waiting on the network,
/// and a failed refresh degrades to "stale but labelled" rather than blank.
public struct SnapshotCache: Sendable {
    private static let key = "cachedSnapshot"
    private let suiteName: String

    public init(suiteName: String = HomeOpsIdentifiers.appGroup) {
        self.suiteName = suiteName
    }

    private var defaults: UserDefaults? { UserDefaults(suiteName: suiteName) }

    public func load() -> Snapshot? {
        guard let data = defaults?.data(forKey: Self.key) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try? decoder.decode(Snapshot.self, from: data)
    }

    public func save(_ snapshot: Snapshot) {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(snapshot) else { return }
        defaults?.set(data, forKey: Self.key)
    }

    public func clear() {
        defaults?.removeObject(forKey: Self.key)
    }
}
