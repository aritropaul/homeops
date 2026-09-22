import SwiftUI

/// Toast presentation.
///
/// Visual decisions, and why:
///   - **Inverted surface, not glass.** Glass over a light dashboard washes out —
///     Apple's own material guidance is explicit that a light translucent layer
///     on a light background destroys legibility. Using `.label` as the
///     background and `.systemBackground` as the foreground inverts against
///     whatever theme is active, so contrast is guaranteed in both.
///   - **Hugs its content.** A full-width bar reads as permanent chrome. A pill
///     that wraps its text reads as a passing message, which is what it is.
///   - **Stacked, not listed.** Older toasts tuck behind the newest, scaled and
///     dimmed, so a burst of them stays one object instead of a growing wall.
///
/// Motion decisions:
///   - Enters and exits along the same path (up from the bottom, back down), so
///     swipe-to-dismiss matches where it came from.
///   - Drag tracks 1:1 downward and rubber-bands upward rather than hitting a
///     wall.
///   - Release uses velocity, not just distance — a flick dismisses even if it
///     barely moved.
///   - Exit is faster than enter: the user has decided, so get out of the way.
struct ToastStack: View {
    let toasts: [Toast]
    let onDismiss: (Toast.ID) -> Void

    /// Newest last in the array, so it should draw frontmost.
    private var ordered: [(offset: Int, element: Toast)] {
        Array(toasts.suffix(3).reversed().enumerated())
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            ForEach(ordered, id: \.element.id) { index, toast in
                ToastRow(
                    toast: toast,
                    isFront: index == 0,
                    onDismiss: { onDismiss(toast.id) }
                )
                // Older ones peek out behind the newest.
                .scaleEffect(1 - CGFloat(index) * 0.05, anchor: .bottom)
                .offset(y: CGFloat(index) * 9)
                .opacity(index == 0 ? 1 : 0.55)
                .zIndex(Double(ordered.count - index))
                .transition(.toastSlide)
            }
        }
        .padding(.bottom, 10)
        .animation(.spring(duration: 0.34, bounce: 0.18), value: toasts)
    }
}

private struct ToastRow: View {
    let toast: Toast
    let isFront: Bool
    let onDismiss: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dragOffset: CGFloat = 0
    @State private var dismissTask: Task<Void, Never>?

    private let dismissDistance: CGFloat = 50
    private let dismissVelocity: CGFloat = 250

    var body: some View {
        HStack(spacing: 9) {
            Image(systemName: toast.kind.symbolName)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(toast.kind.glyphTint)

            Text(toast.message)
                .font(.subheadline.weight(.medium))
                // Inverts against the surface, so it's legible in both themes.
                .foregroundStyle(Color(uiColor: .systemBackground))
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(
            Capsule(style: .continuous)
                .fill(Color(uiColor: .label))
                .shadow(color: .black.opacity(0.28), radius: 16, y: 6)
        )
        // Never full-bleed: leave margin so it reads as a floating object.
        .padding(.horizontal, 24)
        .offset(y: dragOffset)
        .gesture(isFront ? dragToDismiss : nil)
        .onAppear(perform: scheduleAutoDismiss)
        .onDisappear { dismissTask?.cancel() }
        .sensoryFeedback(toast.kind.feedback, trigger: toast.id)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(toast.message)
        .accessibilityAddTraits(.isStaticText)
        // VoiceOver can't perform the swipe, so always expose an explicit action.
        .accessibilityAction(named: "Dismiss", dismiss)
    }

    private var dragToDismiss: some Gesture {
        DragGesture(minimumDistance: 4)
            .onChanged { value in
                dismissTask?.cancel()            // don't vanish under the finger
                let dy = value.translation.height
                dragOffset = dy > 0 ? dy : rubberBand(dy)
            }
            .onEnded { value in
                let velocity = value.predictedEndTranslation.height - value.translation.height
                if dragOffset > dismissDistance || velocity > dismissVelocity {
                    dismiss()
                } else {
                    withAnimation(.spring(duration: 0.3, bounce: 0.2)) { dragOffset = 0 }
                    scheduleAutoDismiss()
                }
            }
    }

    /// The further past the edge, the less it follows.
    private func rubberBand(_ offset: CGFloat) -> CGFloat {
        let constant: CGFloat = 0.55
        let dimension: CGFloat = 120
        return -(abs(offset) * dimension * constant) / (dimension + constant * abs(offset))
    }

    private func scheduleAutoDismiss() {
        dismissTask?.cancel()
        guard let delay = toast.kind.autoDismissAfter else { return }
        dismissTask = Task {
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            await MainActor.run { dismiss() }
        }
    }

    private func dismiss() {
        dismissTask?.cancel()
        withAnimation(reduceMotion ? .easeOut(duration: 0.15)
                                   : .spring(duration: 0.22, bounce: 0)) {
            onDismiss()
        }
    }
}

private extension Toast.Kind {
    /// Saturated enough to hold up against both a black and a white pill.
    var glyphTint: Color {
        switch self {
        case .success: Color(red: 0.30, green: 0.85, blue: 0.45)
        case .info: Color(red: 0.40, green: 0.70, blue: 1.00)
        case .error: Color(red: 1.00, green: 0.62, blue: 0.25)
        }
    }

    var feedback: SensoryFeedback {
        switch self {
        case .success: .success
        case .info: .impact(weight: .light)
        case .error: .error
        }
    }
}

private extension AnyTransition {
    /// Same path in and out. Never scales from zero — nothing in the physical
    /// world appears out of nothing.
    static var toastSlide: AnyTransition {
        .asymmetric(
            insertion: .move(edge: .bottom)
                .combined(with: .opacity)
                .combined(with: .scale(scale: 0.94, anchor: .bottom)),
            removal: .move(edge: .bottom).combined(with: .opacity)
        )
    }
}

extension View {
    /// Floats toasts above everything.
    ///
    /// Applied at the app root, *outside* the navigation stack — inside it, any
    /// pushed screen covers the toast, which is exactly the bug this fixes.
    func toasts(_ toasts: [Toast], onDismiss: @escaping (Toast.ID) -> Void) -> some View {
        overlay(alignment: .bottom) {
            ToastStack(toasts: toasts, onDismiss: onDismiss)
                .allowsHitTesting(!toasts.isEmpty)
        }
    }
}
