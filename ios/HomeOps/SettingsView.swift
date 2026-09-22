import SwiftUI

struct SettingsView: View {
    @Bindable var model: HomeViewModel
    @Environment(\.dismiss) private var dismiss

    @State private var email: String = ""
    @State private var password: String = ""
    @State private var testResult: TestResult?
    @State private var isTesting = false

    private let credentials = SmartRentCredentials()

    enum TestResult: Equatable {
        case success(String)
        case failure(String)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Email") {
                        TextField("you@example.com", text: $email)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.emailAddress)
                            .multilineTextAlignment(.trailing)
                    }
                    LabeledContent("Password") {
                        SecureField("SmartRent password", text: $password)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .multilineTextAlignment(.trailing)
                    }
                } header: {
                    Text("SmartRent account")
                } footer: {
                    Text("HomeOps talks to SmartRent directly — there is no server in between. Credentials are stored in the shared keychain so widgets and Control Center can use them too, and never in a file or plist.")
                }

                Section {
                    Button {
                        Task { await test() }
                    } label: {
                        HStack {
                            Text("Test sign-in")
                            Spacer()
                            if isTesting { ProgressView().controlSize(.small) }
                        }
                    }
                    .disabled(isTesting || email.isEmpty || password.isEmpty)

                    if let testResult {
                        switch testResult {
                        case .success(let message):
                            Label(message, systemImage: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                                .font(.footnote)
                        case .failure(let message):
                            Label(message, systemImage: "exclamationmark.triangle.fill")
                                .foregroundStyle(.red)
                                .font(.footnote)
                        }
                    }
                }

                Section {
                    LabeledContent("Biometric", value: model.biometricKind.displayName)
                } header: {
                    Text("Security")
                } footer: {
                    Text("Unlocking the door always requires \(model.biometricKind.displayName), in the app and from widgets. Locking never does.")
                }

                Section {
                    Button("Sign out", role: .destructive) {
                        credentials.clear()
                        SnapshotCache().clear()
                        email = ""
                        password = ""
                        testResult = nil
                    }
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(role: .close) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save() }
                }
            }
            .onAppear {
                email = credentials.email ?? ""
                password = credentials.password ?? ""
            }
        }
    }

    private func save() {
        credentials.email = email.trimmingCharacters(in: .whitespacesAndNewlines)
        credentials.password = password
        Task { await model.refresh() }
        dismiss()
    }

    private func test() async {
        isTesting = true
        defer { isTesting = false }

        // Persist first: the client reads credentials from the keychain.
        credentials.email = email.trimmingCharacters(in: .whitespacesAndNewlines)
        credentials.password = password

        do {
            let snapshot = try await SmartRentClient().snapshot()
            let lock = snapshot.lock == nil ? "no lock" : "1 lock"
            testResult = .success(
                "Signed in — found \(lock) and \(snapshot.thermostats.count) thermostats."
            )
        } catch let error as SmartRentError {
            testResult = .failure(error.localizedDescription)
        } catch {
            testResult = .failure(error.localizedDescription)
        }
    }
}

/// What the hub actually returned, for when something looks wrong.
struct DiagnosticsView: View {
    @Bindable var model: HomeViewModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                connectionSection
                lockSection
                thermostatSection
                errorSection
            }
            .navigationTitle("Diagnostics")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(role: .close) { dismiss() }
                }
            }
        }
    }

    private var connectionSection: some View {
        Section("Connection") {
            row("Account", SmartRentCredentials().email ?? "Not signed in")
            row("Last refresh", lastRefreshText)
            if let snapshot = model.snapshot {
                row("Snapshot age", "\(Int(snapshot.age))s")
            }
        }
    }

    @ViewBuilder
    private var lockSection: some View {
        if let lock = model.snapshot?.lock {
            Section("Lock") {
                row("Name", lock.name)
                row("Device ID", String(lock.deviceID))
                row("State", lock.device.lockState.rawValue)
                row("Online", lock.device.online ? "Yes" : "No")
                if let battery = lock.device.batteryPct {
                    row("Battery", "\(battery)%")
                }
                if let note = lock.device.lastNotification {
                    row("Last event", note)
                }
            }
        }
    }

    private var thermostatSection: some View {
        Section("Thermostats") {
            ForEach(model.snapshot?.thermostats ?? []) { entry in
                VStack(alignment: .leading, spacing: 3) {
                    Text(entry.name).font(.footnote.weight(.semibold))
                    Text(detail(for: entry))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    @ViewBuilder
    private var errorSection: some View {
        if let failure = model.lastError {
            Section("Last error") {
                Text(failure).font(.footnote).foregroundStyle(.red)
            }
        }
    }

    private func detail(for entry: ThermostatEntry) -> String {
        let online = entry.device.online ? "online" : "offline"
        return "id \(entry.deviceID) · \(entry.device.mode.rawValue) · \(online)"
    }

    private var lastRefreshText: String {
        guard let lastUpdated = model.lastUpdated else { return "Never" }
        return lastUpdated.formatted(date: .omitted, time: .standard)
    }

    private func row(_ label: String, _ value: String) -> some View {
        LabeledContent(label) { Text(value).foregroundStyle(.secondary) }
            .font(.footnote)
    }
}
