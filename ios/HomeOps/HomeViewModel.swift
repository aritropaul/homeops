import Foundation
import Observation
import SwiftUI
import WidgetKit

/// Owns the app's live view of the home, talking to SmartRent directly.
///
/// `@MainActor` is applied explicitly rather than via module-wide default
/// isolation, because `Shared/` compiles into both the app and the widget
/// extension and must mean the same thing in each.
@MainActor
@Observable
public final class HomeViewModel {
    public enum Phase: Equatable {
        case idle
        case loading
        case loaded
        case failed(String)
    }

    public private(set) var snapshot: Snapshot?
    public private(set) var phase: Phase = .idle
    public private(set) var lastUpdated: Date?

    /// Informational result of the last action (not a failure).
    public private(set) var notice: String?
    public private(set) var failure: String?

    // The lock is never optimistically flipped; these track a real in-flight
    // command so the UI can show an explicit in-transit state.
    private(set) var inFlightLock: LockCommand?
    private(set) var lockCommandStartedAt: Date?

    /// Local setpoint drafts, keyed by device, so the dial tracks the finger
    /// without issuing a request per degree.
    public var setpointDrafts: [Int: Double] = [:]
    private var setpointTasks: [Int: Task<Void, Never>] = [:]

    public var biometricKind: BiometricKind { BiometricGate().availableBiometric() }

    private let credentials: SmartRentCredentials
    private let cache: SnapshotCache
    private let client: SmartRentClient

    public init(
        credentials: SmartRentCredentials = SmartRentCredentials(),
        cache: SnapshotCache = SnapshotCache(),
        client: SmartRentClient = SmartRentClient()
    ) {
        self.credentials = credentials
        self.cache = cache
        self.client = client
        if let cached = cache.load() {
            self.snapshot = cached
            self.lastUpdated = cached.fetchedAt
            self.phase = .loaded
        }
    }

    public var isConfigured: Bool { credentials.isConfigured }

    // MARK: - Lock

    public var lockPresentation: LockPresentation {
        guard let device = snapshot?.lock?.device else { return .unknown }
        return LockPresentation.resolve(
            device: device,
            inFlight: inFlightLock,
            commandStartedAt: lockCommandStartedAt
        )
    }

    // MARK: - Polling

    /// Refreshes while the calling view is on screen. `.task` cancels this
    /// automatically on disappear, ending the loop via the cancellation thrown
    /// from `Task.sleep`.
    public func pollWhileVisible(every interval: Duration = .seconds(10)) async {
        await refresh()
        while !Task.isCancelled {
            do { try await Task.sleep(for: interval) } catch { return }
            await refresh()
        }
    }

    public func refresh() async {
        guard isConfigured else {
            phase = .failed(SmartRentError.notConfigured.localizedDescription)
            return
        }
        if phase == .idle { phase = .loading }
        do {
            let fresh = try await client.snapshot()
            snapshot = fresh
            lastUpdated = .now
            phase = .loaded
            failure = nil
            cache.save(fresh)
            reloadWidgets()
            clearSettledLockCommand(against: fresh)
        } catch let error as SmartRentError {
            if case .cancelled = error { return }
            phase = .failed(error.localizedDescription)
            failure = error.localizedDescription
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    /// Drops the in-flight marker once SmartRent confirms the new state, or once
    /// it has clearly failed to.
    private func clearSettledLockCommand(against fresh: Snapshot) {
        guard let command = inFlightLock,
              let started = lockCommandStartedAt,
              let state = fresh.lock?.device.lockState else { return }
        let settled = switch command {
        case .lock: state == .locked
        case .unlock: state == .unlocked
        }
        if settled || Date.now.timeIntervalSince(started) > LockPresentation.transitTimeout * 2 {
            inFlightLock = nil
            lockCommandStartedAt = nil
        }
    }

    // MARK: - Actions

    /// Tap the lock control. Chooses lock vs unlock from the current state and
    /// gates unlocking behind biometrics.
    public func toggleLock() async {
        guard let command = lockPresentation.nextCommand else { return }
        await run(command)
    }

    public func run(_ command: LockCommand) async {
        guard let lock = snapshot?.lock else {
            failure = SmartRentError.deviceNotFound.localizedDescription
            return
        }

        if command.opensTheDoor {
            let outcome = await BiometricGate().authenticate(
                reason: "Confirm it's you before unlocking the door"
            )
            switch outcome {
            case .cancelled: return
            case .failed(let message): failure = message; return
            case .success: break
            }
        }

        inFlightLock = command
        lockCommandStartedAt = .now
        do {
            try await client.setLocked(command == .lock, deviceID: lock.deviceID)
            notice = command == .lock ? "Locking…" : "Unlocking…"
            await refresh()
        } catch {
            failure = (error as? SmartRentError)?.localizedDescription
                ?? error.localizedDescription
            inFlightLock = nil
            lockCommandStartedAt = nil
        }
    }

    // MARK: - Thermostats

    public func target(for entry: ThermostatEntry) -> Double {
        if let draft = setpointDrafts[entry.deviceID] { return draft }
        return entry.device.pendingTargetTempF ?? entry.device.targetTempF ?? 70
    }

    public func mode(for entry: ThermostatEntry) -> ThermostatMode {
        entry.device.pendingMode ?? entry.device.mode
    }

    /// Records a change locally and issues one request once the user stops
    /// adjusting, so a drag doesn't fire a write per degree.
    public func setTarget(_ value: Double, for entry: ThermostatEntry) {
        setpointDrafts[entry.deviceID] = value
        setpointTasks[entry.deviceID]?.cancel()
        setpointTasks[entry.deviceID] = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(700)) } catch { return }
            guard let self, !Task.isCancelled else { return }

            let mode = self.mode(for: entry)
            // A setpoint is meaningless while off; default to cool so the write
            // actually does something rather than silently no-op.
            let writeMode: ThermostatMode = (mode == .off || mode == .unknown) ? .cool : mode
            do {
                try await self.client.setThermostatTarget(
                    Int(value.rounded()), mode: writeMode, deviceID: entry.deviceID
                )
                await self.refresh()
            } catch {
                self.failure = (error as? SmartRentError)?.localizedDescription
                    ?? error.localizedDescription
            }
            self.setpointDrafts[entry.deviceID] = nil
        }
    }

    public func setMode(_ mode: ThermostatMode, for entry: ThermostatEntry) async {
        do {
            if mode == .off {
                try await client.setThermostatMode(.off, deviceID: entry.deviceID)
            } else {
                try await client.setThermostatTarget(
                    Int(target(for: entry).rounded()), mode: mode, deviceID: entry.deviceID
                )
            }
            await refresh()
        } catch {
            failure = (error as? SmartRentError)?.localizedDescription
                ?? error.localizedDescription
        }
    }

    // MARK: - Banners

    public func dismissNotice() { notice = nil }
    public func dismissFailure() { failure = nil }

    private func reloadWidgets() {
        WidgetCenter.shared.reloadAllTimelines()
        ControlCenter.shared.reloadAllControls()
    }
}
