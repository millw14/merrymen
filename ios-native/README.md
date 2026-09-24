# Merrymen native iOS — development preview

SwiftUI application for iPhone and iPad, iOS 17+. Product screens are native; there is no web-view shell. The current web application on trusted main is the parity reference. This is **not a feature-complete release**.

## Build

On a Mac with Xcode 16.4 or later and XcodeGen:

```sh
cd ios-native
swift test --package-path Policy
xcodegen generate
xcodebuild test -project Merrymen.xcodeproj -scheme Merrymen \
  -destination 'platform=iOS Simulator,name=iPhone 16,OS=18.5' \
  CODE_SIGNING_ALLOWED=NO
```

The Native iOS workflow runs this unsigned simulator build. No Apple account or production credential is required for it. `Merrymen.xcodeproj` is generated, not checked in.

For device signing, set `DEVELOPMENT_TEAM` and your selected bundle identifier in Xcode or build settings. Milla will provide the team configuration separately.

## Public authentication configuration

- `PRIVY_APP_ID`: `cmtnun9wn00rg0dl5txyoxpju`, retrieved from the production web service's public configuration with Milla's authorization.
- `PRIVY_CLIENT_ID`: **not present in that environment**. Register/configure an iOS client for this Privy app and supply its public client ID as an Xcode build setting. Register the selected bundle identifier and `merrymen` callback scheme in Privy.
- No Privy app secret, server key, Apple certificate, signing key, or production database credential belongs in this project.

Privy 2.16.2 is pinned. Native email code and X OAuth call the existing `/api/auth/privy` challenge/signature exchange. These authenticated flows still need end-to-end validation after the iOS client exists. A missing client ID disables native sign-in explicitly; it does not substitute a web login.

## Implemented surfaces (verification tracked separately)

- Home, Chat, Feed, Alpha and Profile tabs; native navigation, search, public agent/token detail, markets and device watchlist.
- Thesis text, paper labels, outcome text, following, likes and sharing.
- Leaderboard, unknown-value handling, public holdings and portfolio views.
- Native email/X sign-in integration, Keychain session cookies, no cross-host redirects, sign-out and foreground privacy cover.
- Group chat with incremental polling, older history, reply pointers, take-back, stable message retry IDs, mute and time zone preferences.
- Partial account settings with explicit review, changed fields only and owner binding. Telegram status and linking code; Circle tier reads.
- Profile image selection/upload/removal; account address, QR and deposit balance; grant status and stand-down confirmation.
- Order request confirmation, owner binding, persisted pending submission, ledger polling and structured status. Submission is never retried automatically. No live trade was placed during implementation.
- Tour and native app links. Existing product artwork and font files copied with their licenses.

## Release blockers / parity work remaining

The checklist in [PARITY.md](PARITY.md) is authoritative. In particular: smart-account creation, permission renewal and withdrawal are not implemented; recovery and external wallet support are not implemented; complete settings and all languages are not ported. Native signing must retain Kernel v3.3 derivation, grant binding, owner possession, adapter verification, custody, caps and durable transaction semantics. Do not replace those checks with an unverified native approximation.

Do not distribute this as the full Merrymen app or enable real-money acceptance testing until the signing integration and authenticated testing are complete. The disabled signing screen explains the development state.

UI tests use explicit debug-only fixtures; release builds cannot activate that transport. Passing those tests proves native navigation and parsing behavior, not production authentication, fills, or wallet operations. Privacy manifest declarations and App Store data disclosures require a release audit including Privy's manifest and the final data collection paths.
