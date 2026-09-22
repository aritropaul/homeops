import AppIntents
import SwiftUI
import WidgetKit

/// Control Center / Action Button controls.
///
/// These live in the same widget extension target; `WidgetBundle` adapts a
/// `ControlWidget` automatically. Note the reload path for controls is
/// `ControlCenter.shared`, not `WidgetCenter`.

// MARK: - Lock

struct LockValueProvider: ControlValueProvider {
    // A property on ControlValueProvider (it is a *function* on the
    // AppIntent-configurable variant — easy to mix up).
    var previewValue: Bool { true }

    /// Reads the shared cache rather than the network: Control Center expects
    /// a fast answer and polls this on its own cadence.
    func currentValue() async throws -> Bool {
        SnapshotCache().load()?.lock?.device.lockState == .locked
    }
}

struct LockControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(
            kind: HomeOpsIdentifiers.ControlKind.lock,
            provider: LockValueProvider()
        ) { isLocked in
            ControlWidgetToggle(
                isOn: isLocked,
                action: SetLockIntent()
            ) {
                Label(isLocked ? "Locked" : "Unlocked",
                      systemImage: isLocked ? "lock.fill" : "lock.open.fill")
                    .controlWidgetActionHint(isLocked ? "Unlock" : "Lock")
            }
            .tint(.green)
        }
        .displayName("Front Door")
        .description("Lock the front door. Unlocking opens HomeOps for Face ID.")
    }
}

// MARK: - Thermostat

/// Note the shape difference from `ControlValueProvider`: here `previewValue`
/// is a *function* taking the configuration, not a property. Mixing the two up
/// is the easiest mistake to make with this API.
struct ThermostatValueProvider: AppIntentControlValueProvider {
    func previewValue(configuration: SelectThermostatControlIntent) -> ThermostatControlValue {
        ThermostatControlValue(
            name: configuration.thermostat?.name ?? "Thermostat",
            isOn: true
        )
    }

    /// Reads the shared cache rather than the network — Control Center polls
    /// this on its own cadence and expects a fast answer.
    func currentValue(configuration: SelectThermostatControlIntent) async throws -> ThermostatControlValue {
        let snapshot = SnapshotCache().load()
        let entry = configuration.thermostat.flatMap { snapshot?.thermostat(id: $0.id) }
            ?? snapshot?.primaryThermostat
        return ThermostatControlValue(
            name: entry?.name ?? configuration.thermostat?.name ?? "Thermostat",
            isOn: (entry?.device.mode ?? .off) != .off
        )
    }
}

/// The toggle needs a Bool, but the label needs the device's name, so the
/// provider's value carries both rather than just the boolean.
struct ThermostatControlValue {
    let name: String
    let isOn: Bool
}

struct ThermostatControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        AppIntentControlConfiguration(
            kind: HomeOpsIdentifiers.ControlKind.thermostat,
            provider: ThermostatValueProvider()
        ) { value in
            ControlWidgetToggle(
                isOn: value.isOn,
                action: SetThermostatPowerIntent()
            ) {
                Label(value.name, systemImage: value.isOn ? "snowflake" : "power")
                    .controlWidgetActionHint(value.isOn ? "Turn Off" : "Turn On")
            }
            .tint(.blue)
        }
        .displayName("Thermostat")
        .description("Turn a thermostat on or off.")
        // Prompts for which thermostat when it's added, instead of silently
        // defaulting to one the user didn't pick.
        .promptsForUserConfiguration()
    }
}
