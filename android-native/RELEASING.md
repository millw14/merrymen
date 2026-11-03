# Android release

Build the native hosted client in this directory. Its Play package is
`dev.merrymen.app`; the debug package adds `.debug`. Do not substitute the Expo
project in `mobile/`, which uses the same package name but a different client.

## Build requirements

- JDK 17, Android SDK platform 36, and build-tools 35.0.0.
- The committed Gradle 9.3.1 wrapper, AGP 8.13.1 and Kotlin 2.2.20.
- Release candidate version 0.4.2, code 6. Before an upload, check Play Console for the highest
  version code already used; every new upload must use a higher code.

[AGP 8.13 supports API 36.1 and requires at least Gradle 8.13/JDK 17](https://developer.android.com/build/releases/agp-8-13-0-release-notes).
Keep the existing wrapper rather than relying on a globally installed Gradle.

From `android-native/`, with `JAVA_HOME` and `ANDROID_HOME` set:

```sh
./gradlew --no-daemon --max-workers=2 testDebugUnitTest lintRelease assembleDebug sdkReleaseDependencyData
./scripts/test-release-guards.sh
```

The guard script exercises the real Gradle configuration and packaging-task
wiring without creating a signing key or compiling an app. It clears inherited
signing inputs in its own process and uses only non-secret test values.
The Android GitHub workflow runs these checks for Android changes on pull
requests and `main`; it has no upload credentials and does not publish builds.
SDK dependency metadata is included for Play's dependency checks, and its
generation is validated without a signing key.

Debug builds use `https://app.merrymen.dev` by default. An override such as
`-Pmerrymen.origin=http://10.0.2.2:3100` is accepted only as an origin, without
credentials, a page, a query or a fragment. Plain HTTP is limited to localhost
and the emulator host. Release packaging requires HTTPS and refuses those
development hosts.

## Upload signing

First check the app's **App integrity** page in Play Console. If this package
already exists, use its registered upload key; creating a different key does
not make an update valid. Keep the keystore and its recovery backup outside the
repository. Google Play App Signing and the upload key have different roles.

Supply these environment variables through your local secret manager or CI's
protected secrets, without writing passwords into shell history:

| Variable | Value |
| --- | --- |
| `MERRYMEN_ANDROID_KEYSTORE` | Absolute path to the upload keystore |
| `MERRYMEN_ANDROID_STORE_PASSWORD` | Keystore password |
| `MERRYMEN_ANDROID_KEY_ALIAS` | Upload key alias |
| `MERRYMEN_ANDROID_KEY_PASSWORD` | Upload key password |

All four may be absent for development and lint/tests. A partial configuration
fails immediately. Release packaging fails if all are absent or the keystore
is unreadable. The build never falls back to the Android debug signing key.
Do not use build scans or verbose diagnostic logs on a machine holding release
credentials, and do not commit keystores, passwords or local Gradle properties.

```sh
./gradlew --no-daemon --max-workers=2 :app:validatePlayRelease
./gradlew --no-daemon --max-workers=2 bundleRelease
```

Upload artifact: `app/build/outputs/bundle/release/app-release.aab`.
Retain its SHA-256, source commit and `app/build/outputs/mapping/release/mapping.txt`
with the release record. Verify its signer matches the Play upload certificate:

```sh
"$JAVA_HOME/bin/jarsigner" -verify app/build/outputs/bundle/release/app-release.aab
"$JAVA_HOME/bin/keytool" -printcert -jarfile app/build/outputs/bundle/release/app-release.aab
shasum -a 256 app/build/outputs/bundle/release/app-release.aab
```

## Device and Play checks

The Android chat's settings-change action opens the authenticated web Settings
panel for the owner to describe, review and approve the change. This release
does not prefill a settings proposal or automatically apply suggested changes.

API 36 changes [edge-to-edge layout, back navigation and large-screen behavior](https://developer.android.com/about/versions/16/behavior-changes-16).
Before releasing, check navigation/insets with gesture and three-button
navigation on an Android 16 phone and a large-screen device. Also cover an
older supported Android version. Test the minified release through Play's
internal testing track, including public browsing, sign-in/sign-out, account
switching, legal/support links, photos and the WebView handoff. Real-money
transactions are not required for this validation.

Open **Continue with email** and check that the email sheet and input are visible
both before and after the keyboard opens. `WebFlow` must give every WebView
`MATCH_PARENT` layout parameters before attachment: Chromium treats
`WRAP_CONTENT` height as a zero CSS viewport even when Compose measures a
nonzero view, hiding the hosted sign-in sheet. Also check all five complete tab
labels on a 320dp-wide display with font scale 2.0, then restore device settings.

Do not publish until the Console's account verification, app access, privacy,
data safety, deletion, content rating, audience, financial features and any
testing requirements are complete and accurate. Listing screenshots must come
from the build being tested. A successful AAB build is not evidence that Google
has approved distribution or that the app is live.

## 0.4.1 server and sign-in rollout

Deploy the matching web changes before distributing 0.4.1 as the completed speed
fix. The native app remains compatible with older responses, but an older server
still performs the expensive full ranking/profile/feed reads. Test actual public
agents, recent activity and a profile against the deployed routes; an empty state
or a timeout is not a successful data check.

The current mark is the 19 rounded bars from `web/src/terminal/ui.tsx` and
`ui/Logo.kt`, also in `site/public/favicon.svg`. The older feather files in
`web/public/icon-*.png` are not the current brand. The Android adaptive foreground
uses the current geometry within the safe area. Store artwork uses that same mark.

External X authorization stays disabled until all of these are true:

1. `/auth/android`, `/api/auth/android` and `/.well-known/assetlinks.json` are
   deployed at `https://app.merrymen.dev`.
2. Digital Asset Links lists both the Google Play **app signing** certificate and
   the existing GitHub APK/upload certificate. Verify their fingerprints in Play
   Console and against the signed APK; never replace either with a debug key.
3. Privy allows the canonical origin and the `/auth/android` redirect. On
   2026-10-16 its redirect list was empty (all allowed-origin paths permitted),
   so no dashboard mutation was needed. Recheck before enabling; do not narrow
   redirects in a way that breaks web or iOS sign-in.
4. Set `MERRYMEN_ANDROID_OAUTH_ENABLED=1` only after that deployment and association
   check. Native code independently requires OS verification of the App Link.
5. On a physical device, finish X approval and verify return to Merrymen, correct
   owner identity and a normal signed-in screen. Repeat with no X app installed,
   cancel/retry, rotation, process death and email fallback. Installed X app
   handling depends on X and Android; browser authorization remains supported.

The returned code/state/provider is short lived and accepted once for the pending
flow only. It is never a native session or wallet credential. Do not log OAuth
query values, cookies, tokens, signing secrets or private keys.

Keep 0.4.0 assets intact. 0.4.1 uses the same GitHub signing certificate and can
upgrade 0.4.0 in place. Google Play signs its delivered APKs with its own key, so
GitHub and Play installations are separate distribution paths.
