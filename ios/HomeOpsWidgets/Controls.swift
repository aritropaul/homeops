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
