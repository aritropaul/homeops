import AppIntents
import SwiftUI
import WidgetKit

@main
struct HomeOpsWidgetBundle: WidgetBundle {
    var body: some Widget {
        LockWidget()
        ClimateWidget()
        OverviewWidget()
        // WidgetBundleBuilder adapts ControlWidget automatically.
        LockControl()
    }
}

// MARK: - Timeline plumbing

struct HomeEntry: TimelineEntry {
    let date: Date
    let snapshot: Snapshot?
    let isStale: Bool
    /// Set when nobody has signed in yet, so widgets say so rather than look broken.
    let needsSetup: Bool
}

/// Reads the App Group cache first so the widget renders instantly, then makes
/// one deadline-bounded network call. Widget extensions are memory- and
/// time-constrained and are watchdog-killed rather than politely timed out, so
/// the network call can never be allowed to hang.
struct HomeProvider: TimelineProvider {
    func placeholder(in context: Context) -> HomeEntry {
        HomeEntry(date: .now, snapshot: .preview, isStale: false, needsSetup: false)
    }

    func getSnapshot(in context: Context, completion: @escaping @Sendable (HomeEntry) -> Void) {
        let cached = SnapshotCache().load()
        if context.isPreview || cached == nil {
            completion(HomeEntry(date: .now, snapshot: .preview, isStale: false, needsSetup: false))
            return
        }
        completion(
            HomeEntry(
                date: .now,
                snapshot: cached,
                isStale: cached?.isStale ?? true,
                needsSetup: !SmartRentCredentials().isConfigured
            )
        )
    }

    func getTimeline(in context: Context, completion: @escaping @Sendable (Timeline<HomeEntry>) -> Void) {
        Task {
            let cache = SnapshotCache()

            guard SmartRentCredentials().isConfigured else {
                completion(Timeline(
                    entries: [HomeEntry(date: .now, snapshot: nil, isStale: false, needsSetup: true)],
                    policy: .after(.now.addingTimeInterval(1800))
                ))
                return
            }

            var snapshot = cache.load()
            var stale = snapshot?.isStale ?? true

            if let fresh = try? await withDeadline(seconds: 6, { try await SmartRentClient().snapshot() }) {
                cache.save(fresh)
                snapshot = fresh
                stale = false
            }

            let entry = HomeEntry(date: .now, snapshot: snapshot, isStale: stale, needsSetup: false)
            // Periodic reloads draw on a limited daily budget, so refresh on a
            // conservative cadence; interaction-driven reloads are free and do
            // the real work of keeping this current.
            completion(Timeline(entries: [entry], policy: .after(.now.addingTimeInterval(900))))
        }
    }
}

// MARK: - Lock widget

struct LockWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: HomeOpsIdentifiers.WidgetKind.lock, provider: HomeProvider()) { entry in
            LockWidgetView(entry: entry)
        }
        .configurationDisplayName("Front Door")
        .description("Lock state at a glance, with one-tap locking.")
        .supportedFamilies([
            .systemSmall, .accessoryCircular, .accessoryRectangular, .accessoryInline,
        ])
    }
}

struct LockWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: HomeEntry

    private var presentation: LockPresentation {
        guard let device = entry.snapshot?.lock?.device else { return .unknown }
        return LockPresentation.resolve(device: device, inFlight: nil, commandStartedAt: nil)
    }

    var body: some View {
        switch family {
        case .accessoryInline:
            Label(presentation.title, systemImage: presentation.symbolName)

        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                Image(systemName: presentation.symbolName).font(.title3)
            }
            .widgetAccentable()

        case .accessoryRectangular:
            VStack(alignment: .leading, spacing: 2) {
                Label("Front Door", systemImage: presentation.symbolName)
                    .font(.headline)
                Text(presentation.title).font(.caption)
                if let primary = entry.snapshot?.primaryThermostat,
                   let temp = primary.device.currentTempF {
                    Text("\(primary.name) \(Int(temp.rounded()))°").font(.caption2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

        default:
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Image(systemName: presentation.symbolName)
                        .font(.title)
                        .foregroundStyle(presentation.tint)
                    Spacer()
                    if entry.isStale {
                        Image(systemName: "clock.badge.exclamationmark")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                Text(presentation.title).font(.headline)
                Spacer()
                // Only locking is offered headlessly. Unlocking needs Face ID,
                // which cannot run in a widget process.
                if presentation == .unlocked || presentation == .jammed {
                    Button(intent: LockDoorIntent()) {
                        Label("Lock", systemImage: "lock.fill")
                            .font(.caption.weight(.semibold))
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                } else {
                    Text(entry.needsSetup ? "Open HomeOps to set up" : "Tap to open HomeOps")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .widgetURL(URL(string: "\(HomeOpsIdentifiers.urlScheme)://home"))
            .containerBackground(.fill.tertiary, for: .widget)
        }
    }
}

// MARK: - Climate widget

struct ClimateWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: HomeOpsIdentifiers.WidgetKind.climate, provider: HomeProvider()) { entry in
            ClimateWidgetView(entry: entry)
        }
        .configurationDisplayName("Climate")
        .description("A thermostat's current and target temperature.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular])
    }
}

struct ClimateWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: HomeEntry

    private var primary: ThermostatEntry? { entry.snapshot?.primaryThermostat }
    private var device: ThermostatDevice? { primary?.device }
    private var mode: ThermostatMode { device?.mode ?? .unknown }

    var body: some View {
        switch family {
        case .accessoryRectangular:
            VStack(alignment: .leading, spacing: 2) {
                Label(primary?.name ?? "Climate", systemImage: mode.symbolName).font(.headline)
                if let current = device?.currentTempF {
                    Text("\(Int(current.rounded()))° → \(Int((device?.targetTempF ?? current).rounded()))°")
                        .font(.caption)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

        default:
            VStack(alignment: .leading, spacing: 6) {
                Label(primary?.name ?? "Climate", systemImage: mode.symbolName)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)

                if let current = device?.currentTempF {
                    Text("\(Int(current.rounded()))°")
                        .font(.system(size: 40, weight: .semibold, design: .rounded))
                } else {
                    Text("—").font(.system(size: 40, weight: .semibold, design: .rounded))
                }

                if let target = device?.targetTempF, mode != .off {
                    Text("\(mode.displayName) to \(Int(target.rounded()))°")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .widgetURL(primary.flatMap {
                URL(string: "\(HomeOpsIdentifiers.urlScheme)://thermostat/\($0.deviceID)")
            })
            .containerBackground(.fill.tertiary, for: .widget)
        }
    }
}

// MARK: - Overview widget

struct OverviewWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: HomeOpsIdentifiers.WidgetKind.overview, provider: HomeProvider()) { entry in
            OverviewWidgetView(entry: entry)
        }
        .configurationDisplayName("Overview")
        .description("The door and all three thermostats.")
        .supportedFamilies([.systemMedium])
    }
}

struct OverviewWidgetView: View {
    let entry: HomeEntry

    private var presentation: LockPresentation {
        guard let device = entry.snapshot?.lock?.device else { return .unknown }
        return LockPresentation.resolve(device: device, inFlight: nil, commandStartedAt: nil)
    }

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Image(systemName: presentation.symbolName)
                    .font(.title2)
                    .foregroundStyle(presentation.tint)
                Text(presentation.title).font(.caption.weight(.semibold))
                if presentation == .unlocked {
                    Button(intent: LockDoorIntent()) {
                        Text("Lock").font(.caption2.weight(.semibold))
                    }
                    .buttonStyle(.bordered)
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Divider()

            VStack(alignment: .leading, spacing: 6) {
                ForEach(entry.snapshot?.thermostats ?? []) { thermostat in
                    HStack(spacing: 6) {
                        Image(systemName: thermostat.device.mode.symbolName)
                            .font(.caption2)
                            .frame(width: 14)
                        Text(thermostat.displayName).font(.caption2).lineLimit(1)
                        Spacer()
                        Text(thermostat.device.online
                             ? thermostat.device.currentTempF.map { "\(Int($0.rounded()))°" } ?? "—"
                             : "—")
                            .font(.caption2.weight(.semibold))
                            .monospacedDigit()
                    }
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity)
        }
        .containerBackground(.fill.tertiary, for: .widget)
    }
}

// MARK: - Previews


#Preview("Lock – small", as: .systemSmall) {
    LockWidget()
} timeline: {
    HomeEntry(date: .now, snapshot: .preview, isStale: false, needsSetup: false)
}

#Preview("Overview", as: .systemMedium) {
    OverviewWidget()
} timeline: {
    HomeEntry(date: .now, snapshot: .preview, isStale: false, needsSetup: false)
}
