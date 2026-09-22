# HomeOps for iOS

A native SwiftUI remote control for the apartment. It talks to **SmartRent
directly** — the HomeOps server is not in the path.

## Why it doesn't go through the server

The server still runs, and still owns auto-lock (the one rule that needs
something always-on, since iOS can't guarantee a background timer). But
everything interactive — reading device state, locking, setting temperatures —
is a direct SmartRent call from the phone. No `HOMEOPS_KEY`, no Fly dependency,
no `/status` contract to keep in sync.

Both the app and the server are independent SmartRent clients writing to the
same devices.

## Building

The Xcode project is generated, not checked in:

```sh
brew install xcodegen      # once
cd ios
xcodegen generate
xcodebuild -project HomeOps.xcodeproj -scheme HomeOps \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build
```

`project.yml` is the source of truth. `HomeOps.xcodeproj` and the two
`Info.plist` files are regenerated from it and are gitignored.

Requires Xcode 26+ / iOS 26 SDK. Deployment target is iOS 26.0 because the UI
uses Liquid Glass APIs (`ConcentricRectangle`, `.buttonStyle(.glass)`,
`ToolbarSpacer`, `.navigationSubtitle`, `.sensoryFeedback(.press(.toggle))`).

`DEVELOPMENT_TEAM` in `project.yml` is set to this account's team. Simulator
builds sign ad-hoc and need no provisioning profile.

## Running

Sign in with your SmartRent email and password in Settings. The app discovers
the hub and every device on it — nothing else is configured, and device ids are
never hardcoded.

For simulator runs, credentials can be seeded from the launch environment
instead of typed (DEBUG builds only):

```sh
SIMCTL_CHILD_SMARTRENT_EMAIL="…" \
SIMCTL_CHILD_SMARTRENT_PASSWORD="…" \
xcrun simctl launch --terminate-running-process "iPhone 17 Pro" dev.aritro.homeops
```

`SIMCTL_CHILD_HOMEOPS_SEED_ROUTE="thermostat/<deviceID>"` opens straight to a
thermostat, which is also how the widget deep link is tested.

## Layout

| Path | |
|---|---|
| `Shared/` | compiled into **both** the app and the widget extension |
| `HomeOps/` | app UI |
| `HomeOpsWidgets/` | widgets *and* Control Center controls (one extension) |
| `HomeOpsTests/` | unit tests — `xcodebuild test` |

## Things that are load-bearing

- **Keychain accessibility.** Credentials are written with
  `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. With the default
  `WhenUnlocked`, a widget refreshing on a locked phone fails with
  `errSecInteractionNotAllowed` — and the Simulator does not reproduce that, so
  it would only ever show up on a real device.
- **Unlocking is gated, locking is not.** Biometrics can't run in a background
  extension, so the unlock intent deliberately opens the app
  (`.foreground(.immediate)`) rather than executing headlessly. Never make it
  `.background`.
- **The lock is never optimistically flipped.** A tap moves it to an explicit
  in-transit state and only settles when SmartRent confirms, or decays to
  `.jammed` after 10s. Offline never renders as locked or unlocked.
- **Devices are addressed by SmartRent id, never by name.** The real devices are
  called things like `Aritro - Thermostat ` (trailing space) and
  `Sophia's controls` (typographic apostrophe). Siri uses a live `AppEntity`
  query so it works with whatever they're actually named.
- **Default actor isolation is pinned to `nonisolated`** in `project.yml`.
  `Shared/` compiles into two targets; letting them disagree would give the same
  file different isolation in each.
