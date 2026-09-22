import SwiftUI

/// The complete set of states a lock control may be in.
///
/// This is deliberately larger than the wire protocol. The server reports only
/// locked / unlocked / unknown, but a real bolt takes 2-8 seconds and can fail,
/// so the UI must also represent "command sent, not yet confirmed" and "the
/// command did not take". Collapsing those into the two end states is what
/// produces a control that lies about the state of someone's front door.
///
/// The `.locking` / `.unlocking` states are tracked client-side; `.jammed` is
/// what an in-transit state decays into when the server never confirms.
/// The two things a lock can be told to do.
public enum LockCommand: Sendable, Equatable {
    case lock
    case unlock

    /// Unlocking physically opens the door, so it is gated behind biometrics.
    public var opensTheDoor: Bool { self == .unlock }
}

public enum LockPresentation: Equatable, Sendable {
    case locked
    case unlocked
    case locking
    case unlocking
    case jammed
    case offline
    case unknown

    /// How long we wait for confirmation before calling it jammed.
    public static let transitTimeout: TimeInterval = 10

    public var isInTransit: Bool {
        self == .locking || self == .unlocking
    }

    /// Whether the state is confidently known. Offline/unknown must never be
    /// rendered as though it were a real reading.
    public var isDefinite: Bool {
        self == .locked || self == .unlocked
    }

    public var title: String {
        switch self {
        case .locked: "Locked"
        case .unlocked: "Unlocked"
        case .locking: "Locking…"
        case .unlocking: "Unlocking…"
        case .jammed: "Didn't complete"
        case .offline: "Unreachable"
        case .unknown: "Unknown"
        }
    }

    public var symbolName: String {
        switch self {
        case .locked: "lock.fill"
        case .unlocked: "lock.open.fill"
        case .locking: "lock.fill"
        case .unlocking: "lock.open.fill"
        case .jammed: "lock.trianglebadge.exclamationmark.fill"
        case .offline: "wifi.slash"
        case .unknown: "questionmark.circle"
        }
    }

    /// Colour maps to security posture, not to go/stop.
    /// Amber is reserved specifically for the jammed/failed case.
    public var tint: Color {
        switch self {
        case .locked: .green
        case .unlocked: .orange
        case .locking, .unlocking: .secondary
        case .jammed: .yellow
        case .offline, .unknown: .gray
        }
    }

    /// What a tap will do next, or nil when no action is appropriate.
    public var nextCommand: LockCommand? {
        switch self {
        case .locked: .unlock
        case .unlocked, .jammed: .lock
        case .locking, .unlocking, .offline, .unknown: nil
        }
    }

    /// VoiceOver hint describing the outcome of activating the control.
    /// A blind user must know whether the next tap secures or exposes the home.
    public var accessibilityHint: String {
        switch self {
        case .locked: "Double-tap to unlock. Requires Face ID."
        case .unlocked: "Double-tap to lock."
        case .jammed: "The last command didn't complete. Double-tap to try locking again."
        case .locking: "Locking in progress."
        case .unlocking: "Unlocking in progress."
        case .offline: "The lock is unreachable."
        case .unknown: "The lock state is unknown."
        }
    }

    /// Derives the presentation from a server snapshot plus any local in-flight
    /// command. The in-flight command wins, because the server's confirmed value
    /// still reflects the pre-command state until the device reports back.
    public static func resolve(
        device: LockDevice,
        inFlight: LockCommand?,
        commandStartedAt: Date?,
        now: Date = .now
    ) -> LockPresentation {
        if let inFlight, let started = commandStartedAt {
            let elapsed = now.timeIntervalSince(started)
            let settled = switch inFlight {
            case .lock: device.lockState == .locked
            case .unlock: device.lockState == .unlocked
            }
            if !settled {
                if elapsed > transitTimeout { return .jammed }
                return inFlight == .lock ? .locking : .unlocking
            }
        }

        guard device.online else { return .offline }
        return switch device.lockState {
        case .locked: .locked
        case .unlocked: .unlocked
        case .unknown: .unknown
        }
    }
}
