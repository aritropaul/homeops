import SwiftUI

public extension ThermostatMode {
    var displayName: String {
        switch self {
        case .heat: "Heat"
        case .cool: "Cool"
        case .auto: "Auto"
        case .off: "Off"
        case .unknown: "Unknown"
        }
    }

    var symbolName: String {
        switch self {
        case .heat: "flame.fill"
        case .cool: "snowflake"
        case .auto: "thermometer.variable.and.figure"
        case .off: "power"
        case .unknown: "questionmark"
        }
    }

    /// Orange for heat, blue for cool is the near-universal convention.
    var tint: Color {
        switch self {
        case .heat: .orange
        case .cool: .blue
        case .auto: .green
        case .off, .unknown: .gray
        }
    }
}
