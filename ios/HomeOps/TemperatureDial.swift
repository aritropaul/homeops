import SwiftUI

/// Angle convention throughout: 0° is the +x axis (3 o'clock) and positive
/// degrees sweep clockwise on screen, matching `Path.addRelativeArc`. Using
/// `addRelativeArc(startAngle:delta:)` rather than `addArc(…clockwise:)` avoids
/// the sign ambiguity of the `clockwise` flag in SwiftUI's flipped coordinates,
/// and guarantees the arc, the handle, and the hit-testing math all agree.
private struct DialArc: Shape {
    var startDegrees: Double
    var sweepDegrees: Double
    var inset: CGFloat

    var animatableData: Double {
        get { sweepDegrees }
        set { sweepDegrees = newValue }
    }

    func path(in rect: CGRect) -> Path {
        var path = Path()
        let center = CGPoint(x: rect.midX, y: rect.midY)
        let radius = min(rect.width, rect.height) / 2 - inset
        guard radius > 0 else { return path }
        path.addRelativeArc(
            center: center,
            radius: radius,
            startAngle: .degrees(startDegrees),
            delta: .degrees(sweepDegrees)
        )
        return path
    }
}

/// A draggable temperature ring.
///
/// `Gauge` is not usable here: every one of its initialisers takes a plain
/// value, never a `Binding`, so it is display-only and cannot be dragged.
///
/// Per the research, a dial alone is the single most-complained-about control
/// in thermostat apps because single-degree corrections are fiddly, so the
/// caller is expected to pair this with the ± stepper below it.
struct TemperatureDial: View {
    @Binding var target: Double
    var current: Double?
    var range: ClosedRange<Double> = 50...85
    var mode: ThermostatMode
    var subtitle: String?
    var isEnabled: Bool = true
    var onCommit: (Double) -> Void

    private let startDegrees: Double = 135
    private let sweepDegrees: Double = 270
    private let lineWidth: CGFloat = 20

    @GestureState private var dragTarget: Double?

    private var displayed: Double { dragTarget ?? target }

    private var fraction: Double {
        let span = range.upperBound - range.lowerBound
        guard span > 0 else { return 0 }
        return min(max((displayed - range.lowerBound) / span, 0), 1)
    }

    var body: some View {
        GeometryReader { proxy in
            let size = proxy.size
            let center = CGPoint(x: size.width / 2, y: size.height / 2)
            let radius = min(size.width, size.height) / 2 - lineWidth / 2

            ZStack {
                DialArc(startDegrees: startDegrees, sweepDegrees: sweepDegrees, inset: lineWidth / 2)
                    .stroke(
                        Color.secondary.opacity(0.18),
                        style: StrokeStyle(lineWidth: lineWidth, lineCap: .round)
                    )

                DialArc(
                    startDegrees: startDegrees,
                    sweepDegrees: sweepDegrees * fraction,
                    inset: lineWidth / 2
                )
                .stroke(
                    mode.tint.gradient,
                    style: StrokeStyle(lineWidth: lineWidth, lineCap: .round)
                )
                .opacity(isEnabled ? 1 : 0.35)

                handle(center: center, radius: radius)
                readout
            }
            .contentShape(Circle())
            .gesture(dragGesture(center: center), isEnabled: isEnabled)
        }
        .aspectRatio(1, contentMode: .fit)
        .sensoryFeedback(.selection, trigger: Int(displayed.rounded()))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(mode.displayName) target temperature")
        .accessibilityValue(accessibilityValue)
        .accessibilityHint("Swipe up or down to adjust by one degree.")
        .accessibilityAdjustableAction { direction in
            guard isEnabled else { return }
            switch direction {
            case .increment: commit(min(target + 1, range.upperBound))
            case .decrement: commit(max(target - 1, range.lowerBound))
            @unknown default: break
            }
        }
    }

    private func handle(center: CGPoint, radius: CGFloat) -> some View {
        let radians: Double = (startDegrees + sweepDegrees * fraction) * .pi / 180
        let point = CGPoint(
            x: center.x + radius * CGFloat(cos(radians)),
            y: center.y + radius * CGFloat(sin(radians))
        )
        return Circle()
            .fill(Color(uiColor: .systemBackground))
            .frame(width: lineWidth + 10, height: lineWidth + 10)
            .overlay(Circle().strokeBorder(mode.tint, lineWidth: 4))
            .shadow(color: .black.opacity(0.2), radius: 3, y: 1)
            .position(point)
            .opacity(isEnabled ? 1 : 0.35)
    }

    private var readout: some View {
        VStack(spacing: 2) {
            if let current {
                Text("\(Int(current.rounded()))° now")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
                    .contentTransition(.numericText(value: current))
            }

            HStack(alignment: .top, spacing: 0) {
                Text("\(Int(displayed.rounded()))")
                    .contentTransition(.numericText(value: displayed))
                Text("°").foregroundStyle(.secondary)
            }
            .font(.system(size: 60, weight: .semibold, design: .rounded))
            .monospacedDigit()
            .foregroundStyle(isEnabled ? mode.tint : Color.secondary)

            if let subtitle {
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                    .padding(.horizontal, 28)
            }
        }
    }

    private func dragGesture(center: CGPoint) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .updating($dragTarget) { value, state, _ in
                state = temperature(at: value.location, center: center)
            }
            .onEnded { value in
                commit(temperature(at: value.location, center: center))
            }
    }

    private func temperature(at location: CGPoint, center: CGPoint) -> Double {
        let dx = location.x - center.x
        let dy = location.y - center.y
        let degrees = atan2(dy, dx) * 180 / .pi

        var relative = (degrees - startDegrees).truncatingRemainder(dividingBy: 360)
        if relative < 0 { relative += 360 }

        // Touches landing in the 90° gap at the bottom snap to the nearer end
        // rather than wrapping the value around.
        if relative > sweepDegrees {
            let toEnd = relative - sweepDegrees
            let toStart = 360 - relative
            relative = toEnd < toStart ? sweepDegrees : 0
        }

        let value = range.lowerBound
            + (relative / sweepDegrees) * (range.upperBound - range.lowerBound)
        return min(max(value.rounded(), range.lowerBound), range.upperBound)
    }

    private func commit(_ value: Double) {
        guard value != target else { return }
        withAnimation(.smooth(duration: 0.2)) { target = value }
        onCommit(value)
    }

    private var accessibilityValue: String {
        var parts = ["\(Int(target.rounded())) degrees"]
        if let current { parts.append("currently \(Int(current.rounded())) degrees") }
        return parts.joined(separator: ", ")
    }
}
