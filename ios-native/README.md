# Merrymen native iOS — development preview

Native SwiftUI screens for iPhone and iPad, iOS 17+. The app shares Merrymen's live API, artwork, fonts, published copy and core presentation rules. There is no WebView shell. This is a **development preview, not a release with verified full parity**. The exact boundary is recorded in [PARITY.md](PARITY.md).

## Build and test

Use Xcode 26.2 and XcodeGen on a Mac. The pinned Privy 2.16.2 binary requires the Swift 6.2 toolchain. Generate the project:

```sh
cd ios-native
swift test --package-path Policy
xcodegen generate
xcodebuild test -project Merrymen.xcodeproj -scheme Merrymen \
  -destination 'platform=iOS Simulator,name=iPhone 16,OS=18.5' \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- DEVELOPMENT_TEAM=
```

Simulator ad-hoc signing enables Keychain tests without an Apple account. `.github/workflows/ios-native.yml` records build, test and screenshot evidence. Generated projects, build products and downloaded review evidence are ignored.

From the repository root, verify the shared bundles:

```sh
npm ci --ignore-scripts
node ios-native/Signing/build.mjs --check
node ios-native/Branding/generate.mjs --check
node ios-native/Signing/verify-engine.mjs
node ios-native/Signing/verify-engine.mjs --trencher
node ios-native/Signing/verify-engine.mjs --legacy
node ios-native/Signing/verify-crypto.mjs
node ios-native/Signing/verify-feed.mjs
node ios-native/Signing/export-copy.mjs --check
```

After shared-source changes, regenerate with `node ios-native/Signing/build.mjs`, inspect the diff and rerun those checks. `Signing/sources.json` pins normalized hashes of source inputs, dependency lockfile, runtime and generated bundles. The bundles run static JavaScriptCore computations; they cannot download or evaluate new code. SwiftUI draws every product screen. Swift hosts allowlisted networking, secure storage and explicit signing requests.

## Configuration still needed

- Public Privy App ID: `cmtnun9wn00rg0dl5txyoxpju` (configured).
- Public **iOS Client ID**: missing from the authorized environment. Register the iOS client for **`dev.merrymen.app`**, callback scheme **`merrymen`**, and set `PRIVY_CLIENT_ID` in build settings.
- Public **Reown Project ID**: set `WALLETCONNECT_PROJECT_ID` for automatic native wallet-app connections. Register the callback `merrymen://walletconnect`; only ownership-message signing is requested.
- Apple Developer Team: set `DEVELOPMENT_TEAM` for device builds and configure provisioning for this bundle ID.

Do not add app secrets, server keys, wallet private keys, signing certificates or production database credentials. Missing client configuration explicitly disables Privy sign-in. Email/X callbacks and returning identities still need acceptance once the client exists.

## Implemented in source

- Five native tabs, menus, search, shared coin-first Buying/Held market views, token charts, watchlist, portfolio, leaderboard, public profiles, Alpha and proposals. The current striped logo is rendered from the web/site vector source for the icon, header, feed tab and onboarding; a source/hash check detects drift.
- Shared web feed grouping/filtering, real/paper and execution labels, verified mentions, natural thesis text, following/likes/sharing. Unknown counts remain unknown.
- Profile holdings, fills, top trades, average hold, published strategy and evidenced chart windows. Owner portfolio details preserve cost provenance and receipts; daily real usage excludes paper fills. Private-book dollar figures stay hidden.
- Privy email/X integration; native Reown wallet-app connection and challenge/signature sign-in, with a manual signature fallback; holder proof/link/unlink; Keychain sessions; owner-bound mutations; sign-out and privacy cover.
- Streaming chat with per-owner text history, canonical command reviews and setting prefills, coin resolution and editable on-device voice drafts. Suggestions are cleared on the next message or use and are never restored as actions.
- Group chat with history, replies, take-back, stable retry IDs, presence, mute, time zone and sleep preferences.
- Account/AI/token/risk/discovery/Trencher settings, Telegram bot connection/test, Circle, profile uploads and X proof.
- Permission creation/renewal calls the canonical web Kernel/ZeroDev preparation code with a native signature host. Presets, caps, live consent, ownership, adapter/factory evidence and existing custody are checked before signing.
- Deposit QR/balances, stand-down, owner-key/JSON-backup import, account derivation, legacy permission restoration with separate login-wallet authorization, recovery planning and withdrawal confirmation. Imported owner keys remain in a capability-free local cryptography context and are not uploaded or persisted. A durable operation journal prevents replay while a result is unknown. The current recovery path covers the smart account and selected Class vault; **Trencher vault assets are excluded**.
- All 26 tour topics with versioned per-account persistence/retry. Eleven web catalogue languages and translated native navigation/common controls are bundled; untranslated product copy uses the same English fallback as the web.

## Verification boundary

The Native iOS workflow tests the shipped source on Linux and macOS, runs native app/UI tests on iPhone, checks Spanish navigation and large text recovery on iPad, and creates an unsigned Release archive. Each run identifies the exact tested commit and publishes screenshots, test results, a simulator app and the unsigned device archive. Only a successful run for the PR's current revision establishes these checks.

Fixtures exercise complete standard, Trencher and legacy grant preparation, identity binding and read-only recovery with deterministic test keys and recorded public chain responses. They do **not** prove production Privy callbacks, real grants, fills, withdrawal, device microphone behavior or App Store readiness. No live financial operation was performed.

Native authentication/signing/recovery still need controlled device acceptance after client configuration. The shared backend does not relay Trencher-vault recovery; the native app reports those balances separately and never implies they were withdrawn. Full VoiceOver, final device appearance, privacy disclosures and TestFlight acceptance remain release checks. Keep PR #165 draft until [RELEASE.md](RELEASE.md) is satisfied.
