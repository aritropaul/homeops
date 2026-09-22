import SwiftUI

struct DashboardView: View {
    @Bindable var model: HomeViewModel
    @Binding var route: AppRoute?

    @State private var showSettings = false
    @State private var showDiagnostics = false

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 16) {
                if !model.isConfigured {
                    setupPrompt
                } else {
                    banners
                    lockSection.appearStaggered(index: 0)
                    climateSection.appearStaggered(index: 1)
                }
            }
            .padding()
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationTitle("HomeOps")
        .navigationSubtitle(subtitleText)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Diagnostics", systemImage: "waveform.path.ecg") {
                    showDiagnostics = true
                }
            }
            ToolbarSpacer(.fixed, placement: .primaryAction)
            ToolbarItem(placement: .primaryAction) {
                Button("Settings", systemImage: "gearshape") { showSettings = true }
            }
        }
        .refreshable { await model.refresh() }
        .task { await model.pollWhileVisible() }
        .sheet(isPresented: $showSettings) { SettingsView(model: model) }
        .sheet(isPresented: $showDiagnostics) { DiagnosticsView(model: model) }
        .navigationDestination(item: $route) { route in
            switch route {
            case .thermostat(let deviceID):
                // A deep link can land before the first fetch returns, so an
                // absent snapshot means "still loading", not "doesn't exist".
                // Declaring not-found here would make every cold widget tap
                // dead-end.
                if let entry = model.snapshot?.thermostats.first(where: { $0.deviceID == deviceID }) {
                    ThermostatDetailView(entry: entry, model: model)
                } else if model.snapshot == nil {
                    ProgressView()
                        .controlSize(.large)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(Color(uiColor: .systemGroupedBackground))
                        .task { await model.refresh() }
                } else {
                    ContentUnavailableView(
                        "Thermostat not found",
                        systemImage: "thermometer.medium.slash",
                        description: Text("That thermostat is no longer on your hub.")
                    )
                }
            }
        }
    }

    // MARK: Sections

    private var setupPrompt: some View {
        ContentUnavailableView {
            Label("Sign in to SmartRent", systemImage: "person.badge.key")
        } description: {
            Text("HomeOps talks to your SmartRent account directly. Sign in to control the apartment.")
        } actions: {
            Button("Open Settings") { showSettings = true }
                .buttonStyle(.glassProminent)
        }
        .padding(.top, 60)
    }

    /// Persistent conditions only. Anything transient is a toast — a message
    /// that disappears is the wrong way to report a state that hasn't.
    @ViewBuilder
    private var banners: some View {
        if case .failed(let message) = model.phase, model.snapshot == nil {
            Banner(text: message, tint: .red, symbol: "exclamationmark.triangle.fill")
        }
        if let snapshot = model.snapshot, snapshot.isStale {
            Banner(
                text: "These readings are more than a few minutes old.",
                tint: .yellow,
                symbol: "clock.badge.exclamationmark.fill"
            )
        }
    }

    private var lockSection: some View {
        LockCard(
            name: model.snapshot?.lock?.name ?? "Front Door",
            presentation: model.lockPresentation,
            batteryPct: model.snapshot?.lock?.device.batteryPct,
            lastNotification: model.snapshot?.lock?.device.lastNotification,
            reachability: model.snapshot?.lock?.device.reachability ?? .live,
            biometric: model.biometricKind,
            onTap: { Task { await model.toggleLock() } },
            onLock: { Task { await model.run(.lock) } },
            onUnlock: { Task { await model.run(.unlock) } }
        )
    }

    @ViewBuilder
    private var climateSection: some View {
        let thermostats = model.snapshot?.thermostats ?? []
        if !thermostats.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text("Climate").font(.subheadline.weight(.semibold))
                ForEach(thermostats) { entry in
                    Button {
                        route = .thermostat(deviceID: entry.deviceID)
                    } label: {
                        ThermostatCard(entry: entry)
                    }
                    .buttonStyle(PressableCardStyle())
                }
            }
        }
    }

    /// `.relative(presentation: .numeric)` renders "in 0 seconds" for a
    /// just-completed fetch, which reads like a bug. Handle the recent case.
    static func freshness(_ date: Date, now: Date = .now) -> String {
        let elapsed = now.timeIntervalSince(date)
        if elapsed < 10 { return "just now" }
        if elapsed < 60 { return "\(Int(elapsed))s ago" }
        if elapsed < 3600 { return "\(Int(elapsed / 60))m ago" }
        return date.formatted(date: .omitted, time: .shortened)
    }

    private var subtitleText: String {
        guard model.isConfigured else { return "Not signed in" }
        guard let lastUpdated = model.lastUpdated else { return "Connecting…" }
        return "Updated \(Self.freshness(lastUpdated))"
    }
}

// MARK: - Small pieces

struct Banner: View {
    let text: String
    let tint: Color
    let symbol: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: symbol)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(tint)
            Text(text)
                .font(.footnote)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(12)
        .background(tint.opacity(0.12), in: ConcentricRectangle())
        .accessibilityElement(children: .combine)
    }
}

/// A short, one-shot entrance for the first paint.
///
/// Purely decorative, so it is short (280ms), staggered by only 60ms, never
/// blocks interaction, and collapses to a plain fade under Reduce Motion.
private struct StaggeredAppear: ViewModifier {
    let index: Int
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown = false

    func body(content: Content) -> some View {
        content
            .opacity(shown ? 1 : 0)
            .offset(y: shown || reduceMotion ? 0 : 8)
            .animation(
                reduceMotion
                    ? .easeOut(duration: 0.2)
                    : .spring(duration: 0.28, bounce: 0)
                        .delay(Double(index) * 0.06),
                value: shown
            )
            .onAppear { shown = true }
    }
}

extension View {
    func appearStaggered(index: Int) -> some View {
        modifier(StaggeredAppear(index: index))
    }
}
