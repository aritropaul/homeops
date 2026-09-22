import SwiftUI

/// Compact row for the dashboard. Summary only — adjustment happens in detail.
struct ThermostatCard: View {
    let entry: ThermostatEntry

    private var device: ThermostatDevice? { entry.device }
    private var mode: ThermostatMode { entry.device.pendingMode ?? entry.device.mode }

    var body: some View {
        HStack(spacing: 14) {
            ZStack {
                Circle()
                    .fill(mode.tint.opacity(0.15))
                    .frame(width: 44, height: 44)
                Image(systemName: mode.symbolName)
                    .foregroundStyle(mode.tint)
                    .symbolEffect(.variableColor.iterative, isActive: isActivelyRunning)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(entry.displayName).font(.headline)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer()

            VStack(alignment: .trailing, spacing: 2) {
                if let current = device?.currentTempF, device?.online == true {
                    Text("\(Int(current.rounded()))°")
                        .font(.title3.weight(.semibold))
                        .contentTransition(.numericText(value: current))
                } else {
                    Text("—").font(.title3.weight(.semibold)).foregroundStyle(.secondary)
                }
                // Suppressed when offline: a target implies a live reading.
                if let target = device?.targetTempF, mode != .off, device?.online == true {
                    Text("to \(Int(target.rounded()))°")
                        .font(.caption2)
                        .foregroundStyle(mode.tint)
                }
            }

            if device?.hasPendingWrite == true {
                ProgressView().controlSize(.small)
            }

            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .padding(16)
        .background(.background.secondary, in: ConcentricRectangle())
        .opacity(device?.online == false ? 0.55 : 1)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Double-tap to adjust \(entry.displayName).")
    }

    private var isActivelyRunning: Bool {
        guard let device, let current = device.currentTempF, let target = device.targetTempF else {
            return false
        }
        return switch mode {
        case .heat: current < target - 0.5
        case .cool: current > target + 0.5
        default: false
        }
    }

    private var subtitle: String {
        if device?.online == false { return "Unreachable" }
        if let humidity = device?.humidityPct {
            return "\(mode.displayName) · \(Int(humidity))% RH"
        }
        return mode.displayName
    }
}

/// Full control for one room.
struct ThermostatDetailView: View {
    let entry: ThermostatEntry
    @Bindable var model: HomeViewModel

    /// Local drafts. These are deliberately plain `@State` rather than bindings
    /// that write through to the view model: a binding whose setter performs a
    /// network call will fire whenever SwiftUI writes back through it, which can
    /// happen during view setup — and a spurious write here physically changes a
    /// thermostat. Requests originate only from explicit user commits below.
    @State private var draftTarget: Double = 70
    @State private var draftMode: ThermostatMode = .off

    /// Always read through the live snapshot so the view follows refreshes.
    private var live: ThermostatEntry { model.snapshot?.thermostats.first { $0.deviceID == entry.deviceID } ?? entry }
    private var device: ThermostatDevice { live.device }
    private var serverMode: ThermostatMode { model.mode(for: live) }

    var body: some View {
        ScrollView {
            VStack(spacing: 22) {
                Picker("Mode", selection: $draftMode) {
                    ForEach([ThermostatMode.off, .heat, .cool, .auto], id: \.self) { mode in
                        Label(mode.displayName, systemImage: mode.symbolName).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .onChange(of: draftMode) { previous, next in
                    // Only act on a genuine change away from what the server
                    // already reports, never on the initial sync.
                    guard previous != next, next != serverMode else { return }
                    Task { await model.setMode(next, for: live) }
                }

                TemperatureDial(
                    target: $draftTarget,
                    current: device.currentTempF,
                    mode: draftMode,
                    subtitle: dialSubtitle,
                    isEnabled: draftMode != .off && device.online,
                    onCommit: { value in model.setTarget(value, for: live) }
                )
                .padding(.horizontal, 28)

                stepper
                secondaryStats
            }
            .padding()
        }
        .navigationTitle(live.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { syncDrafts() }
        .onChange(of: model.snapshot) { _, _ in syncDrafts() }
    }

    /// Adopts the server's values, unless the user has an uncommitted local
    /// change in flight — pulling the dial back under their finger mid-drag is
    /// worse than briefly showing a value the server hasn't caught up to.
    private func syncDrafts() {
        let pendingLocalEdit = model.setpointDrafts[live.deviceID] != nil
        if !pendingLocalEdit {
            draftTarget = model.target(for: live)
        }
        let resolved = serverMode == .unknown ? .off : serverMode
        if draftMode != resolved, !pendingLocalEdit {
            draftMode = resolved
        }
    }

    private var dialSubtitle: String? {
        if !device.online { return "Unreachable" }
        if draftMode == .off { return "Off" }
        if device.hasPendingWrite { return "Applying…" }
        return nil
    }

    private var stepper: some View {
        HStack(spacing: 28) {
            stepButton("minus", delta: -1)
            Text("Adjust").font(.footnote).foregroundStyle(.secondary)
            stepButton("plus", delta: 1)
        }
        .disabled(draftMode == .off)
    }

    private func stepButton(_ symbol: String, delta: Double) -> some View {
        Button {
            let next = min(max(draftTarget + delta, 50), 85)
            guard next != draftTarget else { return }
            draftTarget = next
            model.setTarget(next, for: live)
        } label: {
            Image(systemName: symbol)
                .font(.title3.weight(.semibold))
                .frame(width: 52, height: 44)
        }
        .buttonStyle(.glass)
        .accessibilityLabel(delta > 0 ? "Increase target" : "Decrease target")
    }

    @ViewBuilder
    private var secondaryStats: some View {
        if let humidity = device.humidityPct {
            Label("\(Int(humidity))% humidity", systemImage: "humidity.fill")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }
}
