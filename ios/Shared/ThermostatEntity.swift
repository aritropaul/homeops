import AppIntents
import Foundation

/// A thermostat as a Siri/Shortcuts parameter.
///
/// This is an `AppEntity` backed by a live query rather than a fixed enum of
/// rooms, because SmartRent device names are set by the property and don't map
/// onto any list we can hardcode — one of them here is literally called
/// "Sophia's controls". Querying the hub means Siri works with whatever the
/// devices are actually called, and keeps working if they're renamed.
struct ThermostatEntity: AppEntity, Identifiable, Hashable {
    let id: Int
    let name: String

    static var typeDisplayRepresentation: TypeDisplayRepresentation {
        TypeDisplayRepresentation(name: "Thermostat")
    }

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)")
    }

    static let defaultQuery = ThermostatEntityQuery()
}

struct ThermostatEntityQuery: EntityQuery {
    /// Reads the shared cache first so Shortcuts stays responsive, and only
    /// hits the network when there's nothing cached yet.
    private func entries() async -> [ThermostatEntry] {
        if let cached = SnapshotCache().load(), !cached.thermostats.isEmpty {
            return cached.thermostats
        }
        guard SmartRentCredentials().isConfigured,
              let snapshot = try? await withDeadline(seconds: 8, {
                  try await SmartRentClient().snapshot()
              }) else { return [] }
        SnapshotCache().save(snapshot)
        return snapshot.thermostats
    }

    func entities(for identifiers: [Int]) async throws -> [ThermostatEntity] {
        await entries()
            .filter { identifiers.contains($0.deviceID) }
            .map { ThermostatEntity(id: $0.deviceID, name: $0.name) }
    }

    func suggestedEntities() async throws -> [ThermostatEntity] {
        await entries().map { ThermostatEntity(id: $0.deviceID, name: $0.name) }
    }

    func defaultResult() async -> ThermostatEntity? {
        try? await suggestedEntities().first
    }
}
