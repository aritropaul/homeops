import AppIntents
import Foundation
import WidgetKit

/// Errors thrown from an intent. Conforming to
/// `CustomLocalizedStringResourceConvertible` is what makes Siri speak a real
/// sentence instead of a generic "something went wrong".
struct IntentFailure: Error, CustomLocalizedStringResourceConvertible {
    let message: String
    var localizedStringResource: LocalizedStringResource { "\(message)" }
}

enum IntentRunner {
    static func snapshot() async throws -> Snapshot {
        guard SmartRentCredentials().isConfigured else {
            throw IntentFailure(message: "Sign in to SmartRent in HomeOps first.")
        }
        do {
            let snapshot = try await withDeadline(seconds: 10) {
                try await SmartRentClient().snapshot()
            }
            SnapshotCache().save(snapshot)
            return snapshot
        } catch let error as SmartRentError {
            throw IntentFailure(message: error.localizedDescription)
        }
    }

    static func reloadSurfaces() {
        WidgetCenter.shared.reloadAllTimelines()
        ControlCenter.shared.reloadAllControls()
    }

    /// Runs a write, then refreshes the shared cache so every surface updates.
    static func write(_ body: @escaping @Sendable (SmartRentClient) async throws -> Void) async throws {
        guard SmartRentCredentials().isConfigured else {
            throw IntentFailure(message: "Sign in to SmartRent in HomeOps first.")
        }
        let client = SmartRentClient()
        do {
            try await withDeadline(seconds: 12) { try await body(client) }
            if let fresh = try? await withDeadline(seconds: 8, { try await client.snapshot() }) {
                SnapshotCache().save(fresh)
            }
            reloadSurfaces()
        } catch let error as SmartRentError {
            throw IntentFailure(message: error.localizedDescription)
        }
    }

    static func lockDevice(in snapshot: Snapshot) throws -> LockEntry {
        guard let lock = snapshot.lock else {
            throw IntentFailure(message: "No lock found on your SmartRent hub.")
        }
        return lock
    }

    static func thermostat(_ entity: ThermostatEntity, in snapshot: Snapshot) throws -> ThermostatEntry {
        guard let entry = snapshot.thermostat(id: entity.id) else {
            throw IntentFailure(message: "\(entity.name) isn't on your hub any more.")
        }
        return entry
    }
}

// MARK: - Lock

/// Locking is the fail-secure direction, so it runs headlessly with no gate.
struct LockDoorIntent: AppIntent {
    static let title: LocalizedStringResource = "Lock the Door"
    static let description = IntentDescription("Locks the front door.")
    static let supportedModes: IntentModes = .background

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let snapshot = try await IntentRunner.snapshot()
        let lock = try IntentRunner.lockDevice(in: snapshot)
        try await IntentRunner.write { try await $0.setLocked(true, deviceID: lock.deviceID) }
        return .result(dialog: IntentDialog("Locking the front door."))
    }
}

/// Unlocking opens the door, so it must be authenticated.
///
/// Biometrics cannot run in a background extension process, so this intent
/// deliberately launches the app, where Face ID gates the action. Never make
/// this `.background` — that would let a widget or Siri open the door with no
/// proof of who is asking.
struct UnlockDoorIntent: AppIntent {
    static let title: LocalizedStringResource = "Unlock the Door"
    static let description = IntentDescription(
        "Opens HomeOps to unlock the front door after Face ID."
    )
    static let supportedModes: IntentModes = .foreground(.immediate)

    @MainActor
    func perform() async throws -> some IntentResult { .result() }
}

/// Backs the Control Center lock toggle.
///
/// Turning it ON (locking) performs the action directly. Turning it OFF
/// (unlocking) hands off to the app so Face ID can run.
struct SetLockIntent: SetValueIntent {
    static let title: LocalizedStringResource = "Set Door Lock"
    static let supportedModes: IntentModes = .foreground(.dynamic)

    @Parameter(title: "Locked")
    var value: Bool

    func perform() async throws -> some IntentResult {
        guard value else {
            throw IntentFailure(message: "Open HomeOps to unlock — unlocking needs Face ID.")
        }
        let snapshot = try await IntentRunner.snapshot()
        let lock = try IntentRunner.lockDevice(in: snapshot)
        try await IntentRunner.write { try await $0.setLocked(true, deviceID: lock.deviceID) }
        return .result()
    }
}

// MARK: - Climate

struct SetTemperatureIntent: AppIntent {
    static let title: LocalizedStringResource = "Set Temperature"
    static let description = IntentDescription("Sets a room's target temperature.")
    static let supportedModes: IntentModes = .background

    @Parameter(title: "Thermostat")
    var thermostat: ThermostatEntity

    @Parameter(title: "Temperature", default: 70, inclusiveRange: (50, 85))
    var temperature: Int

    static var parameterSummary: some ParameterSummary {
        Summary("Set \(\.$thermostat) to \(\.$temperature) degrees")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let snapshot = try await IntentRunner.snapshot()
        let entry = try IntentRunner.thermostat(thermostat, in: snapshot)
        let mode = entry.device.mode
        let writeMode: ThermostatMode = (mode == .off || mode == .unknown) ? .cool : mode
        try await IntentRunner.write {
            try await $0.setThermostatTarget(temperature, mode: writeMode, deviceID: entry.deviceID)
        }
        return .result(dialog: IntentDialog("\(entry.name) set to \(temperature) degrees."))
    }
}

struct TurnOffThermostatIntent: AppIntent {
    static let title: LocalizedStringResource = "Turn Off Thermostat"
    static let description = IntentDescription("Turns a room's thermostat off.")
    static let supportedModes: IntentModes = .background

    @Parameter(title: "Thermostat")
    var thermostat: ThermostatEntity

    static var parameterSummary: some ParameterSummary {
        Summary("Turn off \(\.$thermostat)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let snapshot = try await IntentRunner.snapshot()
        let entry = try IntentRunner.thermostat(thermostat, in: snapshot)
        try await IntentRunner.write {
            try await $0.setThermostatMode(.off, deviceID: entry.deviceID)
        }
        return .result(dialog: IntentDialog("\(entry.name) turned off."))
    }
}

struct HomeStatusIntent: AppIntent {
    static let title: LocalizedStringResource = "Home Status"
    static let description = IntentDescription("Reports the door and room temperatures.")
    static let supportedModes: IntentModes = .background

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let snapshot = try await IntentRunner.snapshot()
        let lock = switch snapshot.lock?.device.lockState {
        case .locked: "The door is locked"
        case .unlocked: "The door is unlocked"
        default: "The door state is unknown"
        }
        let climate = snapshot.primaryThermostat.flatMap { entry in
            entry.device.currentTempF.map {
                " and \(entry.name) is \(Int($0.rounded())) degrees"
            }
        } ?? ""
        return .result(dialog: IntentDialog("\(lock)\(climate)."))
    }
}

// MARK: - Siri phrases

/// Every phrase must contain `\(.applicationName)`; Siri ignores phrases
/// without it.
struct HomeOpsShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: LockDoorIntent(),
            phrases: [
                "Lock the door with \(.applicationName)",
                "Lock up with \(.applicationName)",
                "I'm leaving with \(.applicationName)",
            ],
            shortTitle: "Lock Door",
            systemImageName: "lock.fill"
        )
        AppShortcut(
            intent: UnlockDoorIntent(),
            phrases: [
                "Unlock the door with \(.applicationName)",
                "I'm home with \(.applicationName)",
            ],
            shortTitle: "Unlock Door",
            systemImageName: "lock.open.fill"
        )
        AppShortcut(
            intent: HomeStatusIntent(),
            phrases: [
                "What's the status in \(.applicationName)",
                "Check \(.applicationName)",
            ],
            shortTitle: "Home Status",
            systemImageName: "house"
        )
        AppShortcut(
            intent: SetTemperatureIntent(),
            phrases: ["Set the temperature with \(.applicationName)"],
            shortTitle: "Set Temperature",
            systemImageName: "thermometer.medium"
        )
        AppShortcut(
            intent: TurnOffThermostatIntent(),
            phrases: ["Turn off a thermostat with \(.applicationName)"],
            shortTitle: "Turn Off Thermostat",
            systemImageName: "power"
        )
    }
}
