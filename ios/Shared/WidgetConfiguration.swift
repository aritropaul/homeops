import AppIntents

/// Lets the user choose which thermostat a widget shows.
///
/// `WidgetConfigurationIntent` is a data holder — its `perform()` is never
/// called (the protocol pins the result to `Never`), it exists purely so the
/// parameter can drive the widget's edit UI and reach the timeline provider.
struct SelectThermostatIntent: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "Choose Thermostat"
    static let description = IntentDescription("Pick which thermostat this widget shows.")

    @Parameter(title: "Thermostat")
    var thermostat: ThermostatEntity?
}

/// The same choice, for a Control Center control.
///
/// A separate protocol from the widget one, and required here —
/// `AppIntentControlConfiguration` will only accept a `ControlConfigurationIntent`.
struct SelectThermostatControlIntent: ControlConfigurationIntent {
    static let title: LocalizedStringResource = "Choose Thermostat"
    static let description = IntentDescription("Pick which thermostat this control adjusts.")

    @Parameter(title: "Thermostat")
    var thermostat: ThermostatEntity?
}

/// Backs the Control Center thermostat toggle.
///
/// Off/on rather than a temperature, because a control is a single tap with no
/// room to express a setpoint. Turning it on restores cooling rather than
/// guessing a mode.
struct SetThermostatPowerIntent: SetValueIntent {
    static let title: LocalizedStringResource = "Turn Thermostat On or Off"
    static let supportedModes: IntentModes = .background

    @Parameter(title: "Thermostat")
    var thermostat: ThermostatEntity?

    @Parameter(title: "On")
    var value: Bool

    func perform() async throws -> some IntentResult {
        let snapshot = try await IntentRunner.snapshot()
        // Fall back to the default thermostat if the control was never configured.
        let entry: ThermostatEntry
        if let thermostat, let match = snapshot.thermostat(id: thermostat.id) {
            entry = match
        } else if let fallback = snapshot.primaryThermostat {
            entry = fallback
        } else {
            throw IntentFailure(message: "No thermostat found on your hub.")
        }

        try await IntentRunner.write { client in
            if value {
                let target = Int((entry.device.targetTempF ?? 70).rounded())
                try await client.setThermostatTarget(target, mode: .cool, deviceID: entry.deviceID)
            } else {
                try await client.setThermostatMode(.off, deviceID: entry.deviceID)
            }
        }
        return .result()
    }
}
