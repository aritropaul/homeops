import Foundation

// MARK: - Lenient enums
//
// Anything SmartRent can widen over time decodes an unrecognised value to
// `.unknown` rather than throwing, so one new device mode can never make a
// whole payload unusable.

public enum ThermostatMode: String, Codable, Sendable, CaseIterable {
    case heat, cool, auto, off, unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ThermostatMode(raw: raw)
    }

    /// SmartRent reports `aux_heat` for emergency heat; treat it as heat.
    public init(raw: String?) {
        switch raw {
        case "aux_heat": self = .heat
        default: self = ThermostatMode(rawValue: raw ?? "") ?? .unknown
        }
    }
}

public enum LockState: String, Codable, Sendable {
    case locked, unlocked, unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = LockState(rawValue: raw) ?? .unknown
    }

    /// SmartRent exposes the lock as a boolean `locked` attribute.
    public init(attribute: String?) {
        switch attribute {
        case "true": self = .locked
        case "false": self = .unlocked
        default: self = .unknown
        }
    }
}

/// How much to trust a device's readings.
///
/// SmartRent's device-level `online` flag is not reliable on its own: observed
/// live, a thermostat reporting a fresh reading one minute ago was flagged
/// `online=false`, while a lock whose newest reading was eight hours old was
/// flagged `online=true`. Trusting that flag alone makes working devices
/// disappear from the UI and dead ones look healthy.
///
/// Recency of an actual reading is the better signal, so it wins; the flag is
/// only consulted when there's no reading to judge by.
public enum Reachability: Sendable, Equatable, Codable {
    case live
    case stale(age: TimeInterval)
    case unreachable

    /// Anything newer than this is treated as current.
    public static let freshWindow: TimeInterval = 30 * 60

    public static func resolve(online: Bool, lastReadAt: Date?, now: Date = .now) -> Reachability {
        guard let lastReadAt else { return online ? .live : .unreachable }
        let age = now.timeIntervalSince(lastReadAt)
        return age < freshWindow ? .live : .stale(age: age)
    }

    public var hasUsableReading: Bool { self != .unreachable }

    /// Short, honest label for stale data — "3 hr ago", not silence.
    public var ageDescription: String? {
        guard case .stale(let age) = self else { return nil }
        if age < 3600 { return "\(Int(age / 60)) min ago" }
        if age < 86_400 { return "\(Int(age / 3600)) hr ago" }
        let days = Int(age / 86_400)
        return days == 1 ? "1 day ago" : "\(days) days ago"
    }
}

// MARK: - Devices

public struct LockDevice: Codable, Sendable, Equatable {
    public let lockState: LockState
    public let batteryPct: Int?
    public let reachability: Reachability
    public let lastNotification: String?

    public init(
        lockState: LockState,
        batteryPct: Int? = nil,
        reachability: Reachability = .live,
        lastNotification: String? = nil
    ) {
        self.lockState = lockState
        self.batteryPct = batteryPct
        self.reachability = reachability
        self.lastNotification = lastNotification
    }

    init(device: SRDevice) {
        self.lockState = LockState(attribute: device.state("locked"))
        self.batteryPct = device.battery_level
        self.reachability = .resolve(online: device.online ?? true,
                                     lastReadAt: device.lastReadAt)
        self.lastNotification = device.state("notifications")
    }

    /// Kept for call sites that only care whether we can act on it.
    public var online: Bool { reachability != .unreachable }
}

public struct ThermostatDevice: Codable, Sendable, Equatable {
    public let mode: ThermostatMode
    public let currentTempF: Double?
    public let targetTempF: Double?
    public let humidityPct: Double?
    public let reachability: Reachability
    /// Set while a write is in flight and the device hasn't confirmed it.
    public let pendingMode: ThermostatMode?
    public let pendingTargetTempF: Double?

    public init(
        mode: ThermostatMode,
        currentTempF: Double? = nil,
        targetTempF: Double? = nil,
        humidityPct: Double? = nil,
        reachability: Reachability = .live,
        pendingMode: ThermostatMode? = nil,
        pendingTargetTempF: Double? = nil
    ) {
        self.mode = mode
        self.currentTempF = currentTempF
        self.targetTempF = targetTempF
        self.humidityPct = humidityPct
        self.reachability = reachability
        self.pendingMode = pendingMode
        self.pendingTargetTempF = pendingTargetTempF
    }

    init(device: SRDevice) {
        let mode = ThermostatMode(raw: device.state("mode"))
        self.mode = mode
        self.reachability = .resolve(online: device.online ?? true,
                                     lastReadAt: device.lastReadAt)
        self.currentTempF = Double(device.state("current_temp") ?? "")
        self.humidityPct = Double(device.state("current_humidity") ?? "")

        // The meaningful setpoint is the one matching the active mode.
        let heating = Double(device.state("heating_setpoint") ?? "")
        let cooling = Double(device.state("cooling_setpoint") ?? "")
        switch mode {
        case .heat: self.targetTempF = heating ?? cooling
        case .cool: self.targetTempF = cooling ?? heating
        default: self.targetTempF = heating ?? cooling
        }

        let pendingModeRaw = device.pending("mode")
        self.pendingMode = pendingModeRaw.map { ThermostatMode(raw: $0) }

        let pendingHeat = Double(device.pending("heating_setpoint") ?? "")
        let pendingCool = Double(device.pending("cooling_setpoint") ?? "")
        let effective = pendingModeRaw.map { ThermostatMode(raw: $0) } ?? mode
        switch effective {
        case .heat: self.pendingTargetTempF = pendingHeat ?? pendingCool
        case .cool: self.pendingTargetTempF = pendingCool ?? pendingHeat
        default: self.pendingTargetTempF = pendingHeat ?? pendingCool
        }
    }

    public var hasPendingWrite: Bool {
        pendingMode != nil || pendingTargetTempF != nil
    }

    /// Kept for call sites that only care whether we can act on it.
    public var online: Bool { reachability != .unreachable }
}

// MARK: - Snapshot

/// One thermostat, carrying the SmartRent device id needed to write to it.
public struct ThermostatEntry: Codable, Sendable, Equatable, Identifiable {
    public let deviceID: Int
    /// Whatever the property named this device in SmartRent.
    public let name: String
    public let device: ThermostatDevice

    public var id: Int { deviceID }
    public var displayName: String { name }
}

public struct LockEntry: Codable, Sendable, Equatable, Identifiable {
    public let deviceID: Int
    public let name: String
    public let device: LockDevice

    public var id: Int { deviceID }
}

/// The app's view of the home, assembled directly from SmartRent's device list.
///
/// Device ids are carried here rather than configured, because the app
/// discovers them from the hub — the user only ever signs in.
public struct Snapshot: Codable, Sendable, Equatable {
    public let lock: LockEntry?
    public let thermostats: [ThermostatEntry]
    public let fetchedAt: Date

    public init(lock: LockEntry?, thermostats: [ThermostatEntry], fetchedAt: Date) {
        self.lock = lock
        self.thermostats = thermostats
        self.fetchedAt = fetchedAt
    }

    init(devices: [SRDevice], fetchedAt: Date) {
        // `primary_lock` isn't always set, so match on the device class instead.
        let lockDevice = devices.first { $0.type == "entry_control" }
        self.lock = lockDevice.map {
            LockEntry(deviceID: $0.id, name: $0.name, device: LockDevice(device: $0))
        }
        self.thermostats = devices
            .filter { $0.type == "thermostat" }
            .map {
                ThermostatEntry(
                    deviceID: $0.id,
                    name: $0.name,
                    device: ThermostatDevice(device: $0)
                )
            }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        self.fetchedAt = fetchedAt
    }

    public func thermostat(id: Int) -> ThermostatEntry? {
        thermostats.first { $0.deviceID == id }
    }

    /// The thermostat to show when the user hasn't picked one.
    ///
    /// Prefers one that's actually reporting: falling back to alphabetical
    /// order picked a device that had been silent for a day, which is the worst
    /// possible default for a glanceable widget.
    public var primaryThermostat: ThermostatEntry? {
        thermostats.first { $0.device.reachability == .live } ?? thermostats.first
    }

    public var age: TimeInterval { Date.now.timeIntervalSince(fetchedAt) }
    public var isStale: Bool { age > 300 }
}
