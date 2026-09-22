import Foundation
import LocalAuthentication

public enum BiometricKind: Sendable, Equatable {
    case none, touchID, faceID, opticID, other

    public var displayName: String {
        switch self {
        case .none: "Passcode"
        case .touchID: "Touch ID"
        case .faceID: "Face ID"
        case .opticID: "Optic ID"
        case .other: "Biometrics"
        }
    }

    public var symbolName: String {
        switch self {
        case .none: "lock.shield"
        case .touchID: "touchid"
        case .faceID: "faceid"
        case .opticID: "opticid"
        case .other: "lock.shield"
        }
    }
}

public enum BiometricOutcome: Sendable, Equatable {
    case success
    /// The user backed out. Show nothing — this is not an error.
    case cancelled
    case failed(String)
}

/// Gates door-opening actions behind Face ID / Touch ID.
///
/// Uses `.deviceOwnerAuthenticationWithBiometrics` rather than
/// `.deviceOwnerAuthentication`: for a front door we want proof of physical
/// presence, not merely knowledge of the device passcode. Lockout is surfaced
/// as an explicit message telling the user to unlock the phone normally first,
/// which is also Apple's stated preference over prompting for a passcode inside
/// an app.
///
/// `LAContext` is not `Sendable`, so a fresh one is created, used, and discarded
/// inside a single isolated call — it never crosses an isolation boundary.
@MainActor
public struct BiometricGate {
    /// Our own short re-prompt suppression window. Note this is NOT
    /// `touchIDAuthenticationAllowableReuseDuration`, which only reuses a Lock
    /// Screen unlock and does nothing for repeat in-app authentications.
    private static var lastSuccess: Date?
    private let reuseWindow: TimeInterval

    public init(reuseWindow: TimeInterval = 0) {
        self.reuseWindow = reuseWindow
    }

    public func availableBiometric() -> BiometricKind {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
            return .none
        }
        return switch context.biometryType {
        case .none: .none
        case .touchID: .touchID
        case .faceID: .faceID
        case .opticID: .opticID
        @unknown default: .other
        }
    }

    public func authenticate(reason: String) async -> BiometricOutcome {
        if reuseWindow > 0, let last = Self.lastSuccess,
           Date.now.timeIntervalSince(last) < reuseWindow {
            return .success
        }

        let context = LAContext()
        var probeError: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &probeError) else {
            return Self.classify(probeError)
        }

        do {
            // A native async overload exists (NS_SWIFT_ASYNC_THROWS_ON_FALSE),
            // so no continuation wrapper is needed. It returns Bool, but a
            // false result throws rather than returning.
            _ = try await context.evaluatePolicy(
                .deviceOwnerAuthenticationWithBiometrics,
                localizedReason: reason
            )
            Self.lastSuccess = .now
            return .success
        } catch {
            return Self.classify(error as NSError)
        }
    }

    private static func classify(_ error: NSError?) -> BiometricOutcome {
        guard let error else { return .failed("Couldn't verify your identity.") }
        guard let code = LAError.Code(rawValue: error.code) else {
            return .failed("Couldn't verify your identity.")
        }

        switch code {
        case .userCancel, .appCancel, .systemCancel, .userFallback:
            return .cancelled
        case .authenticationFailed:
            return .failed("That didn't match. Try again.")
        case .biometryNotAvailable:
            return .failed("Face ID is unavailable or disabled for HomeOps in Settings.")
        case .biometryNotEnrolled:
            return .failed("No Face ID or Touch ID is set up on this device.")
        case .biometryLockout:
            return .failed("Too many attempts. Unlock your phone with your passcode, then try again.")
        case .passcodeNotSet:
            return .failed("Set a device passcode to use biometric unlock.")
        case .invalidContext, .notInteractive:
            return .failed("Couldn't start authentication. Try again.")
        default:
            return .failed("Couldn't verify your identity.")
        }
    }
}
