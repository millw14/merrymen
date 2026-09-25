# Native iOS release handoff

The source, simulator checks and unsigned archive can be built without an Apple account. A signed app and authenticated device acceptance require the public identifiers below. PR #165 stays draft until those checks are complete.

## Public configuration

1. In Privy, create the native iOS client for bundle **`dev.merrymen.app`**, callback scheme **`merrymen`**. Set its public `PRIVY_CLIENT_ID`; the public App ID is already configured. Enable the intended email and X login methods in that app.
2. In Reown, create or select Merrymen's project and set public `WALLETCONNECT_PROJECT_ID`. The app's native callback is **`merrymen://walletconnect`**. The connection requests only `personal_sign` for ownership proofs; agent trading uses the separately reviewed permission flow.
3. On a Mac, sign in to Xcode with the Apple Developer account and set `DEVELOPMENT_TEAM`. Use automatic provisioning for `dev.merrymen.app`. Confirm the wallet SDK's Keychain group resolves to the signed app identifier.

Set these in `project.yml` or pass build-setting overrides to Xcode. Never commit signing keys, certificates, wallet keys or service secrets. Public App/Client/Project IDs are not secrets. Regenerate with `xcodegen generate` after project changes.

## Build artifacts

The **Native iOS** workflow publishes:

- `native-ios-builds`: a zipped simulator `.app` and unsigned Release `.xcarchive`.
- `native-ios-screenshots`: iPhone and iPad screenshots, including Spanish and large-text recovery.
- `native-ios-test-evidence`: build logs and `.xcresult` test bundles.

The unsigned archive proves compilation and packaging for devices. It is not an installable IPA and cannot be uploaded to TestFlight without signing/provisioning. Build a fresh signed archive after supplying configuration:

```sh
cd ios-native
xcodegen generate
xcodebuild archive -project Merrymen.xcodeproj -scheme Merrymen \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath Merrymen.xcarchive DEVELOPMENT_TEAM=YOUR_TEAM \
  PRIVY_CLIENT_ID=YOUR_PUBLIC_CLIENT_ID WALLETCONNECT_PROJECT_ID=YOUR_PUBLIC_PROJECT_ID
```

Open the archive in Xcode Organizer, validate it and use Apple's distribution flow. Configure App Store Connect screenshots, support/privacy URLs and data disclosures from the actual app and SDK behavior. The bundled privacy manifest does not replace App Store privacy disclosures. Review encryption/export declarations for the shipped wallet cryptography before submission.

## Acceptance on controlled test accounts

- Email and X: fresh login, return login, background callback, expiration, sign-out and switching owners. Previous-owner content and pending proposals must disappear.
- External wallet: connect, cancel, sign, reject, switch accounts/networks and disconnect. A mismatched or stale proof must never authenticate another owner.
- Agent: settings, creation/renewal, paper/live consent and caps; independently verify server ownership and grant acceptance. A locally signed grant alone is not server activation.
- Recovery: use a disposable legacy backup to verify the derived account, wrong-key rejection, signed-out reads and dual-signature restoration. Confirm owner keys never appear in network logs or saved grants.
- Orders/withdrawals: use an explicitly approved controlled funding amount. Verify receipts and on-chain state, cancellation, app termination and timeout reconciliation without resubmission. No such financial operation has been performed by this task.
- Feed/profile/Alpha/chat: signed-in follows, likes, uploads, X proof, private-book isolation, group replies/retries and actual streamed responses. Test denied/expired sessions and offline retry behavior.
- iPhone/iPad: VoiceOver, largest text sizes, long addresses, keyboard dismissal, rotation and actual on-device voice in supported languages. Check the current striped logo and selected language; untranslated copy intentionally falls back to English as on the web.

## Shared backend limitation

The current recovery relay supports the smart account and selected Class vault. It does not accept Trencher-vault recovery calls. The app displays separate Trencher balances and blocks restoration that would drop funded Trencher custody. Do not describe an account withdrawal as emptying that vault. A future backend change needs its own contract/relay review and acceptance.
