import Foundation

public enum SmartRentError: Error, Sendable, LocalizedError {
    case notConfigured
    case unauthorized
    case twoFactorRequired
    case noHub
    case deviceNotFound
    case server(status: Int)
    case transport(URLError.Code, String)
    case decoding(String)
    case cancelled

    public var errorDescription: String? {
        switch self {
        case .notConfigured:
            "Sign in with your SmartRent account in Settings."
        case .unauthorized:
            "SmartRent rejected those credentials."
        case .twoFactorRequired:
            "This SmartRent account has two-factor auth enabled, which this app can't complete. Disable it to use HomeOps."
        case .noHub:
            "No SmartRent hub found on this account."
        case .deviceNotFound:
            "That device isn't on your SmartRent hub."
        case .server(let status):
            "SmartRent returned an error (HTTP \(status))."
        case .transport(let code, let description):
            switch code {
            case .notConnectedToInternet: "No internet connection."
            case .timedOut: "SmartRent didn't respond in time."
            case .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed:
                "Can't reach SmartRent."
            default: description
            }
        case .decoding:
            "SmartRent sent a response this app didn't understand."
        case .cancelled:
            "Cancelled."
        }
    }

    public var needsConfiguration: Bool {
        switch self {
        case .notConfigured, .unauthorized, .twoFactorRequired: true
        default: false
        }
    }
}

public enum SmartRentAPI {
    public static let base = URL(string: "https://control.smartrent.com")!
    public static let socketURL = "wss://control.smartrent.com/socket/websocket?vsn=2.0.0"
    public static let userAgent = "HomeOps-iOS/1.0"

    static func send<T: Decodable>(_ request: URLRequest, session: URLSession) async throws -> T {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError {
            if error.code == .cancelled { throw SmartRentError.cancelled }
            throw SmartRentError.transport(error.code, error.localizedDescription)
        } catch is CancellationError {
            throw SmartRentError.cancelled
        }

        guard let http = response as? HTTPURLResponse else {
            throw SmartRentError.decoding("Response was not HTTP")
        }
        if http.statusCode == 401 || http.statusCode == 403 {
            throw SmartRentError.unauthorized
        }
        guard (200..<300).contains(http.statusCode) else {
            throw SmartRentError.server(status: http.statusCode)
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw SmartRentError.decoding(String(describing: error))
        }
    }
}

// MARK: - Wire types

/// One attribute on a SmartRent device. `state` is the confirmed value;
/// `pending_state` is set while a write is in flight and the device hasn't
/// acknowledged it.
public struct SRAttribute: Decodable, Sendable {
    public let name: String
    public let state: String?
    public let pending_state: String?
}

public struct SRDevice: Decodable, Sendable {
    public let id: Int
    public let name: String
    public let type: String
    public let attributes: [SRAttribute]
    public let battery_level: Int?
    public let online: Bool?

    public func attribute(_ name: String) -> SRAttribute? {
        attributes.first { $0.name == name }
    }

    public func state(_ name: String) -> String? { attribute(name)?.state }
    public func pending(_ name: String) -> String? { attribute(name)?.pending_state }
}

/// The hub devices endpoint returns either a bare array or a paginated object.
enum SRDeviceList: Decodable {
    case array([SRDevice])
    case paged(records: [SRDevice])

    var devices: [SRDevice] {
        switch self {
        case .array(let d): d
        case .paged(let d): d
        }
    }

    init(from decoder: Decoder) throws {
        if let list = try? decoder.singleValueContainer().decode([SRDevice].self) {
            self = .array(list)
            return
        }
        struct Paged: Decodable { let records: [SRDevice] }
        let paged = try decoder.singleValueContainer().decode(Paged.self)
        self = .paged(records: paged.records)
    }
}

// MARK: - Client

/// Direct SmartRent client. No intermediary service.
///
/// `Sendable` and free of its own mutable state — the token and hub cache live
/// in the `SmartRentSession` actor — so the same instance is usable from the
/// app, a widget timeline provider, and an App Intent.
public struct SmartRentClient: Sendable {
    public let session: SmartRentSession

    public init(session: SmartRentSession = SmartRentSession()) {
        self.session = session
    }

    /// Every device on the account's hub.
    public func devices() async throws -> [SRDevice] {
        let hub = try await session.hub()
        let list: SRDeviceList = try await session.get("api/v2/hubs/\(hub)/devices")
        return list.devices
    }

    /// Fetches the hub once and assembles the app's view of the home.
    public func snapshot() async throws -> Snapshot {
        Snapshot(devices: try await devices(), fetchedAt: .now)
    }

    // MARK: Writes

    private func write(deviceID: Int, attributes: [(String, String)]) async throws {
        struct Body: Encodable {
            struct Attr: Encodable { let name: String; let state: String }
            let attributes: [Attr]
        }
        let body = try JSONEncoder().encode(
            Body(attributes: attributes.map { Body.Attr(name: $0.0, state: $0.1) })
        )
        // The response body is the updated device; we don't need it, but the
        // request must still be decoded to surface HTTP errors.
        let _: SRDevice = try await session.patch("api/v2/devices/\(deviceID)", body: body)
    }

    public func setLocked(_ locked: Bool, deviceID: Int) async throws {
        try await write(deviceID: deviceID, attributes: [("locked", locked ? "true" : "false")])
    }

    public func setThermostatMode(_ mode: ThermostatMode, deviceID: Int) async throws {
        guard mode != .unknown else { return }
        try await write(deviceID: deviceID, attributes: [("mode", mode.rawValue)])
    }

    /// Writes the setpoint that matches the mode, then the mode itself — the
    /// same ordering the device expects for the change to take in one go.
    public func setThermostatTarget(
        _ tempF: Int,
        mode: ThermostatMode,
        deviceID: Int
    ) async throws {
        var attributes: [(String, String)] = []
        if mode == .heat || mode == .auto {
            attributes.append(("heating_setpoint", String(tempF)))
        }
        if mode == .cool || mode == .auto {
            attributes.append(("cooling_setpoint", String(tempF)))
        }
        guard !attributes.isEmpty else { return }
        attributes.append(("mode", mode.rawValue))
        try await write(deviceID: deviceID, attributes: attributes)
    }
}

/// Races an operation against a deadline. Widget extensions have no documented
/// execution budget and are watchdog-killed rather than politely timed out, so
/// every network call made from an extension goes through this.
public func withDeadline<T: Sendable>(
    seconds: Double,
    _ operation: @escaping @Sendable () async throws -> T
) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask { try await operation() }
        group.addTask {
            try await Task.sleep(for: .seconds(seconds))
            throw SmartRentError.transport(.timedOut, "Timed out")
        }
        defer { group.cancelAll() }
        guard let first = try await group.next() else {
            throw SmartRentError.transport(.timedOut, "Timed out")
        }
        return first
    }
}
