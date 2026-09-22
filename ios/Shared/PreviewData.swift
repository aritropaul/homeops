import Foundation

extension Snapshot {
    /// Plausible sample data. Widget placeholders are redacted by the system, so
    /// the shape must be realistic or the shimmer has nothing to draw over.
    static var preview: Snapshot {
        Snapshot(
            lock: LockEntry(
                deviceID: 1,
                name: "Front Door",
                device: LockDevice(
                    lockState: .locked,
                    batteryPct: 82,
                    reachability: .live,
                    lastNotification: "KEY_OR_THUMBTURN_UNLOCK"
                )
            ),
            thermostats: [
                ThermostatEntry(
                    deviceID: 2, name: "Aritro",
                    device: ThermostatDevice(
                        mode: .cool, currentTempF: 71, targetTempF: 68,
                        humidityPct: 52, reachability: .live
                    )
                ),
                ThermostatEntry(
                    deviceID: 3, name: "Adhya",
                    device: ThermostatDevice(
                        mode: .off, currentTempF: 70, targetTempF: 70,
                        humidityPct: 48, reachability: .live
                    )
                ),
                ThermostatEntry(
                    deviceID: 4, name: "Sophia's controls",
                    device: ThermostatDevice(
                        mode: .heat, currentTempF: 69, targetTempF: 71,
                        humidityPct: 44, reachability: .live
                    )
                ),
            ],
            fetchedAt: .now
        )
    }
}
