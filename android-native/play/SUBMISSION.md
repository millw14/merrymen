# Google Play submission record

Prepared on 2026-10-09 for the native Android client, package
`dev.merrymen.app`. This is a draft submission pack, not a statement that the
app is approved or publicly available. See [../RELEASING.md](../RELEASING.md)
for build, signing and device validation.

## Console status

The Play account is a Personal account. The Merrymen app entry
(`4972707436414086495`) uses package `dev.merrymen.app`, English (US), App,
and Free. On 2026-10-16, internal-testing draft release `1` on track
`4701451895307323530` was updated to **0.4.0 (code 4)**. Google accepted the
signed AAB with its embedded ReTrace mapping, minimum API 26 and target API 36.
The older code-3 bundle was removed from this draft and remains in the artifact
library. The release name and English notes were saved; Console confirmed
**Changes saved**. The first internal tester list is selected. Release preview reports zero errors and one warning for missing native debug
symbols from bundled native libraries; ReTrace mapping is attached. The
**Save and publish** action is enabled, but has not been used. No active Play
install link has been confirmed.

Rollout is held for the required Organization-account conversion. Google's
[internal-testing guidance](https://support.google.com/googleplay/android-developer/answer/9845334)
allows incomplete app setup but does not document an exception to the separate
financial-services account-type requirement. An enabled publish action does not
establish such an exception. This is the release decision during the pending
conversion, not a claim that Console technically disables internal publishing.

Google's [Play Console requirements](https://support.google.com/googleplay/android-developer/answer/10788890)
require financial-services developers to register as an Organization. The
owner must provide the actual business identity, verification and D-U-N-S
details. Google documents [converting a Personal account](https://support.google.com/googleplay/android-developer/answer/16260648).
Do not create a different business identity or classify trading as a
non-financial app to work around this requirement.

On 2026-10-16, the owner supplied completed registration details for BELLYACHE LTD
(RC 9927050) and D-U-N-S 352298383. These are owner-provided details; organization
conversion and Google's verification have not yet been confirmed. The actual
incorporation document, registered address and authorized representative evidence
must match the selected payments and D&B profiles.

The live Console on 2026-10-16 shows an earlier payments-profile change awaiting
identity verification. **Change account type** and **Update details** are disabled
until that check completes. The current profile is still Personal, with a US
payments country; do not infer the company's country or address from that profile.
The owner must finish the pending identity check and provide the official company
registered address before organization conversion can continue. The owner supplied
`https://bellyache.tech` as the company website and Abuja, FCT, Nigeria as its
location. Use Nigeria for the company country; obtain the full registered street
address/postal code if the D-U-N-S lookup does not populate it. Website ownership
verification has not been confirmed. The owner supplied the first internal tester
address privately; it is saved in the selected `Merrymen internal testers` list
and Console marks **Select testers** complete. Additional testers will follow.
Tester addresses belong in Console, not in source control.

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

1. **Build and signing:** 0.4.0 (code 4), built from `5b2331f8`, passes all
   692 JVM tests (none skipped), release lint (no errors, 35 warnings and 3 hints),
   debug assembly, SDK dependency metadata generation and all nine release guards.
   Signed, minified APK/AAB builds succeeded. The certificate matches the existing
   upload key, held outside source control with its password in macOS Keychain;
   the APK signature and all 109 AAB payload signatures verify. APK 16KB ZIP
   alignment, all eight native ELF libraries and AAB 16KB configuration pass
   structural checks; a 16KB runtime device has not been tested.
   API 36 emulator checks use Android test tools explicitly authorized by the
   owner. Device testing found and fixed a zero-height WebView CSS viewport that
   hid the hosted email sign-in sheet, bottom system-bar overlap and clipped
   navigation labels at 320dp with 2× text. The corrected debug build displays
   the email sheet above the keyboard and all five full tab labels. Those fixes
   have also been confirmed on the exact signed APK. Authenticated owner flows
   remain outstanding; final device evidence is in `DEVICE-CHECKS.txt`.
   Certificate, source commit and artifact hashes are recorded in the local
   release folder's `README.txt` and `SHA256SUMS.txt`. An off-device key backup
   and authenticated owner-flow checks remain outstanding.
   Exact APK SHA-256:
   `d8ce308088622cc7b2a7ad7dc8be535b5e73ef506af92ba5106a962abe19265c`.
   Exact uploaded AAB SHA-256:
   `95f257bee2830196afb0c4f6c7422fc3183dfff512a3bfd6fd7fc45fe2f68916`.
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

## Observed server performance limit

On 2026-10-16, the unauthenticated IRIDIUS token-detail request
(`/api/tokens/0x28e3c0c404088f1a5d739221072ddf6ab4431022?window=1h&activity=1`)
completed in 4.19 seconds, then an identical request exceeded a 45-second limit
without returning response bytes. Discoveries returned in 1.44 seconds during
the stall. A request without activity also took 21.61 seconds. This reproduces
the device's intermittent timeout outside Android. The existing backend waits
for serial pool-cache refreshes and sequential database reads; identifying the
exact stalled stage needs server timing evidence. The Android read timeout
remains 30 seconds with visible retry feedback. Local release evidence is in
`SERVER-PERFORMANCE.txt`; no backend change was deployed during this preparation.

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
