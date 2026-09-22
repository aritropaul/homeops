import Foundation
import Testing
@testable import HomeOps

// MARK: - Helpers

private func device(
    id: Int,
    name: String,
    type: String,
    attributes: [(String, String?, String?)],
    battery: Int? = nil,
    online: Bool? = true
) throws -> SRDevice {
    let attrs = attributes.map { name, state, pending in
        """
        {"name":"\(name)",\
        "state":\(state.map { "\"\($0)\"" } ?? "null"),\
        "pending_state":\(pending.map { "\"\($0)\"" } ?? "null")}
        """
    }.joined(separator: ",")
    let json = """
    {"id":\(id),"name":"\(name)","type":"\(type)",
     "battery_level":\(battery.map(String.init) ?? "null"),
     "online":\(online.map(String.init) ?? "null"),
     "attributes":[\(attrs)]}
    """
    return try JSONDecoder().decode(SRDevice.self, from: Data(json.utf8))
}

// MARK: - SmartRent parsing

@Suite("Parsing SmartRent devices")
struct ParsingTests {
    @Test("A lock's boolean attribute maps to a lock state")
    func lockState() throws {
        let locked = try device(id: 1, name: "Front Door", type: "entry_control",
                                attributes: [("locked", "true", nil)], battery: 43)
        #expect(LockDevice(device: locked).lockState == .locked)
        #expect(LockDevice(device: locked).batteryPct == 43)

        let unlocked = try device(id: 1, name: "Front Door", type: "entry_control",
                                  attributes: [("locked", "false", nil)])
        #expect(LockDevice(device: unlocked).lockState == .unlocked)

        // Anything else must not be guessed at.
        let odd = try device(id: 1, name: "Front Door", type: "entry_control",
                             attributes: [("locked", "jammed", nil)])
        #expect(LockDevice(device: odd).lockState == .unknown)

        let missing = try device(id: 1, name: "Front Door", type: "entry_control",
                                 attributes: [])
        #expect(LockDevice(device: missing).lockState == .unknown)
    }

    @Test("The setpoint that matters is the one matching the active mode")
    func setpointFollowsMode() throws {
        let cooling = try device(id: 2, name: "Aritro", type: "thermostat", attributes: [
            ("mode", "cool", nil),
            ("heating_setpoint", "68", nil),
            ("cooling_setpoint", "74", nil),
            ("current_temp", "71", nil),
        ])
        #expect(ThermostatDevice(device: cooling).targetTempF == 74)

        let heating = try device(id: 2, name: "Aritro", type: "thermostat", attributes: [
            ("mode", "heat", nil),
            ("heating_setpoint", "68", nil),
            ("cooling_setpoint", "74", nil),
        ])
        #expect(ThermostatDevice(device: heating).targetTempF == 68)
    }

    @Test("aux_heat is reported as heat")
    func auxHeat() throws {
        let d = try device(id: 2, name: "Aritro", type: "thermostat",
                           attributes: [("mode", "aux_heat", nil)])
        #expect(ThermostatDevice(device: d).mode == .heat)
    }

    @Test("An unrecognised mode degrades to .unknown rather than throwing")
    func lenientMode() throws {
        let d = try device(id: 2, name: "Aritro", type: "thermostat",
                           attributes: [("mode", "dehumidify", nil)])
        #expect(ThermostatDevice(device: d).mode == .unknown)
    }

    @Test("A pending write is surfaced, not silently treated as confirmed")
    func pendingWrite() throws {
        let d = try device(id: 2, name: "Aritro", type: "thermostat", attributes: [
            ("mode", "off", "cool"),
            ("cooling_setpoint", "72", "66"),
        ])
        let parsed = ThermostatDevice(device: d)
        #expect(parsed.mode == .off)              // confirmed value
        #expect(parsed.pendingMode == .cool)      // what's in flight
        #expect(parsed.pendingTargetTempF == 66)
        #expect(parsed.hasPendingWrite)
    }

    @Test("A zero reading is a real value, not a missing one")
    func zeroIsNotNil() throws {
        let d = try device(id: 2, name: "Aritro", type: "thermostat", attributes: [
            ("mode", "cool", nil),
            ("current_humidity", "0", nil),
        ])
        #expect(ThermostatDevice(device: d).humidityPct == 0)
    }
}

// MARK: - Snapshot assembly

@Suite("Assembling a snapshot from the hub")
struct SnapshotTests {
    private func hub() throws -> [SRDevice] {
        [
            try device(id: 10, name: "Front Door", type: "entry_control",
                       attributes: [("locked", "true", nil)], battery: 43),
            try device(id: 13, name: "Living Room", type: "thermostat",
                       attributes: [("mode", "off", nil)]),
            try device(id: 11, name: "Aritro", type: "thermostat",
                       attributes: [("mode", "cool", nil), ("cooling_setpoint", "68", nil)]),
            try device(id: 99, name: "Hallway", type: "thermostat",
                       attributes: [("mode", "heat", nil)]),
            try device(id: 50, name: "Some Light", type: "switch_binary", attributes: []),
        ]
    }

    @Test("The lock is found by device class, not by name")
    func findsLock() throws {
        let snapshot = Snapshot(devices: try hub(), fetchedAt: .now)
        #expect(snapshot.lock?.deviceID == 10)
        #expect(snapshot.lock?.device.lockState == .locked)
    }

    @Test("Every thermostat is kept and addressable, whatever it's named")
    func keepsEveryThermostat() throws {
        let snapshot = Snapshot(devices: try hub(), fetchedAt: .now)
        #expect(snapshot.thermostats.count == 3)
        #expect(snapshot.thermostat(id: 11)?.name == "Aritro")
        // A device named nothing like a room is still present and reachable —
        // one of the real ones is called "Sophia's controls".
        #expect(snapshot.thermostat(id: 99)?.displayName == "Hallway")
    }

    @Test("Thermostats are listed in a stable, human order")
    func ordering() throws {
        let snapshot = Snapshot(devices: try hub(), fetchedAt: .now)
        #expect(snapshot.thermostats.map(\.name) == ["Aritro", "Hallway", "Living Room"])
        #expect(snapshot.primaryThermostat?.name == "Aritro")
    }

    @Test("Non-climate, non-lock devices are ignored")
    func ignoresOtherDevices() throws {
        let snapshot = Snapshot(devices: try hub(), fetchedAt: .now)
        #expect(!snapshot.thermostats.contains { $0.deviceID == 50 })
    }

}

// MARK: - Lock state machine

@Suite("Lock presentation")
struct LockPresentationTests {
    private func lock(_ state: LockState, online: Bool = true) -> LockDevice {
        LockDevice(lockState: state, online: online)
    }

    @Test("Confirmed states pass through")
    func settled() {
        #expect(LockPresentation.resolve(device: lock(.locked), inFlight: nil,
                                         commandStartedAt: nil) == .locked)
        #expect(LockPresentation.resolve(device: lock(.unlocked), inFlight: nil,
                                         commandStartedAt: nil) == .unlocked)
    }

    @Test("An offline lock is never rendered as locked or unlocked")
    func offline() {
        // The last known value is not evidence of the current state.
        let result = LockPresentation.resolve(device: lock(.locked, online: false),
                                              inFlight: nil, commandStartedAt: nil)
        #expect(result == .offline)
        #expect(!result.isDefinite)
    }

    @Test("A command in flight shows in-transit, never the optimistic result")
    func inTransit() {
        let result = LockPresentation.resolve(
            device: lock(.unlocked),        // hasn't caught up yet
            inFlight: .lock,
            commandStartedAt: .now
        )
        #expect(result == .locking)
        #expect(result.isInTransit)
        #expect(result.nextCommand == nil)  // control disabled while in transit
    }

    @Test("An unconfirmed command decays to jammed rather than lying")
    func jams() {
        let started = Date.now.addingTimeInterval(-(LockPresentation.transitTimeout + 1))
        let result = LockPresentation.resolve(device: lock(.unlocked), inFlight: .lock,
                                              commandStartedAt: started)
        #expect(result == .jammed)
        #expect(result.nextCommand == .lock)   // retry is offered
    }

    @Test("Once confirmed, the in-flight marker stops applying")
    func settles() {
        let result = LockPresentation.resolve(device: lock(.locked), inFlight: .lock,
                                              commandStartedAt: .now)
        #expect(result == .locked)
    }

    @Test("Friction is asymmetric: unlock is gated, lock is not")
    func friction() {
        #expect(LockPresentation.locked.nextCommand == .unlock)
        #expect(LockPresentation.locked.nextCommand?.opensTheDoor == true)
        #expect(LockPresentation.unlocked.nextCommand == .lock)
        #expect(LockPresentation.unlocked.nextCommand?.opensTheDoor == false)
    }

    @Test("Every state has a distinct title and a hint naming the outcome")
    func hints() {
        let all: [LockPresentation] = [.locked, .unlocked, .locking, .unlocking,
                                       .jammed, .offline, .unknown]
        #expect(Set(all.map(\.accessibilityHint)).count == all.count)
        #expect(Set(all.map(\.title)).count == all.count)
    }
}

// MARK: - Misc

@Suite("Presentation details")
struct PresentationTests {
    @Test("Just-fetched reads as 'just now', not 'in 0 seconds'")
    func freshness() {
        let now = Date.now
        #expect(DashboardView.freshness(now, now: now) == "just now")
        #expect(DashboardView.freshness(now.addingTimeInterval(-30), now: now) == "30s ago")
        #expect(DashboardView.freshness(now.addingTimeInterval(-300), now: now) == "5m ago")
    }

    @Test("A snapshot older than five minutes is marked stale")
    func staleness() {
        let fresh = Snapshot(lock: nil, thermostats: [], fetchedAt: .now)
        #expect(!fresh.isStale)
        let old = Snapshot(lock: nil, thermostats: [],
                           fetchedAt: .now.addingTimeInterval(-600))
        #expect(old.isStale)
    }

    @Test("A thermostat deep link routes by device id")
    func deepLinks() {
        #expect(AppRoute.parse(URL(string: "homeops://thermostat/11")!) == .thermostat(deviceID: 11))
        #expect(AppRoute.parse(URL(string: "homeops://thermostat/99")!) == .thermostat(deviceID: 99))
    }

    @Test("Malformed links are rejected rather than guessed at")
    func rejectsBadLinks() {
        #expect(AppRoute.parse(URL(string: "homeops://thermostat/aritro")!) == nil)
        #expect(AppRoute.parse(URL(string: "homeops://thermostat")!) == nil)
        #expect(AppRoute.parse(URL(string: "homeops://elsewhere/11")!) == nil)
        #expect(AppRoute.parse(URL(string: "https://thermostat/11")!) == nil)
    }
}
