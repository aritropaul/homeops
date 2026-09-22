import SwiftUI

/// The door control.
///
/// Deliberate design choices, all from the lock-UX research:
///   - It is a stateful *button*, not a `Toggle`. A switch implies an instant,
///     reliable, local state change; a bolt is none of those.
///   - The state is never optimistically flipped. Tapping moves it to an
///     explicit in-transit state and it only reaches locked/unlocked when the
///     server confirms, or `.jammed` when it doesn't.
///   - Friction is asymmetric: locking is one tap, unlocking goes through
///     Face ID (handled in the view model, which gates any door-opening action).
///   - Offline never renders as a confident locked/unlocked state.
struct LockCard: View {
    let name: String
    let presentation: LockPresentation
    let batteryPct: Int?
    let lastNotification: String?
    let biometric: BiometricKind
    let onTap: () -> Void
    let onLock: () -> Void
    let onUnlock: () -> Void

    private var isBusy: Bool { presentation.isInTransit }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header

            Button(action: onTap) {
                HStack(spacing: 14) {
                    ZStack {
                        Circle()
                            .fill(presentation.tint.opacity(0.15))
                            .frame(width: 56, height: 56)
                        if isBusy {
                            ProgressView().controlSize(.large)
                        } else {
                            Image(systemName: presentation.symbolName)
                                .font(.title2)
                                .foregroundStyle(presentation.tint)
                                .contentTransition(.symbolEffect(.replace))
                        }
                    }

                    VStack(alignment: .leading, spacing: 2) {
                        Text(presentation.title)
                            .font(.headline)
                        if let detail = detailLine {
                            Text(detail)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }

                    Spacer()

                    if presentation == .locked {
                        Image(systemName: biometric.symbolName)
                            .font(.footnote)
                            .foregroundStyle(.tertiary)
                    }
                }
                .padding(16)
            }
            .buttonStyle(.plain)
            .background(.background.secondary, in: ConcentricRectangle())
            .disabled(presentation.nextCommand == nil)
            .sensoryFeedback(.press(.toggle), trigger: presentation)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(name)
            .accessibilityValue(presentation.title)
            .accessibilityHint(presentation.accessibilityHint)
            .accessibilityAddTraits(.isButton)
        }
    }

    private var header: some View {
        HStack {
            Label(name, systemImage: "door.left.hand.closed")
                .font(.subheadline.weight(.semibold))
            Spacer()
            if let batteryPct {
                Label("\(batteryPct)%", systemImage: batterySymbol(batteryPct))
                    .font(.caption)
                    .foregroundStyle(batteryPct < 20 ? .orange : .secondary)
                    .accessibilityLabel("Lock battery \(batteryPct) percent")
            }
            Menu {
                Button("Lock", systemImage: "lock.fill", action: onLock)
                Button("Unlock", systemImage: "lock.open.fill", action: onUnlock)
            } label: {
                Image(systemName: "ellipsis.circle")
                    .foregroundStyle(.secondary)
            }
            .accessibilityLabel("More lock actions")
        }
    }

    private var detailLine: String? {
        if presentation == .jammed {
            return "The lock didn't confirm. Tap to retry."
        }
        if presentation == .offline {
            return "Last state can't be trusted"
        }
        return lastNotification.map(Self.humanise)
    }

    private func batterySymbol(_ pct: Int) -> String {
        switch pct {
        case ..<20: "battery.25"
        case ..<60: "battery.50"
        default: "battery.100"
        }
    }

    /// SmartRent ships notifications like `KEY_OR_THUMBTURN_UNLOCK`.
    static func humanise(_ raw: String) -> String {
        raw.replacingOccurrences(of: "_", with: " ").capitalized
    }
}
