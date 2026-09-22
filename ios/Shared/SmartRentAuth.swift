import Foundation

/// SmartRent credentials and token lifecycle.
///
/// The app talks to SmartRent directly, so it holds the account credentials
/// itself. They live in the shared Keychain (readable by the widget extension),
/// written with `AfterFirstUnlockThisDeviceOnly` so a Lock Screen widget can
/// still refresh while the phone is locked.
public struct SmartRentCredentials: Sendable {
    private static let emailAccount = "smartrent.email"
    private static let passwordAccount = "smartrent.password"
    private static let refreshAccount = "smartrent.refreshToken"

    private let keychain: Keychain

    public init(keychain: Keychain = Keychain()) {
        self.keychain = keychain
    }

    public var email: String? {
        get { keychain.string(account: Self.emailAccount) }
        nonmutating set { write(newValue, Self.emailAccount) }
    }

    public var password: String? {
        get { keychain.string(account: Self.passwordAccount) }
        nonmutating set { write(newValue, Self.passwordAccount) }
    }

    /// Persisted so a relaunch doesn't need to re-send the password.
    public var refreshToken: String? {
        get { keychain.string(account: Self.refreshAccount) }
        nonmutating set { write(newValue, Self.refreshAccount) }
    }

    private func write(_ value: String?, _ account: String) {
        if let value, !value.isEmpty {
            keychain.set(value, account: account)
        } else {
            keychain.remove(account: account)
        }
    }

    public var isConfigured: Bool {
        guard let email, !email.isEmpty, let password, !password.isEmpty else { return false }
        return true
    }

    public func clear() {
        keychain.remove(account: Self.emailAccount)
        keychain.remove(account: Self.passwordAccount)
        keychain.remove(account: Self.refreshAccount)
    }
}

/// Holds the access token and refreshes it on demand.
///
/// This is an `actor` because it is the one piece of the client with real
/// shared mutable state: several callers (a view refresh, a widget timeline, an
/// intent) can discover an expired token at the same moment, and without
/// serialisation they would each start their own login. The actor also gives
/// single-flight refresh for free.
public actor SmartRentSession {
    private struct Token {
        let value: String
        let expiresAt: Date
    }

    private var token: Token?
    private var hubID: Int?
    private let credentials: SmartRentCredentials
    private let session: URLSession

    public init(
        credentials: SmartRentCredentials = SmartRentCredentials(),
        session: URLSession = SmartRentSession.makeSession()
    ) {
        self.credentials = credentials
        self.session = session
    }

    public static func makeSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 10
        config.timeoutIntervalForResource = 20
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }

    /// A valid access token, refreshing or logging in as needed.
    public func accessToken() async throws -> String {
        if let token, token.expiresAt > Date.now.addingTimeInterval(60) {
            return token.value
        }
        if let refresh = credentials.refreshToken {
            do { return try await refreshSession(refresh) } catch {
                // A dead refresh token is normal; fall through to a full login.
                credentials.refreshToken = nil
            }
        }
        return try await login()
    }

    /// Forces a fresh token after a 401.
    public func invalidate() {
        token = nil
    }

    private func login() async throws -> String {
        guard let email = credentials.email, let password = credentials.password,
              !email.isEmpty, !password.isEmpty else {
            throw SmartRentError.notConfigured
        }

        var request = URLRequest(url: SmartRentAPI.base.appendingPathComponent("authentication/sessions"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(SmartRentAPI.userAgent, forHTTPHeaderField: "User-Agent")
        request.httpBody = try JSONEncoder().encode(["email": email, "password": password])

        let response: SessionResponse = try await SmartRentAPI.send(request, session: session)
        if response.tfa_api_token != nil {
            throw SmartRentError.twoFactorRequired
        }
        store(response)
        return response.access_token
    }

    private func refreshSession(_ refreshToken: String) async throws -> String {
        var request = URLRequest(url: SmartRentAPI.base.appendingPathComponent("api/v2/tokens"))
        request.httpMethod = "POST"
        request.setValue(refreshToken, forHTTPHeaderField: "authorization-x-refresh")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(SmartRentAPI.userAgent, forHTTPHeaderField: "User-Agent")

        let response: SessionResponse = try await SmartRentAPI.send(request, session: session)
        store(response)
        return response.access_token
    }

    private func store(_ response: SessionResponse) {
        // Prefer the server's expiry; fall back to a conservative 14 minutes.
        let expiresAt = response.expires.map { Date(timeIntervalSince1970: $0) }
            ?? Date.now.addingTimeInterval(14 * 60)
        token = Token(value: response.access_token, expiresAt: expiresAt)
        if let refresh = response.refresh_token {
            credentials.refreshToken = refresh
        }
    }

    /// The hub for this account's unit, cached for the process lifetime.
    public func hub() async throws -> Int {
        if let hubID { return hubID }
        let hubs: [Hub] = try await get("api/v2/hubs")
        guard let first = hubs.first else { throw SmartRentError.noHub }
        hubID = first.id
        return first.id
    }

    // MARK: - Authenticated requests

    public func get<T: Decodable>(_ path: String) async throws -> T {
        try await authorized(path: path, method: "GET", body: nil)
    }

    public func patch<T: Decodable>(_ path: String, body: Data) async throws -> T {
        try await authorized(path: path, method: "PATCH", body: body)
    }

    private func authorized<T: Decodable>(
        path: String,
        method: String,
        body: Data?,
        retryOn401: Bool = true
    ) async throws -> T {
        let token = try await accessToken()
        var request = URLRequest(url: SmartRentAPI.base.appendingPathComponent(path))
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(SmartRentAPI.userAgent, forHTTPHeaderField: "User-Agent")
        request.httpBody = body

        do {
            return try await SmartRentAPI.send(request, session: session)
        } catch SmartRentError.unauthorized where retryOn401 {
            invalidate()
            return try await authorized(path: path, method: method, body: body, retryOn401: false)
        }
    }

    struct SessionResponse: Decodable {
        let access_token: String
        let refresh_token: String?
        let expires: Double?
        let tfa_api_token: String?
    }

    struct Hub: Decodable {
        let id: Int
        let unit_id: Int?
    }
}
