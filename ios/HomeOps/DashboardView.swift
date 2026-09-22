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
                    lockSection
                    climateSection
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
                if let entry = model.snapshot?.thermostats.first(where: { $0.deviceID == deviceID }) {
                    ThermostatDetailView(entry: entry, model: model)
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

    @ViewBuilder
    private var banners: some View {
        if let notice = model.notice {
            Banner(text: notice, tint: .blue, symbol: "info.circle.fill") {
                model.dismissNotice()
            }
        }
        if let failure = model.failure {
            Banner(text: failure, tint: .red, symbol: "exclamationmark.triangle.fill") {
                model.dismissFailure()
            }
        }
        if let snapshot = model.snapshot, snapshot.isStale {
            Banner(
                text: "These readings are more than a few minutes old.",
                tint: .yellow,
                symbol: "clock.badge.exclamationmark.fill",
                onDismiss: nil
            )
        }
    }

    private var lockSection: some View {
        LockCard(
            name: model.snapshot?.lock?.name ?? "Front Door",
            presentation: model.lockPresentation,
            batteryPct: model.snapshot?.lock?.device.batteryPct,
            lastNotification: model.snapshot?.lock?.device.lastNotification,
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
                    .buttonStyle(.plain)
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
    var onDismiss: (() -> Void)?

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: symbol).foregroundStyle(tint)
            Text(text).font(.footnote).frame(maxWidth: .infinity, alignment: .leading)
            if let onDismiss {
                Button(role: .close, action: onDismiss)
                    .controlSize(.small)
            }
        }
        .padding(12)
        .background(tint.opacity(0.12), in: ConcentricRectangle())
    }
}
