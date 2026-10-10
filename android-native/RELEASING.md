# Android release

Build the native hosted client in this directory. Its Play package is
`dev.merrymen.app`; the debug package adds `.debug`. Do not substitute the Expo
project in `mobile/`, which uses the same package name but a different client.

## Build requirements

- JDK 17, Android SDK platform 36, and build-tools 35.0.0.
- The committed Gradle 9.3.1 wrapper, AGP 8.13.1 and Kotlin 2.2.20.
- Version 0.3.0, code 3. Before an upload, check Play Console for the highest
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

Do not publish until the Console's account verification, app access, privacy,
data safety, deletion, content rating, audience, financial features and any
testing requirements are complete and accurate. Listing screenshots must come
from the build being tested. A successful AAB build is not evidence that Google
has approved distribution or that the app is live.
