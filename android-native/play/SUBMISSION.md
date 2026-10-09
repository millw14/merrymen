# Google Play submission record

Prepared on 2026-10-09 for the native Android client, package
`dev.merrymen.app`. This is a draft submission pack, not a statement that the
app is approved or publicly available. See [../RELEASING.md](../RELEASING.md)
for build, signing and device validation.

## Console status

The inspected Play account is a Personal account. Merrymen had no existing
app entry. The Create app form was prepared with Merrymen, English (US),
`dev.merrymen.app`, App, and Free. No policy/export declaration was accepted
and no app was created. Confirm the live Console state before resuming.

Google's [Play Console requirements](https://support.google.com/googleplay/android-developer/answer/10788890)
require financial-services developers to register as an Organization. The
owner must provide the actual business identity, verification and D-U-N-S
details. Google documents [converting a Personal account](https://support.google.com/googleplay/android-developer/answer/16260648).
Do not create a different business identity or classify trading as a
non-financial app to work around this requirement.

The business evidence supplied so far is a CAC name-reservation approval only.
The owner confirmed incorporation has not yet been completed. Complete CAC
registration and obtain the incorporation certificate/RC number before using
the company as a verified legal organization; the reservation code is not an
RC number or a D-U-N-S number. See [CAC's registration steps](https://www.cac.gov.ng/services/company-registration).

## Store assets and description

- `listing.en-US.txt` contains reviewable listing copy and known public contact
  links. It makes no profit or availability promise.
- `assets/icon.svg` and its 512 × 512 PNG reproduce the native launcher art.
- `assets/feature-graphic.svg` and its 1024 × 500 PNG contain brand artwork,
  not simulated app screenshots.
- Capture real phone screenshots from the tested build before submitting.
  Do not present fixture balances, fabricated trades or a web desktop screen
  as screenshots of the released Android app.

## Required evidence before public submission

1. **Build and signing:** the SDK license has been accepted and API 36 build
   tools installed. A dedicated upload key was generated outside source control
   with its password in macOS Keychain. All 657 JVM tests passed; release lint
   completed with no errors (35 warnings and 2 hints). Signed, minified APK/AAB
   builds succeeded and the APK certificate matches the upload key. The APK
   installed on an API 36 emulator. Interactive device validation is still
   pending: this host's computer-use surface did not expose the emulator window.
   Complete final certificate/commit/hash recording, an off-device key backup,
   and actual device checks before uploading.
2. **Privacy:** verify the published policy describes the current hosted
   service and Android/WebView behavior. The inspected published policy is
   older than the repository and contains stale claims about memory being
   discarded by redeployment. Correct those against the current service;
   do not merely change the policy date.
3. **Account deletion:** test the in-app request entry and public instructions
   end to end. The existing support process requires identity verification;
   stopping an agent or removing a trading grant is not account deletion.
4. **AI reporting:** implement an in-app way to report offensive generated
   content and ensure reports reach a moderation process. No such endpoint or
   native control was found during this preparation.
5. **Public user content:** add report-content, report-user and block-user
   controls with actual handling. Group chat's existing mute stops the owner's
   agent; it does not block another user. Review other public content surfaces
   too. Do not describe those controls as present until tested.
6. **Reviewer access:** provide a dedicated non-funded review account and
   usable sign-in instructions. Guest browsing is insufficient to review
   authenticated chat/settings. Do not share an owner's financial account or
   weaken authentication to admit a reviewer.
7. **Declarations:** confirm supported countries and actual financial features
   with the owner, then complete content rating, audience, advertising,
   app access, financial features and Data Safety accurately. The service is
   18+ under its Terms; the content rating still comes from the questionnaire.
8. **Distribution:** complete any testing/verification gates shown by the
   selected account. Public availability depends on Google's review, not only
   a successful upload. Internal testing is a separate release state.

Changes to hosted reporting, data handling or published policy need their own
reviewed PR and approved deployment plan. This Android preparation does not
authorize a production deployment or a Postgres mutation.

## Data Safety evidence to verify

This table is a worksheet, not a completed declaration. Include collection
through the app's controlled WebView and its SDK/service providers.

| Candidate category | Evidence and remaining check |
| --- | --- |
| Personal info | Privy sign-in identity, optional name, email and user/account IDs; verify each login method and provider. |
| Financial info | Account balances, positions, trade and transaction history, deposits/withdrawals and receipts. |
| Messages | Agent chat, public room messages and optional connected Telegram messages. |
| Photos | Optional uploaded avatars and banners; verify retention and all recipients. |
| Other user-generated content | Agent/profile settings, research notes and public posts. |
| App activity, diagnostics, device/other IDs | Verify hosting, security/authentication logs and SDK behavior; do not infer category or purpose solely from IP logging. |

Known purposes include app functionality, account management and security.
Classify required versus optional collection per feature. Verify encryption in
transit and deletion handling. Determine which recipients meet Google's
service-provider or user-directed-sharing exceptions before answering the
separate sharing questions. Do not declare that no data is collected.

Financial features are present. The
[crypto-wallet policy](https://support.google.com/googleplay/android-developer/answer/16329703)
excludes non-custodial wallets from that particular policy; that statement
alone does not classify Merrymen's hosted trading service or determine its
permitted distribution countries.

## Official references

- [Target API requirements](https://developer.android.com/google/play/requirements/target-sdk)
- [Account deletion](https://support.google.com/googleplay/android-developer/answer/13327111)
- [AI-generated content reporting](https://support.google.com/googleplay/android-developer/answer/13985936)
- [User-generated content](https://support.google.com/googleplay/android-developer/answer/9876937)
- [Data Safety definitions](https://support.google.com/googleplay/android-developer/answer/10787469)
- [Financial features declaration](https://support.google.com/googleplay/android-developer/answer/13849271)
- [Personal-account testing requirements](https://support.google.com/googleplay/android-developer/answer/14151465)
