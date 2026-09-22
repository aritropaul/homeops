import SwiftUI

/// Press feedback for card-sized controls.
///
/// Feedback fires on press-*down*, not on release. Waiting for the tap to
/// complete before acknowledging it is the single fastest way to make an
/// interface feel dead, and a home control gets tapped constantly.
///
/// The scale is deliberately small (0.98 rather than the usual 0.97) because
/// these are large surfaces — the same ratio reads as a much bigger movement on
/// a full-width card than on a button, and overshooting looks childish on
/// something that controls a door.
struct PressableCardStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.98 : 1)
            .animation(
                // Down is near-instant so it feels attached to the finger;
                // release is slightly softer so it settles rather than snaps.
                configuration.isPressed
                    ? .easeOut(duration: 0.08)
                    : .spring(duration: 0.25, bounce: 0.1),
                value: configuration.isPressed
            )
    }
}

extension ButtonStyle where Self == PressableCardStyle {
    static var pressableCard: PressableCardStyle { PressableCardStyle() }
}

/// The lock's own press treatment.
///
/// Distinct from the card style: this one dims slightly as well as scaling,
/// because the lock is the one control where an accidental press has a physical
/// consequence and the extra weight makes the press feel deliberate.
struct LockPressStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.975 : 1)
            .opacity(configuration.isPressed ? 0.92 : 1)
            .animation(
                configuration.isPressed
                    ? .easeOut(duration: 0.08)
                    : .spring(duration: 0.28, bounce: 0.12),
                value: configuration.isPressed
            )
    }
}

extension ButtonStyle where Self == LockPressStyle {
    static var lockPress: LockPressStyle { LockPressStyle() }
}
